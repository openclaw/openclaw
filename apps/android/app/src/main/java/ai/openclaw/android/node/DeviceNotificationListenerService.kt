package ai.openclaw.android.node

import android.app.Notification
import android.app.NotificationManager
import android.app.RemoteInput
import android.content.ComponentName
import android.content.Context
import android.content.Intent
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

enum class NotificationActionKind {
  Open,
  Dismiss,
  Reply,
}

data class NotificationActionRequest(
  val key: String,
  val kind: NotificationActionKind,
  val replyText: String? = null,
)

data class NotificationActionResult(
  val ok: Boolean,
  val code: String? = null,
  val message: String? = null,
)

internal fun actionRequiresClearableNotification(kind: NotificationActionKind): Boolean {
  return kind == NotificationActionKind.Dismiss
}

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
    activeService = this
    DeviceNotificationStore.setConnected(true)
    refreshActiveNotifications()
  }

  override fun onListenerDisconnected() {
    if (activeService === this) {
      activeService = null
    }
    DeviceNotificationStore.setConnected(false)
    super.onListenerDisconnected()
  }

  override fun onDestroy() {
    if (activeService === this) {
      activeService = null
    }
    super.onDestroy()
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
    @Volatile private var activeService: DeviceNotificationListenerService? = null

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

    fun executeAction(context: Context, request: NotificationActionRequest): NotificationActionResult {
      if (!isAccessEnabled(context)) {
        return NotificationActionResult(
          ok = false,
          code = "NOTIFICATIONS_DISABLED",
          message = "NOTIFICATIONS_DISABLED: enable notification access in system Settings",
        )
      }
      val service = activeService
        ?: return NotificationActionResult(
          ok = false,
          code = "NOTIFICATIONS_UNAVAILABLE",
          message = "NOTIFICATIONS_UNAVAILABLE: notification listener not connected",
        )
      return service.executeActionInternal(request)
    }
  }

  private fun executeActionInternal(request: NotificationActionRequest): NotificationActionResult {
    val sbn =
      activeNotifications
        ?.firstOrNull { it.key == request.key }
        ?: return NotificationActionResult(
          ok = false,
          code = "NOTIFICATION_NOT_FOUND",
          message = "NOTIFICATION_NOT_FOUND: notification key not found",
        )
    if (actionRequiresClearableNotification(request.kind) && !sbn.isClearable) {
      return NotificationActionResult(
        ok = false,
        code = "NOTIFICATION_NOT_CLEARABLE",
        message = "NOTIFICATION_NOT_CLEARABLE: notification is ongoing or protected",
      )
    }

    return when (request.kind) {
      NotificationActionKind.Open -> {
        val pendingIntent = sbn.notification.contentIntent
          ?: return NotificationActionResult(
            ok = false,
            code = "ACTION_UNAVAILABLE",
            message = "ACTION_UNAVAILABLE: notification has no open action",
          )
        runCatching {
          pendingIntent.send()
        }.fold(
          onSuccess = { NotificationActionResult(ok = true) },
          onFailure = { err ->
            NotificationActionResult(
              ok = false,
              code = "ACTION_FAILED",
              message = "ACTION_FAILED: ${err.message ?: "open failed"}",
            )
          },
        )
      }

      NotificationActionKind.Dismiss -> {
        runCatching {
          cancelNotification(sbn.key)
          DeviceNotificationStore.remove(sbn.key)
        }.fold(
          onSuccess = { NotificationActionResult(ok = true) },
          onFailure = { err ->
            NotificationActionResult(
              ok = false,
              code = "ACTION_FAILED",
              message = "ACTION_FAILED: ${err.message ?: "dismiss failed"}",
            )
          },
        )
      }

      NotificationActionKind.Reply -> {
        val replyText = request.replyText?.trim().orEmpty()
        if (replyText.isEmpty()) {
          return NotificationActionResult(
            ok = false,
            code = "INVALID_REQUEST",
            message = "INVALID_REQUEST: replyText required for reply action",
          )
        }
        val action =
          sbn.notification.actions
            ?.firstOrNull { candidate ->
              candidate.actionIntent != null && !candidate.remoteInputs.isNullOrEmpty()
            }
            ?: return NotificationActionResult(
              ok = false,
              code = "ACTION_UNAVAILABLE",
              message = "ACTION_UNAVAILABLE: notification has no reply action",
            )
        val remoteInputs = action.remoteInputs ?: emptyArray()
        val fillInIntent = Intent()
        val replyBundle = android.os.Bundle()
        for (remoteInput in remoteInputs) {
          replyBundle.putCharSequence(remoteInput.resultKey, replyText)
        }
        RemoteInput.addResultsToIntent(remoteInputs, fillInIntent, replyBundle)
        runCatching {
          action.actionIntent.send(this, 0, fillInIntent)
        }.fold(
          onSuccess = { NotificationActionResult(ok = true) },
          onFailure = { err ->
            NotificationActionResult(
              ok = false,
              code = "ACTION_FAILED",
              message = "ACTION_FAILED: ${err.message ?: "reply failed"}",
            )
          },
        )
      }
    }
  }
}
