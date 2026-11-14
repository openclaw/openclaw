package ai.openclaw.app.gateway

/** App-facing boundary for the shared native binding; no Android or generated FFI types escape. */
internal interface OpenClawIdEndpoint {
  /** Dial only a currently verified K_srv. Cancellation must close a late native result. */
  suspend fun connect(serverKey: String): OpenClawIdConnection

  fun relayStatus(): OpenClawIdRelayStatus

  suspend fun shutdown()
}

internal data class OpenClawIdRelayStatus(
  val connected: Boolean,
  val admissionDenied: Boolean,
)

internal sealed interface OpenClawIdClose {
  data class Application(
    val code: Long,
  ) : OpenClawIdClose

  data object Local : OpenClawIdClose

  data object Timeout : OpenClawIdClose

  data object Transport : OpenClawIdClose
}

internal interface OpenClawIdConnection {
  suspend fun openBi(): OpenClawIdBiStream

  suspend fun closed(): OpenClawIdClose

  fun close(code: Long)
}

internal data class OpenClawIdBiStream(
  val send: OpenClawIdSendStream,
  val receive: OpenClawIdReceiveStream,
)

internal interface OpenClawIdSendStream {
  suspend fun writeAll(bytes: ByteArray)

  suspend fun finish()

  /** Interrupts a pending write before waiting for its lock. */
  suspend fun reset(code: Long)
}

internal interface OpenClawIdReceiveStream {
  /** Returns 1..maxBytes bytes, or null at FIN. Reset is an error, not EOF. */
  suspend fun read(maxBytes: Int): ByteArray?

  /** Interrupts a pending read before waiting for its lock. */
  suspend fun stop(code: Long)
}

internal class OpenClawIdRemovedException : java.io.IOException("OpenClaw ID node access was removed or is not admitted. Re-join this node.")

internal class OpenClawIdTunnelException : java.io.IOException("OpenClaw ID tunnel unavailable")

internal class OpenClawIdProtocolException : java.io.IOException("Invalid OpenClaw ID tunnel frame")
