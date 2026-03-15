package ai.openclaw.android.gateway

/**
 * Shared constants and data models for the Wear ↔ Phone proxy protocol
 * over the Wearable Data Layer API.
 *
 * Both the phone-side WearProxyService and the watch-side PhoneProxyClient
 * depend on these definitions to keep the schema strictly in sync.
 */
object ProxyPaths {
  /** Watch → Phone: JSON-RPC request. */
  const val RPC = "/openclaw/rpc"

  /** Phone → Watch: JSON-RPC response. */
  const val RPC_RESPONSE = "/openclaw/rpc-response"

  /** Phone → Watch: gateway event forwarding. */
  const val EVENT = "/openclaw/event"

  /** Watch → Phone: liveness ping. */
  const val PING = "/openclaw/ping"

  /** Phone → Watch: liveness pong (with handshake payload). */
  const val PONG = "/openclaw/pong"
}

/**
 * Handshake payload sent inside the PONG response.
 *
 * [ready] indicates whether the phone's gateway session is live.
 * [statusText] provides a human-readable status when not ready.
 */
data class ProxyHandshakePayload(
  val ready: Boolean,
  val statusText: String?,
)

/**
 * RPC request payload sent from watch to phone over [ProxyPaths.RPC].
 */
data class ProxyRpcPayload(
  val id: String,
  val method: String,
  val paramsJson: String?,
)

/**
 * RPC response payload sent from phone to watch over [ProxyPaths.RPC_RESPONSE].
 */
data class ProxyRpcResponsePayload(
  val id: String,
  val ok: Boolean,
  val payloadJson: String?,
  val errorCode: String?,
  val errorMessage: String?,
)

/**
 * Event payload sent from phone to watch over [ProxyPaths.EVENT].
 */
data class ProxyEventPayload(
  val event: String,
  val payloadJson: String?,
)
