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
import java.util.concurrent.Executor
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
    messageClient.sendMessage(nodeId, path, data).awaitWearTask()
  }
}

internal class WearProxyBridge(
  private val scope: CoroutineScope,
  private val sender: WearMessageSender,
  private val handleRequest: suspend (WearMessage.Request) -> WearMessage.Response,
) {
  private val peerLock = Any()
  private val peers = LinkedHashMap<String, Long>()
  private var peerGeneration = 0L
  private val eventPublishLock = Any()
  private var sequence = 0L

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
    val peer = rememberPeer(sourceNodeId)
    val response = handleRequest(request)
    val encoded = encodeResponse(response)
    sendToPeer(peer, WearProtocol.RESPONSE_PATH, encoded)
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
    // Sequence allocation and channel insertion are one ordered operation. Splitting them lets
    // concurrent connection/chat callbacks enqueue N+1 before N and manufacture a false gap.
    synchronized(eventPublishLock) {
      sequence += 1
      events.trySend(
        WearMessage.Event(
          sequence = sequence,
          event = type,
          payload = payload,
        ),
      )
    }
  }

  private suspend fun sendEvent(event: WearMessage.Event) {
    val encoded = runCatching { WearProtocolCodec.encode(event) }.getOrNull() ?: return
    for (peer in peerSnapshot()) {
      sendToPeer(peer, WearProtocol.EVENT_PATH, encoded)
    }
  }

  private suspend fun sendToPeer(
    peer: PeerRegistration,
    path: String,
    data: ByteArray,
  ) {
    try {
      sender.send(peer.nodeId, path, data)
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

  private fun rememberPeer(nodeId: String): PeerRegistration =
    synchronized(peerLock) {
      peerGeneration += 1
      peers.remove(nodeId)
      peers[nodeId] = peerGeneration
      while (peers.size > MAX_PEERS) {
        peers.remove(peers.keys.first())
      }
      PeerRegistration(nodeId = nodeId, generation = peerGeneration)
    }

  private fun forgetPeer(peer: PeerRegistration) {
    synchronized(peerLock) {
      // An older event send may fail after a new request refreshed the same watch. Remove only
      // the registration that owned this send, or the successful request would lose its events.
      if (peers[peer.nodeId] == peer.generation) peers.remove(peer.nodeId)
    }
  }

  private fun hasPeers(): Boolean = synchronized(peerLock) { peers.isNotEmpty() }

  private fun peerSnapshot(): List<PeerRegistration> =
    synchronized(peerLock) {
      peers.map { (nodeId, generation) -> PeerRegistration(nodeId = nodeId, generation = generation) }
    }

  internal fun peerCountForTests(): Int = synchronized(peerLock) { peers.size }

  private companion object {
    const val MAX_PEERS = 8
    const val MAX_BUFFERED_EVENTS = 32
  }
}

private data class PeerRegistration(
  val nodeId: String,
  val generation: Long,
)

internal class WearTaskCanceledException : IllegalStateException("Wear message task was canceled")

private val directTaskExecutor = Executor(Runnable::run)

internal suspend fun <T> Task<T>.awaitWearTask(): T =
  suspendCancellableCoroutine { continuation ->
    addOnSuccessListener(directTaskExecutor) { value ->
      continuation.resume(value)
    }
    addOnFailureListener(directTaskExecutor) { error ->
      continuation.resumeWithException(error)
    }
    // Google Tasks do not invoke failure listeners for cancellation. Treat the Task's canceled
    // state as a send failure; cancellation of the calling coroutine remains owned by the
    // cancellable continuation and is still propagated as CancellationException.
    addOnCanceledListener(directTaskExecutor) {
      continuation.resumeWithException(WearTaskCanceledException())
    }
  }
