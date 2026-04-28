package ai.openclaw.android.gateway

import android.util.Log
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.json.Json

private enum class GatewayEventPriority {
  CRITICAL,
  NORMAL,
  COALESCABLE,
}

private data class QueuedGatewayEvent(
  val event: GatewayEvent,
  val priority: GatewayEventPriority,
  val coalesceKey: String?,
  val purgeKey: String?,
)

/**
 * Serializes gateway event delivery and coalesces delta bursts so terminal
 * states are not dropped under backpressure.
 */
class GatewayEventQueue(
  private val scope: CoroutineScope,
  private val json: Json,
  private val logTag: String = "GatewayEventQueue",
  private val maxQueueSize: Int = 256,
) {
  private val _events = MutableSharedFlow<GatewayEvent>()
  val events: SharedFlow<GatewayEvent> = _events.asSharedFlow()

  private val queue = ArrayList<QueuedGatewayEvent>()
  private val queueMutex = Mutex()
  private var drainJob: Job? = null

  fun emit(event: String, payloadJson: String?) {
    emit(GatewayEvent(event, payloadJson))
  }

  fun emit(event: GatewayEvent) {
    val queued = classifyEvent(event)
    scope.launch(start = CoroutineStart.UNDISPATCHED) {
      enqueue(queued)
    }
  }

  private suspend fun enqueue(event: QueuedGatewayEvent) {
    queueMutex.withLock {
      if (event.purgeKey != null) {
        // Terminal events should not be stuck behind stale deltas for the same run.
        queue.removeAll {
          it.priority == GatewayEventPriority.COALESCABLE && it.coalesceKey == event.purgeKey
        }
      }
      if (event.priority == GatewayEventPriority.COALESCABLE && event.coalesceKey != null) {
        val index = queue.indexOfLast { it.coalesceKey == event.coalesceKey }
        if (index >= 0) {
          queue.removeAt(index)
        }
      }
      queue.add(event)
      trimQueueIfNeeded()
      ensureDrainLocked()
    }
  }

  private suspend fun drain() {
    while (true) {
      _events.subscriptionCount.first { it > 0 }
      val next =
        queueMutex.withLock {
          if (queue.isEmpty()) {
            drainJob = null
            return
          }
          queue.removeAt(0)
        }
      _events.emit(next.event)
    }
  }

  private fun ensureDrainLocked() {
    if (queue.isEmpty()) {
      return
    }
    if (drainJob?.isActive == true) {
      return
    }
    drainJob = scope.launch { drain() }
  }

  private fun trimQueueIfNeeded() {
    while (queue.size > maxQueueSize) {
      val dropIndex =
        queue.indexOfFirst { it.priority == GatewayEventPriority.COALESCABLE }
          .takeIf { it >= 0 }
          ?: queue.indexOfFirst { it.priority == GatewayEventPriority.NORMAL }
            .takeIf { it >= 0 }
          ?: 0
      val dropped = queue.removeAt(dropIndex)
      if (dropped.priority == GatewayEventPriority.CRITICAL) {
        Log.w(logTag, "Gateway event queue overflow; dropping critical event ${dropped.event.event}")
      }
    }
  }

  private fun classifyEvent(event: GatewayEvent): QueuedGatewayEvent {
    val name = event.event
    val payloadJson = event.payloadJson
    if (name == "mainSessionKey" || name == "seqGap") {
      return QueuedGatewayEvent(event, GatewayEventPriority.CRITICAL, null, null)
    }
    return when (name) {
      "chat.side_result" ->
        QueuedGatewayEvent(event, GatewayEventPriority.CRITICAL, null, null)
      "chat" -> {
        if (payloadJson.isNullOrBlank()) {
          return QueuedGatewayEvent(event, GatewayEventPriority.NORMAL, null, null)
        }
        val payload =
          try {
            json.parseToJsonElement(payloadJson).asObjectOrNull()
          } catch (_: Throwable) {
            null
          } ?: return QueuedGatewayEvent(event, GatewayEventPriority.NORMAL, null, null)
        val state = payload["state"].asStringOrNull()
        val runId = payload["runId"].asStringOrNull()
        val sessionKey = payload["sessionKey"].asStringOrNull()
        val key = coalesceKey("chat", runId, sessionKey)
        when (state) {
          "delta" ->
            QueuedGatewayEvent(event, GatewayEventPriority.COALESCABLE, key, null)
          "final", "aborted", "error" ->
            QueuedGatewayEvent(event, GatewayEventPriority.CRITICAL, null, key)
          else ->
            QueuedGatewayEvent(event, GatewayEventPriority.NORMAL, null, null)
        }
      }
      "agent" -> {
        if (payloadJson.isNullOrBlank()) {
          return QueuedGatewayEvent(event, GatewayEventPriority.NORMAL, null, null)
        }
        val payload =
          try {
            json.parseToJsonElement(payloadJson).asObjectOrNull()
          } catch (_: Throwable) {
            null
          } ?: return QueuedGatewayEvent(event, GatewayEventPriority.NORMAL, null, null)
        val stream = payload["stream"].asStringOrNull()
        val runId = payload["runId"].asStringOrNull()
        val sessionKey = payload["sessionKey"].asStringOrNull()
        val key = coalesceKey("agent", runId, sessionKey)
        if (stream == "assistant") {
          QueuedGatewayEvent(event, GatewayEventPriority.COALESCABLE, key, null)
        } else {
          QueuedGatewayEvent(event, GatewayEventPriority.NORMAL, null, null)
        }
      }
      else ->
        QueuedGatewayEvent(event, GatewayEventPriority.NORMAL, null, null)
    }
  }

  private fun coalesceKey(prefix: String, runId: String?, sessionKey: String?): String? {
    return when {
      !runId.isNullOrBlank() -> "$prefix:run:$runId"
      !sessionKey.isNullOrBlank() -> "$prefix:session:$sessionKey"
      else -> null
    }
  }
}
