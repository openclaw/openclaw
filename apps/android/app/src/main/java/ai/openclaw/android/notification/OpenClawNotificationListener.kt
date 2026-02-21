package ai.openclaw.android.notification

import android.app.Notification
import android.content.pm.PackageManager
import android.service.notification.NotificationListenerService
import android.service.notification.StatusBarNotification
import android.util.Log
import ai.openclaw.android.node.NotificationListenerBridge
import java.util.concurrent.ConcurrentLinkedQueue

class OpenClawNotificationListener : NotificationListenerService() {

  companion object {
    private const val TAG = "OpenClawNotifListener"

    /**
     * Maximum notifications buffered while waiting for the bridge to become available.
     * Prevents unbounded memory if the bridge never activates.
     */
    private const val MAX_BUFFER_SIZE = 50

    /** Singleton reference so the bridge can reach the active listener instance. */
    @Volatile
    var instance: OpenClawNotificationListener? = null
      private set

    fun extractNotification(
      sbn: StatusBarNotification,
      pm: PackageManager,
    ): CapturedNotification {
      val notification = sbn.notification
      val extras = notification.extras

      val appLabel =
        try {
          pm
            .getApplicationLabel(pm.getApplicationInfo(sbn.packageName, 0))
            .toString()
        } catch (_: Throwable) {
          sbn.packageName
        }

      val title = extras?.getCharSequence(Notification.EXTRA_TITLE)?.toString()
      val rawText = extras?.getCharSequence(Notification.EXTRA_TEXT)?.toString()
      val text =
        if (rawText != null && rawText.length > NotificationFilter.MAX_TEXT_LENGTH) {
          rawText.take(NotificationFilter.MAX_TEXT_LENGTH)
        } else {
          rawText
        }

      return CapturedNotification(
        id = "${sbn.packageName}:${sbn.id}:${sbn.tag.orEmpty()}",
        key = sbn.key,
        packageName = sbn.packageName,
        appLabel = appLabel,
        title = title,
        text = text,
        timestamp = sbn.postTime,
        priority = @Suppress("DEPRECATION") notification.priority,
        category = notification.category,
        groupKey = sbn.groupKey,
        isOngoing = (notification.flags and Notification.FLAG_ONGOING_EVENT) != 0,
        isGroupSummary = (notification.flags and Notification.FLAG_GROUP_SUMMARY) != 0,
      )
    }
  }

  /**
   * Buffer for notifications that arrive before the bridge is activated.
   * Drained by [drainBufferTo] when the bridge becomes available.
   */
  private val preBuffer = ConcurrentLinkedQueue<CapturedNotification>()

  override fun onListenerConnected() {
    super.onListenerConnected()
    instance = this
    Log.i(TAG, "Notification listener connected")
    // If the bridge is already active, drain any buffered notifications.
    NotificationListenerBridge.instance?.let { bridge ->
      drainBufferTo(bridge)
    }
  }

  override fun onListenerDisconnected() {
    super.onListenerDisconnected()
    instance = null
    preBuffer.clear()
    Log.i(TAG, "Notification listener disconnected")
  }

  override fun onNotificationPosted(sbn: StatusBarNotification?) {
    if (sbn == null) return
    try {
      val captured = extractNotification(sbn, packageManager)
      val bridge = NotificationListenerBridge.instance
      if (bridge != null && bridge.isEnabled()) {
        bridge.onNotificationPosted(captured)
      } else {
        // Bridge not ready yet -- buffer for later drain.
        if (preBuffer.size >= MAX_BUFFER_SIZE) {
          preBuffer.poll()
        }
        preBuffer.add(captured)
      }
    } catch (err: Throwable) {
      Log.w(TAG, "onNotificationPosted error: ${err.message}")
    }
  }

  override fun onNotificationRemoved(sbn: StatusBarNotification?) {
    if (sbn == null) return
    try {
      val id = "${sbn.packageName}:${sbn.id}:${sbn.tag.orEmpty()}"
      val bridge = NotificationListenerBridge.instance
      if (bridge != null) {
        bridge.onNotificationRemoved(id)
      } else {
        preBuffer.removeAll { it.id == id }
      }
    } catch (err: Throwable) {
      Log.w(TAG, "onNotificationRemoved error: ${err.message}")
    }
  }

  /**
   * Called by [NotificationListenerBridge.activate] to drain any notifications
   * that arrived before the bridge was ready.
   */
  fun drainBufferTo(bridge: NotificationListenerBridge) {
    var count = 0
    while (true) {
      val captured = preBuffer.poll() ?: break
      bridge.onNotificationPosted(captured)
      count++
    }
    if (count > 0) {
      Log.i(TAG, "Drained $count buffered notifications to bridge")
    }
  }

  fun dismissNotification(key: String): Boolean {
    return try {
      cancelNotification(key)
      true
    } catch (_: Throwable) {
      false
    }
  }

  fun listActiveNotificationSnapshots(): List<CapturedNotification> {
    return try {
      activeNotifications
        ?.map { extractNotification(it, packageManager) }
        ?: emptyList()
    } catch (_: Throwable) {
      emptyList()
    }
  }
}
