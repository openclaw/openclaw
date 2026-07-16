package ai.openclaw.app.wear

import ai.openclaw.wear.shared.WearDecodeResult
import ai.openclaw.wear.shared.WearEventType
import ai.openclaw.wear.shared.WearMessage
import ai.openclaw.wear.shared.WearProtocol
import ai.openclaw.wear.shared.WearProtocolCodec
import ai.openclaw.wear.shared.WearRpcError
import android.content.Context
import com.google.android.gms.tasks.Task
import com.google.android.gms.wearable.Wearable
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.channels.BufferOverflow
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.launch
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.util.concurrent.atomic.AtomicLong
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

internal fun interface WearMessageSender {
  suspend fun send(
    nodeId: String,
    path: String,
    data: ByteArray,
  )
}

internal class GoogleWearMessageSender(
  context: Context,
) : WearMessageSender {
  private val messageClient = Wearable.getMessageClient(context.applicationContext)

  override suspend fun send(
    nodeId: String,
    path: String,
    data: ByteArray,
  ) {
    messageClient.sendMessage(nodeId, path, data).await()
  }
}

internal class WearProxyBridge(
  private val scope: CoroutineScope,
  private val sender: WearMessageSender,
  private val handleRequest: suspend (WearMessage.Request) -> WearMessage.Response,
) {
  private val peerLock = Any()
  private val peers = LinkedHashSet<String>()
  private val sequence = AtomicLong()

  // One bounded consumer preserves event order. DROP_OLDEST becomes a visible sequence
  // gap, so the watch can recover from chat.history instead of applying stale deltas.
  private val events =
    Channel<WearMessage.Event>(
      capacity = MAX_BUFFERED_EVENTS,
      onBufferOverflow = BufferOverflow.DROP_OLDEST,
    )

  init {
    scope.launch {
      for (event in events) sendEvent(event)
    }
  }

  suspend fun handleMessage(
    sourceNodeId: String,
    data: ByteArray,
  ) {
    if (sourceNodeId.isBlank()) return
    val request =
      (WearProtocolCodec.decode(data) as? WearDecodeResult.Success)
        ?.message as? WearMessage.Request ?: return
    rememberPeer(sourceNodeId)
    val response = handleRequest(request)
    val encoded = encodeResponse(response)
    sendToPeer(sourceNodeId, WearProtocol.RESPONSE_PATH, encoded)
  }

  fun publishConnection(
    connected: Boolean,
    status: String,
  ) {
    publishEvent(
      WearEventType.Connection,
      buildJsonObject {
        put("connected", connected)
        put("status", status)
      },
    )
  }

  fun publishChat(payload: JsonElement) {
    projectWearChatEvent(payload)?.let { publishEvent(WearEventType.Chat, it) }
  }

  private fun publishEvent(
    type: WearEventType,
    payload: JsonElement,
  ) {
    if (!hasPeers()) return
    events.trySend(
      WearMessage.Event(
        sequence = sequence.incrementAndGet(),
        event = type,
        payload = payload,
      ),
    )
  }

  private suspend fun sendEvent(event: WearMessage.Event) {
    val encoded = runCatching { WearProtocolCodec.encode(event) }.getOrNull() ?: return
    for (peer in peerSnapshot()) {
      sendToPeer(peer, WearProtocol.EVENT_PATH, encoded)
    }
  }

  private suspend fun sendToPeer(
    peer: String,
    path: String,
    data: ByteArray,
  ) {
    try {
      sender.send(peer, path, data)
    } catch (err: CancellationException) {
      throw err
    } catch (_: Throwable) {
      forgetPeer(peer)
    }
  }

  private fun encodeResponse(response: WearMessage.Response): ByteArray =
    runCatching { WearProtocolCodec.encode(response) }
      .getOrElse {
        WearProtocolCodec.encode(
          WearMessage.Response(
            requestId = response.requestId,
            ok = false,
            error = WearRpcError(code = "response_too_large", message = "Phone response exceeds Wear transport limits"),
          ),
        )
      }

  private fun rememberPeer(nodeId: String) {
    synchronized(peerLock) {
      peers.remove(nodeId)
      peers.add(nodeId)
      while (peers.size > MAX_PEERS) {
        peers.remove(peers.first())
      }
    }
  }

  private fun forgetPeer(nodeId: String) {
    synchronized(peerLock) { peers.remove(nodeId) }
  }

  private fun hasPeers(): Boolean = synchronized(peerLock) { peers.isNotEmpty() }

  private fun peerSnapshot(): List<String> = synchronized(peerLock) { peers.toList() }

  internal fun peerCountForTests(): Int = synchronized(peerLock) { peers.size }

  private companion object {
    const val MAX_PEERS = 8
    const val MAX_BUFFERED_EVENTS = 32
  }
}

private suspend fun <T> Task<T>.await(): T =
  suspendCancellableCoroutine { continuation ->
    addOnSuccessListener { value -> continuation.resume(value) }
    addOnFailureListener { error -> continuation.resumeWithException(error) }
  }
