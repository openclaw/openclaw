package ai.openclaw.wear.gateway

/**
 * Gateway event from the server, shared between the direct WebSocket
 * client and the phone-proxied connection.
 */
data class GatewayEvent(val event: String, val payloadJson: String?)
