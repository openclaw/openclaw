package ai.openclaw.android.node

import android.util.Log
import ai.openclaw.android.notification.CapturedNotification
import ai.openclaw.android.notification.NotificationBatcher
import ai.openclaw.android.notification.NotificationFilter
import ai.openclaw.android.notification.OpenClawNotificationListener
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow

class NotificationListenerBridge(
  scope: CoroutineScope,
  private val isFeatureEnabled: () -> Boolean,
  private val nodeId: () -> String,
  private val filter: NotificationFilter,
  private val sendBatch: suspend (String) -> Unit,
  batchWindowMs: Long = 30_000L,
) {
  companion object {
    private const val TAG = "OpenClawNotifBridge"

    /** Singleton so the NotificationListenerService can reach the bridge. */
    @Volatile
    var instance: NotificationListenerBridge? = null
      private set
  }

  private val _isListenerConnected = MutableStateFlow(false)
  val isListenerConnected: StateFlow<Boolean> = _isListenerConnected

  private val batcher =
    NotificationBatcher(
      scope = scope,
      windowMs = batchWindowMs,
      nodeId = nodeId,
      onBatchReady = { batch ->
        val json = kotlinx.serialization.json.Json.encodeToString(
          ai.openclaw.android.notification.NotificationBatch.serializer(),
          batch,
        )
        sendBatch(json)
      },
    )

  fun activate() {
    instance = this
    refreshListenerState()
    // Drain any notifications the listener buffered while waiting for us.
    OpenClawNotificationListener.instance?.drainBufferTo(this)
    Log.i(TAG, "Bridge activated (listener=${_isListenerConnected.value})")
  }

  fun deactivate() {
    if (instance === this) instance = null
    batcher.stop()
    _isListenerConnected.value = false
    Log.i(TAG, "Bridge deactivated")
  }

  fun isEnabled(): Boolean = isFeatureEnabled()

  fun onNotificationPosted(notification: CapturedNotification) {
    if (!isFeatureEnabled()) return
    if (!filter.shouldCapture(notification.packageName, notification.category)) return
    // Skip group summaries as they duplicate individual notifications.
    if (notification.isGroupSummary) return
    batcher.add(notification)
  }

  fun onNotificationRemoved(notificationId: String) {
    batcher.remove(notificationId)
  }

  fun dismissNotification(key: String): Boolean {
    val listener = OpenClawNotificationListener.instance ?: return false
    return listener.dismissNotification(key)
  }

  fun listActive(): List<CapturedNotification> {
    val listener = OpenClawNotificationListener.instance ?: return emptyList()
    return listener.listActiveNotificationSnapshots()
      .filter { filter.shouldCapture(it.packageName, it.category) }
  }

  fun refreshListenerState() {
    _isListenerConnected.value = OpenClawNotificationListener.instance != null
  }
}
