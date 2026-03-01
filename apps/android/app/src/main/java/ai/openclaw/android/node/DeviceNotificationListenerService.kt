package ai.openclaw.android.node

import android.app.Notification
import android.app.NotificationManager
import android.content.ComponentName
import android.content.Context
import android.os.Build
import android.service.notification.NotificationListenerService
import android.service.notification.StatusBarNotification

private const val MAX_NOTIFICATION_TEXT_CHARS = 512

internal fun sanitizeNotificationText(value: CharSequence?): String? {
  val normalized = value?.toString()?.trim().orEmpty()
  return normalized.take(MAX_NOTIFICATION_TEXT_CHARS).ifEmpty { null }
}

data class DeviceNotificationEntry(
  val key: String,
  val packageName: String,
  val title: String?,
  val text: String?,
  val subText: String?,
  val category: String?,
  val channelId: String?,
  val postTimeMs: Long,
  val isOngoing: Boolean,
  val isClearable: Boolean,
)

data class DeviceNotificationSnapshot(
  val enabled: Boolean,
  val connected: Boolean,
  val notifications: List<DeviceNotificationEntry>,
)

private object DeviceNotificationStore {
  private val lock = Any()
  private var connected = false
  private val byKey = LinkedHashMap<String, DeviceNotificationEntry>()

  fun replace(entries: List<DeviceNotificationEntry>) {
    synchronized(lock) {
      byKey.clear()
      for (entry in entries) {
        byKey[entry.key] = entry
      }
    }
  }

  fun upsert(entry: DeviceNotificationEntry) {
    synchronized(lock) {
      byKey[entry.key] = entry
    }
  }

  fun remove(key: String) {
    synchronized(lock) {
      byKey.remove(key)
    }
  }

  fun setConnected(value: Boolean) {
    synchronized(lock) {
      connected = value
      if (!value) {
        byKey.clear()
      }
    }
  }

  fun snapshot(enabled: Boolean): DeviceNotificationSnapshot {
    val (isConnected, entries) =
      synchronized(lock) {
        connected to byKey.values.sortedByDescending { it.postTimeMs }
      }
    return DeviceNotificationSnapshot(
      enabled = enabled,
      connected = isConnected,
      notifications = entries,
    )
  }
}

class DeviceNotificationListenerService : NotificationListenerService() {
  override fun onListenerConnected() {
    super.onListenerConnected()
    DeviceNotificationStore.setConnected(true)
    refreshActiveNotifications()
  }

  override fun onListenerDisconnected() {
    DeviceNotificationStore.setConnected(false)
    super.onListenerDisconnected()
  }

  override fun onNotificationPosted(sbn: StatusBarNotification?) {
    super.onNotificationPosted(sbn)
    val entry = sbn?.toEntry() ?: return
    DeviceNotificationStore.upsert(entry)
  }

  override fun onNotificationRemoved(sbn: StatusBarNotification?) {
    super.onNotificationRemoved(sbn)
    val key = sbn?.key ?: return
    DeviceNotificationStore.remove(key)
  }

  private fun refreshActiveNotifications() {
    val entries =
      runCatching {
        activeNotifications
          ?.mapNotNull { it.toEntry() }
          ?: emptyList()
      }.getOrElse { emptyList() }
    DeviceNotificationStore.replace(entries)
  }

  private fun StatusBarNotification.toEntry(): DeviceNotificationEntry {
    val extras = notification.extras
    val keyValue = key.takeIf { it.isNotBlank() } ?: "$packageName:$id:$postTime"
    val title = sanitizeNotificationText(extras?.getCharSequence(Notification.EXTRA_TITLE))
    val body =
      sanitizeNotificationText(extras?.getCharSequence(Notification.EXTRA_BIG_TEXT))
        ?: sanitizeNotificationText(extras?.getCharSequence(Notification.EXTRA_TEXT))
    val subText = sanitizeNotificationText(extras?.getCharSequence(Notification.EXTRA_SUB_TEXT))
    return DeviceNotificationEntry(
      key = keyValue,
      packageName = packageName,
      title = title,
      text = body,
      subText = subText,
      category = notification.category?.trim()?.ifEmpty { null },
      channelId = notification.channelId?.trim()?.ifEmpty { null },
      postTimeMs = postTime,
      isOngoing = isOngoing,
      isClearable = isClearable,
    )
  }

  companion object {
    private fun serviceComponent(context: Context): ComponentName {
      return ComponentName(context, DeviceNotificationListenerService::class.java)
    }

    fun isAccessEnabled(context: Context): Boolean {
      val manager = context.getSystemService(NotificationManager::class.java) ?: return false
      return manager.isNotificationListenerAccessGranted(serviceComponent(context))
    }

    fun snapshot(context: Context, enabled: Boolean = isAccessEnabled(context)): DeviceNotificationSnapshot {
      return DeviceNotificationStore.snapshot(enabled = enabled)
    }

    fun requestServiceRebind(context: Context) {
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.N) {
        return
      }
      runCatching {
        NotificationListenerService.requestRebind(serviceComponent(context))
      }
    }
  }
}
