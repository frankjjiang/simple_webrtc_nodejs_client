const { RTCPeerConnection } = require("wrtc");

/**
 * Manages the connections and signaling logic between all peers in a meshed network
 *     The negotiation logic, used during the signlaing process, is based on "The perfect negotiation logic".
 *     Reference: https://developer.mozilla.org/en-US/docs/Web/API/WebRTC_API/Perfect_negotiation#the_perfect_negotiation_logic
 *     At "Last modified: Apr 11, 2021"
 * @class WebrtcManager
 */
class WebrtcManager {
    /**
     * Creates an instance of WebrtcManager.
     * @param {string} ourPeerId - The ID assigned to this peer
     * @param {String} ourPeerType - What type of peer this is, this is up to the application. For example peerType can be 'admin', 'vehicle', 'controltower' or 'robot' depending on your application
     * @param {SignalingChannel} signalingChannel - An instance of the signaling channel
     * @param {Object} options - Options of the WebRTC connection.
     * @param {Boolean} verbose - If true the manager will print its status when events occur
     * @memberof WebrtcManager
     */
    constructor(ourPeerId, ourPeerType, signalingChannel, options) {
        this.ourPeerId = ourPeerId;
        this.ourPeerType = ourPeerType;
        this.signalingChannel = signalingChannel;
        this.signalingChannel.onMessage = this.signalingMessageHandler.bind(this); // without bind, this in signalingMessageHandler would refer to the SignalingChannel instad of WebrtcManager
        this.signalingChannel.onDisconnect = this.signalingDisconnectHandler.bind(this);
        this.peers = {};
        this.options = options;
        this.config = {
            iceServers: [
                { urls: "stun:stun.l.google.com:19302" },
                { urls: "stun:stun1.l.google.com:19302" },
                { urls: "stun:stun2.l.google.com:19302" },
            ],
        };
    }
    /**
     * Replaces the onMessage handler of the signaling channel
     *     Takes care of the signaling message exchange.
     *
     * @param {Object} message -  The message from the signaling server
     * @memberof WebrtcManager
     */
    signalingMessageHandler(message) {
        const { from, payload } = message;
        const { action, connections, bePolite, sdp, ice } = payload;
        switch (action) {
            case "open":
                connections.forEach((newPeer) => this.addPeer(newPeer.peerId, newPeer.peerType, bePolite));
                break;
            case "close":
                this.removePeer(this.peers[from]);
                break;
            case "sdp":
                this.verbose ? console.log(`Received ${sdp.type} from ${from}`) : "";
                this.updateSessionDescription(this.peers[from], sdp);
                break;
            case "ice":
                this.updateIceCandidate(this.peers[from], ice);
                break;
            default:
                this.verbose ? console.log(`Received un an unkown action ${action}`) : "";
                break;
        }
    }

    /**
     * Replaces the onDisconnect handler of the signaling channel
     *     Takes care of removing the connections of all registered peers
     *
     * @memberof WebrtcManager
     */
    signalingDisconnectHandler() {
        for (const peerId in this.peers) {
            this.peers[peerId].remove();
        }
    }

    /**
     * Takes care of adding a peer to the connection and all the corresopnding singaling logic.
     *
     * @param {String} peerId - The Id of the peer to be added.
     * @param {Boolean} polite - Wether to be polite during the signaling process.
     * @memberof WebrtcManager
     */
    addPeer(peerId, peerType, polite) {
        if (peerId in this.peers) {
            this.verbose ? console.log("A peer connection with", peerId, "already exists") : "";
        } else {
            // Add peer to the object of peers
            this.peers[peerId] = {
                peerId,
                peerType,
                polite,
                rtcPeerConnection: new RTCPeerConnection(this.config),
                dataChannel: null,
                makingOffer: false,
                ignoreOffer: false,
                isSettingRemoteAnswerPending: false,
            };
            // Define the remove() function
            this.peers[peerId].remove = () => this.removePeer(this.peers[peerId]);
            // Create a data channel if needed
            if (this.options.enableDataChannel) {
                this.peers[peerId].dataChannel = this.peers[peerId].rtcPeerConnection.createDataChannel(`${peerId}Channel`, {
                    negotiated: true, // the application assumes that data channels are created manually on both peers
                    id: 0, // data channels created with the same id are connected to each other across peers
                });
                try {
                    this.options.dataChannelHandler(this.ourPeerId, this.ourPeerType, this.peers[peerId]);
                } catch (error) {
                    console.error(error);
                }
            }
            // Update the negotiation logic of the peer
            this.updateNegotiationLogic(this.peers[peerId]);
        }
    }

