package ai.openclaw.app.auto

import ai.openclaw.app.gateway.GatewaySession
import android.content.Context
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

class CarCommandHandler(
  private val context: Context,
  private val vehicleActionController: CarVehicleActionController,
  private val notificationHandler: CarNotificationHandler,
) {
  private val json = Json { ignoreUnknownKeys = true }

  fun handleNavigate(paramsJson: String?): GatewaySession.InvokeResult {
    val destination = paramsJson?.let {
      runCatching { json.parseToJsonElement(it).jsonObject["destination"]?.jsonPrimitive?.content }.getOrNull()
    } ?: return GatewaySession.InvokeResult.error("invalid_params", "Missing destination field")

    val success = vehicleActionController.navigateTo(destination)
    return if (success) {
      GatewaySession.InvokeResult.ok("{\"success\":true,\"action\":\"navigate\",\"destination\":\"$destination\"}")
    } else {
      GatewaySession.InvokeResult.error("navigation_failed", "Could not start navigation intent")
    }
  }

  fun handleMedia(paramsJson: String?): GatewaySession.InvokeResult {
    val obj = paramsJson?.let {
      runCatching { json.parseToJsonElement(it).jsonObject }.getOrNull()
    }
    val action = obj?.get("action")?.jsonPrimitive?.content ?: "play_pause"
    val query = obj?.get("query")?.jsonPrimitive?.content

    val ok = when (action) {
      "search_play" -> query?.let { vehicleActionController.playMediaSearch(it) } ?: false
      "next" -> vehicleActionController.mediaNext()
      "previous" -> vehicleActionController.mediaPrevious()
      "play_pause" -> vehicleActionController.mediaPlayPause()
      else -> false
    }

    return if (ok) {
      GatewaySession.InvokeResult.ok("{\"success\":true,\"action\":\"$action\"}")
    } else {
      GatewaySession.InvokeResult.error("media_failed", "Failed to trigger media action: $action")
    }
  }

  fun handleAlert(paramsJson: String?): GatewaySession.InvokeResult {
    val obj = paramsJson?.let {
      runCatching { json.parseToJsonElement(it).jsonObject }.getOrNull()
    }
    val title = obj?.get("title")?.jsonPrimitive?.content ?: "OpenClaw Alerta"
    val message = obj?.get("message")?.jsonPrimitive?.content ?: ""

    notificationHandler.postCarAlert(
      id = System.currentTimeMillis().toInt(),
      title = title,
      message = message,
    )
    return GatewaySession.InvokeResult.ok("{\"success\":true,\"posted\":true}")
  }
}
