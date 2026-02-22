package ai.openclaw.android.node

import ai.openclaw.android.gateway.GatewaySession
import ai.openclaw.android.notification.CapturedNotification
import ai.openclaw.android.notification.DismissResult
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonPrimitive

class NotificationHandler(
  private val bridge: NotificationListenerBridge,
  private val json: Json = Json { ignoreUnknownKeys = true },
) {
  @Serializable
  private data class ListResponse(
    val notifications: List<CapturedNotification>,
    val count: Int,
  )

  suspend fun handleDismiss(paramsJson: String?): GatewaySession.InvokeResult {
    val key =
      try {
        val obj = json.parseToJsonElement(paramsJson ?: "{}") as? JsonObject
        obj?.get("key")?.jsonPrimitive?.content
      } catch (_: Throwable) {
        null
      }

    if (key.isNullOrBlank()) {
      return GatewaySession.InvokeResult.error(
        code = "INVALID_REQUEST",
        message = "key required",
      )
    }

    val dismissed = bridge.dismissNotification(key)
    val result = DismissResult(dismissed = dismissed, key = key)
    val payload = json.encodeToString(DismissResult.serializer(), result)
    return GatewaySession.InvokeResult.ok(payload)
  }

  suspend fun handleList(paramsJson: String?): GatewaySession.InvokeResult {
    val notifications = bridge.listActive()
    val response = ListResponse(notifications = notifications, count = notifications.size)
    val payload = json.encodeToString(ListResponse.serializer(), response)
    return GatewaySession.InvokeResult.ok(payload)
  }
}
