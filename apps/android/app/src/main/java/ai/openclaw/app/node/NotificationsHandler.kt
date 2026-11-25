package ai.openclaw.app.node

import ai.openclaw.app.gateway.GatewaySession
import ai.openclaw.app.nonBlankString
import android.content.Context
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

class NotificationsHandler internal constructor(
  appContext: Context,
  private val readSnapshot: () -> DeviceNotificationSnapshot = {
    if (DeviceNotificationListenerService.isAccessEnabled(appContext)) {
      DeviceNotificationListenerService.snapshot(appContext, enabled = true)
    } else {
      DeviceNotificationSnapshot(enabled = false, connected = false, notifications = emptyList())
    }
  },
  private val requestServiceRebind: () -> Unit = { DeviceNotificationListenerService.requestServiceRebind(appContext) },
  private val executeAction: (NotificationActionRequest) -> NotificationActionResult = {
    DeviceNotificationListenerService.executeAction(appContext, it)
  },
) {
  /** Lists the current listener snapshot after nudging Android to reconnect if needed. */
  suspend fun handleNotificationsList(_paramsJson: String?): GatewaySession.InvokeResult {
    val snapshot = readSnapshotWithRebind()
    return GatewaySession.InvokeResult.ok(snapshotPayloadJson(snapshot))
  }

  suspend fun handleNotificationsActions(paramsJson: String?): GatewaySession.InvokeResult {
    readSnapshotWithRebind()

    val params =
      parseJsonParamsObject(paramsJson)
        ?: return nodeInvokeError("INVALID_REQUEST", "expected JSON object")
    val key =
      params.nonBlankString("key")
        ?: return nodeInvokeError("INVALID_REQUEST", "key required")
    val actionRaw =
      params.nonBlankString("action")?.lowercase()
        ?: return nodeInvokeError("INVALID_REQUEST", "action required (open|dismiss|reply)")
    // Keep accepted action names aligned with the cross-platform notification
    // command contract rather than Android-specific PendingIntent labels.
    val action =
      when (actionRaw) {
        "open" -> NotificationActionKind.Open
        "dismiss" -> NotificationActionKind.Dismiss
        "reply" -> NotificationActionKind.Reply
        else -> return nodeInvokeError("INVALID_REQUEST", "action must be open|dismiss|reply")
      }
    val replyText = params.nonBlankString("replyText")
    if (action == NotificationActionKind.Reply && replyText.isNullOrBlank()) {
      return nodeInvokeError("INVALID_REQUEST", "replyText required for reply action")
    }

    val result =
      executeAction(
        NotificationActionRequest(
          key = key,
          kind = action,
          replyText = replyText,
        ),
      )
    if (!result.ok) {
      return GatewaySession.InvokeResult.error(
        code = result.code ?: "UNAVAILABLE",
        message = result.message ?: "notification action failed",
      )
    }

    val payload =
      buildJsonObject {
        put("ok", JsonPrimitive(true))
        put("key", JsonPrimitive(key))
        put("action", JsonPrimitive(actionRaw))
      }.toString()
    return GatewaySession.InvokeResult.ok(payload)
  }

  private fun readSnapshotWithRebind(): DeviceNotificationSnapshot {
    val snapshot = readSnapshot()
    if (snapshot.enabled && !snapshot.connected) {
      // Access can be granted while Android has not rebound the listener yet.
      requestServiceRebind()
    }
    return snapshot
  }

  private fun snapshotPayloadJson(snapshot: DeviceNotificationSnapshot): String =
    buildJsonObject {
      put("enabled", JsonPrimitive(snapshot.enabled))
      put("connected", JsonPrimitive(snapshot.connected))
      put("count", JsonPrimitive(snapshot.notifications.size))
      put("notifications", JsonArray(snapshot.notifications.map { it.toJsonObject() }))
    }.toString()
}
