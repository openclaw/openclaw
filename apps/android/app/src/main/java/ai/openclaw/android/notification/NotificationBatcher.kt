package ai.openclaw.android.notification

import android.util.Log
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap

class NotificationBatcher(
  private val scope: CoroutineScope,
  private val windowMs: Long = 30_000L,
  private val maxPending: Int = 200,
  private val maxRetries: Int = 3,
  private val retryDelayMs: Long = 5_000L,
  private val nodeId: () -> String,
  private val onBatchReady: suspend (NotificationBatch) -> Unit,
) {
  companion object {
    private const val TAG = "OpenClawNotifBatcher"
  }

  /**
   * Deduplicated map of pending notifications. Key = notification ID, value = latest capture.
   * Using ConcurrentHashMap so the listener thread and coroutine scope don't conflict.
   * If the same notification is posted twice (e.g. updated), the latest version wins.
   */
  private val pending = ConcurrentHashMap<String, CapturedNotification>()
  private var timerJob: Job? = null
  private var retryCount = 0

  private val _pendingCount = MutableStateFlow(0)
  val pendingCount: StateFlow<Int> = _pendingCount

  fun add(notification: CapturedNotification) {
    // Enforce max pending to prevent unbounded memory growth.
    // If at limit and this is a new key, evict the oldest entry.
    if (pending.size >= maxPending && !pending.containsKey(notification.id)) {
      // ConcurrentHashMap has no ordering guarantee, so just remove any one entry.
      pending.keys().asIterator().let { iter ->
        if (iter.hasNext()) pending.remove(iter.next())
      }
    }
    // Insert or replace -- latest version of a notification wins.
    pending[notification.id] = notification
    _pendingCount.value = pending.size
    ensureTimerRunning()
  }

  fun remove(notificationId: String) {
    pending.remove(notificationId)
    _pendingCount.value = pending.size
  }

  private fun ensureTimerRunning() {
    if (timerJob?.isActive == true) return
    timerJob =
      scope.launch {
        delay(windowMs)
        flush()
      }
  }

  internal suspend fun flush() {
    // Snapshot and clear atomically.
    val items = pending.values.toList()
    pending.clear()
    _pendingCount.value = 0
    if (items.isEmpty()) return

    val batch =
      NotificationBatch(
        batchId = UUID.randomUUID().toString(),
        nodeId = nodeId(),
        notifications = items,
        batchedAtMs = System.currentTimeMillis(),
        windowMs = windowMs,
      )
    try {
      onBatchReady(batch)
      retryCount = 0
    } catch (err: Throwable) {
      Log.w(TAG, "batch delivery failed (${items.size} notifications): ${err.message}")
      if (retryCount < maxRetries) {
        // Re-insert items for retry. Existing entries (if any new ones arrived) are kept.
        for (item in items) {
          pending.putIfAbsent(item.id, item)
        }
        _pendingCount.value = pending.size
        retryCount++
        Log.i(TAG, "scheduling retry $retryCount/$maxRetries in ${retryDelayMs}ms")
        timerJob =
          scope.launch {
            delay(retryDelayMs * retryCount)
            flush()
          }
      } else {
        Log.w(TAG, "max retries reached, dropping ${items.size} notifications")
        retryCount = 0
      }
    }
  }

  fun stop() {
    timerJob?.cancel()
    timerJob = null
    pending.clear()
    _pendingCount.value = 0
    retryCount = 0
  }
}
