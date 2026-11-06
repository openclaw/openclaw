package ai.openclaw.app.gateway

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import okhttp3.Protocol
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import okio.ByteString.Companion.toByteString
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong

/** In-process WS adapter. There is no TCP listener or ordinary-network fallback. */
internal class OpenClawIdWebSocket(
  parentScope: CoroutineScope,
  private val tunnel: OpenClawIdTunnel,
  private val originalRequest: Request,
  private val listener: WebSocketListener,
) : WebSocket {
  private val job = SupervisorJob(parentScope.coroutineContext[Job])
  private val scope = CoroutineScope(parentScope.coroutineContext + job)
  private val terminal = AtomicBoolean(false)
  private val cancelled = AtomicBoolean(false)
  private val closing = AtomicBoolean(false)
  private val queuedBytes = AtomicLong()
  private val outgoing = Channel<ByteArray>(64)
  private val closeWritten = CompletableDeferred<Unit>()
  private val enqueueLock = Any()

  init {
    job.invokeOnCompletion { fail(if (tunnel.removed.value) OpenClawIdRemovedException() else OpenClawIdTunnelException()) }
    scope.launch {
      var stream: OpenClawIdBiStream? = null
      var refusal: Response? = null
      var peerClose: OpenClawIdFrames.Message.Close? = null
      try {
        val connection = tunnel.connection()
        val opened = connection.openBi()
        stream = opened
        val reader = OpenClawIdFrameReader(opened.receive, tunnel::received)
        val response =
          withTimeout(10_000) {
            val path = originalRequest.url.encodedPath + (originalRequest.url.encodedQuery?.let { "?$it" } ?: "")
            opened.send.writeAll(OpenClawIdFrames.encode(OpenClawIdFrames.webSocketHead(path), OpenClawIdFrames.MAX_HEAD_BYTES))
            val head = reader.next(OpenClawIdFrames.MAX_HEAD_BYTES) ?: throw OpenClawIdProtocolException()
            val status = OpenClawIdFrames.responseStatus(head)
            Response
              .Builder()
              .request(originalRequest)
              .protocol(Protocol.HTTP_1_1)
              .code(status)
              .message(if (status == 101) "Switching Protocols" else "Upgrade refused")
              .build()
          }
        if (response.code != 101) {
          refusal = response
          return@launch
        }
        if (cancelled.get()) return@launch
        listener.onOpen(this@OpenClawIdWebSocket, response)
        coroutineScope {
          val writer =
            launch {
              for (payload in outgoing) {
                try {
                  opened.send.writeAll(OpenClawIdFrames.encode(payload))
                } finally {
                  queuedBytes.addAndGet(-payload.size.toLong())
                }
                if (payload[0] == 8.toByte()) {
                  opened.send.finish()
                  closeWritten.complete(Unit)
                  break
                }
              }
            }
          try {
            while (true) {
              val frame = reader.next() ?: throw OpenClawIdTunnelException()
              when (val message = OpenClawIdFrames.message(frame)) {
                is OpenClawIdFrames.Message.Text -> {
                  listener.onMessage(this@OpenClawIdWebSocket, message.text)
                }

                is OpenClawIdFrames.Message.Binary -> {
                  listener.onMessage(this@OpenClawIdWebSocket, message.bytes.toByteString())
                }

                is OpenClawIdFrames.Message.Close -> {
                  // Validate and echo before reporting terminal completion. No peer text enters logs.
                  val close = OpenClawIdFrames.close(message.code, message.reason)
                  if (!closing.get() && !enqueueClose(close)) throw OpenClawIdTunnelException()
                  // Empty close is reported as 1005 by the WebSocket API, but 1005 is never sent on wire.
                  listener.onClosing(this@OpenClawIdWebSocket, message.code ?: 1005, message.reason)
                  withTimeout(5_000) { closeWritten.await() }
                  peerClose = message
                  break
                }
              }
            }
          } finally {
            writer.cancel()
          }
        }
      } catch (error: CancellationException) {
        throw error
      } catch (_: Exception) {
        // Only stable diagnostics reach GatewaySession; raw native/peer errors may contain secrets.
      } finally {
        outgoing.cancel()
        withContext(NonCancellable) {
          stream?.let { opened ->
            val graceful = peerClose != null && closeWritten.isCompleted && !cancelled.get()
            // finish() queues close bytes and FIN; resetting a successful send would discard them.
            // Failed/canceled halves can be blocked independently, so retire those concurrently.
            coroutineScope {
              if (!graceful) launch { runCatching { opened.send.reset(OpenClawIdFrames.BAD_REQUEST) } }
              launch { runCatching { opened.receive.stop(if (graceful) 0L else OpenClawIdFrames.BAD_REQUEST) } }
            }
          }
        }
        val close = peerClose
        if (close != null && !cancelled.get()) {
          if (terminal.compareAndSet(false, true)) listener.onClosed(this@OpenClawIdWebSocket, close.code ?: 1005, close.reason)
        } else {
          fail(if (tunnel.removed.value) OpenClawIdRemovedException() else OpenClawIdTunnelException(), refusal)
        }
        scope.cancel()
      }
    }
  }

  override fun request(): Request = originalRequest

  override fun queueSize(): Long = queuedBytes.get().coerceAtLeast(0)

  override fun send(text: String): Boolean = enqueue(OpenClawIdFrames.text(text))

  override fun send(bytes: ByteString): Boolean = enqueue(OpenClawIdFrames.binary(bytes.toByteArray()))

  private fun enqueue(payload: ByteArray): Boolean =
    synchronized(enqueueLock) {
      if (terminal.get() || cancelled.get() || closing.get()) return false
      if (queuedBytes.get() + payload.size > OpenClawIdFrames.MAX_FRAME_BYTES) return false
      queuedBytes.addAndGet(payload.size.toLong())
      if (outgoing.trySend(payload).isFailure) {
        queuedBytes.addAndGet(-payload.size.toLong())
        return false
      }
      true
    }

  private fun enqueueClose(payload: ByteArray): Boolean =
    synchronized(enqueueLock) {
      if (!enqueue(payload)) return false
      closing.set(true)
      // A peer that never sends a close cannot retain a retired GatewaySession forever.
      scope.launch {
        kotlinx.coroutines.delay(5_000)
        if (!terminal.get()) this@OpenClawIdWebSocket.cancel()
      }
      true
    }

  override fun close(
    code: Int,
    reason: String?,
  ): Boolean =
    synchronized(enqueueLock) {
      if (closing.get() || terminal.get() || cancelled.get()) false else enqueueClose(OpenClawIdFrames.close(code, reason.orEmpty()))
    }

  override fun cancel() {
    cancelled.set(true)
    scope.cancel()
  }

  private fun fail(
    error: Exception,
    response: Response? = null,
  ) {
    if (terminal.compareAndSet(false, true)) listener.onFailure(this, error, response)
  }
}
