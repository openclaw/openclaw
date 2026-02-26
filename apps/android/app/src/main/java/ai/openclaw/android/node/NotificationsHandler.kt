package ai.openclaw.android.node

import android.content.Context
import ai.openclaw.android.gateway.GatewaySession
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

class NotificationsHandler(
  private val appContext: Context,
) {
  suspend fun handleNotificationsList(_paramsJson: String?): GatewaySession.InvokeResult {
    if (!DeviceNotificationListenerService.isAccessEnabled(appContext)) {
      return GatewaySession.InvokeResult.error(
        code = "NOTIFICATION_LISTENER_DISABLED",
        message =
          "NOTIFICATION_LISTENER_DISABLED: enable Notification Access for OpenClaw in system settings",
      )
    }
    val snapshot = DeviceNotificationListenerService.snapshot(appContext)
    if (!snapshot.connected) {
      DeviceNotificationListenerService.requestServiceRebind(appContext)
      return GatewaySession.InvokeResult.error(
        code = "NOTIFICATION_LISTENER_UNAVAILABLE",
        message = "NOTIFICATION_LISTENER_UNAVAILABLE: listener is reconnecting; retry shortly",
      )
    }

    val payload =
      buildJsonObject {
        put("enabled", JsonPrimitive(snapshot.enabled))
        put("connected", JsonPrimitive(snapshot.connected))
        put("count", JsonPrimitive(snapshot.notifications.size))
        put(
          "notifications",
          JsonArray(
            snapshot.notifications.map { entry ->
              buildJsonObject {
                put("key", JsonPrimitive(entry.key))
                put("packageName", JsonPrimitive(entry.packageName))
                put("postTimeMs", JsonPrimitive(entry.postTimeMs))
                put("isOngoing", JsonPrimitive(entry.isOngoing))
                put("isClearable", JsonPrimitive(entry.isClearable))
                entry.title?.let { put("title", JsonPrimitive(it)) }
                entry.text?.let { put("text", JsonPrimitive(it)) }
                entry.subText?.let { put("subText", JsonPrimitive(it)) }
                entry.category?.let { put("category", JsonPrimitive(it)) }
                entry.channelId?.let { put("channelId", JsonPrimitive(it)) }
              }
            },
          ),
        )
      }
    return GatewaySession.InvokeResult.ok(payload.toString())
  }
}
