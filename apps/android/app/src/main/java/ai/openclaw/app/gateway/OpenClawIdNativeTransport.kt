package ai.openclaw.app.gateway

import ai.openclaw.iroh.CancelToken
import ai.openclaw.iroh.CloseKind
import ai.openclaw.iroh.Connection
import ai.openclaw.iroh.Endpoint
import ai.openclaw.iroh.RecvStream
import ai.openclaw.iroh.SendStream
import ai.openclaw.iroh.bind
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlin.coroutines.coroutineContext

/** The generated UniFFI wrapper is the sole native transport; it never dials a hostname as TCP. */
internal class OpenClawIdNativeTransport private constructor(
  private val endpoint: Endpoint,
  private val relayUrl: String,
) : OpenClawIdEndpoint {
  private val watcherJob = SupervisorJob()

  @Volatile private var status = OpenClawIdRelayStatus(connected = false, admissionDenied = false)

  init {
    CoroutineScope(Dispatchers.IO + watcherJob).launch {
      try {
        val watcher = awaitOpenClawIdNative(cancel = {}, discard = { it.close() }) { endpoint.watchHomeRelay() }
        try {
          while (true) {
            // shutdown() closes the endpoint before cancelling this observer, so next always drains.
            val relays = withContext(NonCancellable) { watcher.next() } ?: break
            status = OpenClawIdRelayStatus(relays.any { it.connected }, relays.any { it.authDeniedReason != null })
          }
        } finally {
          watcher.close()
        }
      } catch (error: CancellationException) {
        throw error
      } catch (_: Exception) {
        // A diagnostic watcher failure must not escape as an unhandled app coroutine exception.
        status = status.copy(connected = false)
      }
    }
  }

  override fun relayStatus(): OpenClawIdRelayStatus = status

  override suspend fun connect(serverKey: String): OpenClawIdConnection {
    // Pin verification belongs to the tunnel owner. No discovery or direct-address hints are added.
    val cancel = CancelToken()
    try {
      return awaitOpenClawIdNative(
        cancel = { cancel.cancel() },
        discard = {
          it.close(0, byteArrayOf())
          it.close()
        },
      ) {
        endpoint.connect(serverKey, "openclaw/tunnel/1".toByteArray(Charsets.UTF_8), relayUrl, emptyList(), cancel)
      }.let(::OpenClawIdNativeConnection)
    } finally {
      cancel.close()
    }
  }

  override suspend fun shutdown() {
    withContext(NonCancellable) {
      try {
        endpoint.shutdown()
      } finally {
        watcherJob.cancelAndJoin()
        endpoint.close()
      }
    }
  }

  companion object {
    /** Application initialization must install the native Android context before this call. */
    suspend fun bindNode(
      seed: ByteArray,
      relayUrl: String,
    ): OpenClawIdEndpoint {
      val native =
        try {
          awaitOpenClawIdNative(
            cancel = {},
            discard = {
              try {
                it.shutdown()
              } finally {
                it.close()
              }
            },
          ) { bind(seed, relayUrl, emptyList(), false, 1_000u) }
        } finally {
          seed.fill(0)
        }
      try {
        coroutineContext.ensureActive()
        return OpenClawIdNativeTransport(native, relayUrl)
      } catch (error: Throwable) {
        withContext(NonCancellable) {
          try {
            native.shutdown()
          } finally {
            native.close()
          }
        }
        throw error
      }
    }
  }
}

internal class OpenClawIdNativeConnection(
  private val native: Connection,
) : OpenClawIdConnection {
  // Observers cancel their own awaits, not the generated future containing an owned RustBuffer.
  private val terminal = CoroutineScope(Dispatchers.IO).async(start = CoroutineStart.LAZY) { native.closed() }

  override suspend fun openBi(): OpenClawIdBiStream {
    val stream =
      awaitOpenClawIdNative(
        // A node has one application WebSocket. Cancelling its stream admission retires the
        // connection, unblocking openBi without orphaning its lowered stream handles.
        cancel = { native.close(0, byteArrayOf()) },
        discard = { it.destroy() },
      ) { native.openBi() }
    try {
      coroutineContext.ensureActive()
      return OpenClawIdBiStream(OpenClawIdNativeSend(stream.send), OpenClawIdNativeReceive(stream.recv))
    } catch (error: Throwable) {
      // Dropping unpublished halves resets/stops them in Rust without waiting for any I/O.
      stream.destroy()
      throw error
    }
  }

  override suspend fun closed(): OpenClawIdClose {
    val close = terminal.await()
    return when (close.kind) {
      CloseKind.APPLICATION -> OpenClawIdClose.Application(checkNotNull(close.code))
      CloseKind.LOCALLY_CLOSED -> OpenClawIdClose.Local
      CloseKind.TIMED_OUT -> OpenClawIdClose.Timeout
      CloseKind.RESET, CloseKind.TRANSPORT -> OpenClawIdClose.Transport
    }
  }

  // An admission waiter can be cancelled while a later waiter still needs the same close reason.
  // Keep the handle usable for those observers; UniFFI's cleaner releases it after their last reference.
  override fun close(code: Long) = native.close(code, byteArrayOf())
}

private class OpenClawIdNativeSend(
  private val native: SendStream,
) : OpenClawIdSendStream {
  override suspend fun writeAll(bytes: ByteArray) = awaitOpenClawIdNative(cancel = { native.reset(OpenClawIdFrames.BAD_REQUEST) }) { native.write(bytes) }

  override suspend fun finish() {
    awaitOpenClawIdNative(cancel = { native.reset(OpenClawIdFrames.BAD_REQUEST) }) { native.finish() }
    native.close()
  }

  override suspend fun reset(code: Long) {
    try {
      withContext(NonCancellable) { native.reset(code) }
    } finally {
      native.close()
    }
  }
}

private class OpenClawIdNativeReceive(
  private val native: RecvStream,
) : OpenClawIdReceiveStream {
  override suspend fun read(maxBytes: Int): ByteArray? {
    require(maxBytes in 1..1_048_576)
    // StreamReset/StreamStopped remain typed failures, never EOF or reason-text classification.
    return awaitOpenClawIdNative(cancel = { native.stop(OpenClawIdFrames.BAD_REQUEST) }) { native.read(maxBytes.toUInt()) }
  }

  override suspend fun stop(code: Long) {
    try {
      withContext(NonCancellable) { native.stop(code) }
    } finally {
      native.close()
    }
  }
}
