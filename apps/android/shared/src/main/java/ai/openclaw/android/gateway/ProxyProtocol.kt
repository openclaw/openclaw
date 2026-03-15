package ai.openclaw.android.gateway

/**
 * Shared constants and data models for the Wear ↔ Phone proxy protocol
 * over the Wearable Data Layer API.
 *
 * Both the phone-side WearProxyService and the watch-side PhoneProxyClient
 * depend on these definitions to keep the schema strictly in sync.
 *
 * **Serialization note:** these data classes are serialized/deserialized
 * manually via [buildJsonObject] / [parseJsonOrNull] in each consumer.
 * They intentionally do **not** carry `@Serializable` annotations.
 */
object ProxyPaths {
  /** Common path prefix for all proxy messages. */
  const val PREFIX = "/openclaw"

  /** Watch → Phone: JSON-RPC request. */
  const val RPC = "$PREFIX/rpc"

  /** Phone → Watch: JSON-RPC response. */
  const val RPC_RESPONSE = "$PREFIX/rpc-response"

  /** Phone → Watch: gateway event forwarding. */
  const val EVENT = "$PREFIX/event"

  /** Watch → Phone: liveness ping. */
  const val PING = "$PREFIX/ping"

  /** Phone → Watch: liveness pong (with handshake payload). */
  const val PONG = "$PREFIX/pong"
}

/**
 * Handshake payload sent inside the PONG response.
 *
 * [ready] indicates whether the phone's gateway session is live.
 * [statusText] provides a human-readable status when not ready.
 *
 * Serialized manually — not annotated with `@Serializable`.
 */
data class ProxyHandshakePayload(
  val ready: Boolean,
  val statusText: String? = null,
)

/**
 * RPC request payload sent from watch to phone over [ProxyPaths.RPC].
 *
 * Serialized manually — not annotated with `@Serializable`.
 */
data class ProxyRpcPayload(
  val id: String,
  val method: String,
  val paramsJson: String? = null,
)

/**
 * RPC response payload sent from phone to watch over [ProxyPaths.RPC_RESPONSE].
 *
 * Serialized manually — not annotated with `@Serializable`.
 */
data class ProxyRpcResponsePayload(
  val id: String,
  val ok: Boolean,
  val payloadJson: String? = null,
  val errorCode: String? = null,
  val errorMessage: String? = null,
)

/**
 * Event payload sent from phone to watch over [ProxyPaths.EVENT].
 *
 * Serialized manually — not annotated with `@Serializable`.
 */
data class ProxyEventPayload(
  val event: String,
  val payloadJson: String? = null,
)
