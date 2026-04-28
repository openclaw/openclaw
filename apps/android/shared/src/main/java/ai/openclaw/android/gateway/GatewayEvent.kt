package ai.openclaw.android.gateway

/**
 * Gateway event payload shared by the watch and phone clients.
 */
data class GatewayEvent(val event: String, val payloadJson: String?)