    /**
     * Updates the negotiation logic of a new peer.
     *    Makes the onnegotiationneeded event of the RTCPeerConnection trigger an offer generation
     *
     * @param {Object} peer
     * @memberof WebrtcManager
     */
    updateNegotiationLogic(peer) {
        const peerConnection = peer.rtcPeerConnection;
        peerConnection.onicecandidate = ({ candidate }) => this.signalingChannel.sendTo(peer.peerId, { action: "ice", ice: candidate });
        peerConnection.onnegotiationneeded = async () => {
            try {
                // impolite peers is always the one who gives an offer
                if (!peer.polite) {
                    peer.makingOffer = true;
                    const offer = await peerConnection.createOffer();
                    await peerConnection.setLocalDescription(offer);
                    this.verbose ? console.log(`Sending offer to ${peer.peerId}`) : "";
                    this.signalingChannel.sendTo(peer.peerId, { action: "sdp", sdp: peerConnection.localDescription });
                }
            } catch (err) {
                console.error(err);
            } finally {
                peer.makingOffer = false;
            }
        };
        peerConnection.oniceconnectionstatechange = () => {
            if (peerConnection.iceConnectionState === "failed") {
                peerConnection.restartIce();
            }
        };
    }

    /**
     * The logic to update the session description protocol (SDP) during negotiation.
     *
     * @param {Object} peer - The peer object
     * @param {RTCSessionDescriptionInit} description - the SDP from peer
     * @return {*}
     * @memberof WebrtcManager
     */
    async updateSessionDescription(peer, description) {
        try {
            const peerConnection = peer.rtcPeerConnection;
            // if we recived and offer, check if there is an offer collision (ie. we already have created a local offer and tried to send it)
            const offerCollision = description.type === "offer" && (peer.makingOffer || peerConnection.signalingState != "stable");
            peer.ignoreOffer = !peer.polite && offerCollision;

            // Ignore the peer offer if we are impolite and there is an offer collision
            if (peer.ignoreOffer) {
                this.verbose ? console.log("Peer offer was ignore because we are impolite") : "";
                return;
            }

            // Roll back logic for a polite peer that happens to have an offer collision
            // As of now, this logic doesn't function correctly. TO BE IMPROVED
            if (offerCollision) {
                // If there is a collision we need to rollback
                await peerConnection.setLocalDescription({ type: "rollback" }); // not working
                await peerConnection.setRemoteDescription(description); // not working
            } else {
                // Otherwise there are no collision and we can take the offer as our remote description
                await peerConnection.setRemoteDescription(description);
            }

            // When given an offer that we were able to accept, it is time to send back an answer
            if (description.type === "offer") {
                // create answer and send it
                await peerConnection.setLocalDescription(await peerConnection.createAnswer());
                this.verbose ? console.log(`Sending answer to ${peer.peerId}`) : "";
                this.signalingChannel.sendTo(peer.peerId, { action: "sdp", sdp: peerConnection.localDescription });
            }
        } catch (error) {
            console.error(error);
        }
    }
    /**
     * The logic to update the ICE Candidates during negotiation
     *
     * @param {Object} peer - The peer object
     * @param {RTCIceCandidateInit} candidate - The ICE Candidate from peer
     * @memberof WebrtcManager
     */
    async updateIceCandidate(peer, candidate) {
        const peerConnection = peer.rtcPeerConnection;
        try {
            // Only add non null candidate (final candidate is null), this version of wrtc requires non null object, future version will handle null candidates
            candidate && (await peerConnection.addIceCandidate(candidate));
        } catch (error) {
            if (!peer.ignoreOffer) console.log(error);
        }
    }

    /**
     * Closes all connections and removes peer from connection.
     *     Fired when the peer has left the signaling server or when peer.remove() is called.
     * @param {*} peerId
     * @memberof WebrtcManager
     */
    removePeer(peer) {
        if (peer) {
            if (peer.dataChannel) {
                peer.dataChannel.close();
            }
            peer.rtcPeerConnection.close();
            delete this.peers[peer.peerId];
            this.verbose ? console.log(`Connection with ${peer.peerId} has been removed`) : "";
        }
    }
}
module.exports = WebrtcManager;
