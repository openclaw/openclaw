package ai.openclaw.app.node

import android.os.Build
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject

internal object NodePresenceAliveBeacon {
  const val EVENT_NAME: String = "node.presence.alive"
  const val MIN_SUCCESS_INTERVAL_MS: Long = 10 * 60 * 1000

  enum class Trigger(val rawValue: String) {
    Background("background"),
    SilentPush("silent_push"),
    BackgroundAppRefresh("bg_app_refresh"),
    SignificantLocation("significant_location"),
    Manual("manual"),
    Connect("connect"),
  }

  data class ResponsePayload(
    val ok: Boolean?,
    val event: String?,
    val handled: Boolean?,
    val reason: String?,
  )

  private val json = Json { ignoreUnknownKeys = true }

  fun normalizeTrigger(raw: String): Trigger {
    val normalized = raw.trim().lowercase()
    return Trigger.values().firstOrNull { it.rawValue == normalized } ?: Trigger.Background
  }

  fun shouldSkipRecentSuccess(
    isGatewayConnected: Boolean,
    nowMs: Long,
    lastSuccessAtMs: Long?,
    minIntervalMs: Long = MIN_SUCCESS_INTERVAL_MS,
  ): Boolean {
    if (!isGatewayConnected) return false
    val last = lastSuccessAtMs ?: return false
    if (last <= 0) return false
    val elapsed = nowMs - last
    return elapsed >= 0 && elapsed < minIntervalMs
  }

  fun androidPlatformLabel(): String {
    val release = Build.VERSION.RELEASE?.trim().orEmpty().ifEmpty { "unknown" }
    return "Android $release (SDK ${Build.VERSION.SDK_INT})"
  }

  fun makePayloadJson(
    trigger: Trigger,
    sentAtMs: Long,
    displayName: String,
    version: String,
    platform: String,
    deviceFamily: String?,
    modelIdentifier: String?,
    pushTransport: String? = null,
  ): String =
    buildJsonObject {
      put("trigger", JsonPrimitive(trigger.rawValue))
      put("sentAtMs", JsonPrimitive(sentAtMs))
      put("displayName", JsonPrimitive(displayName))
      put("version", JsonPrimitive(version))
      put("platform", JsonPrimitive(platform))
      deviceFamily?.trim()?.takeIf { it.isNotEmpty() }?.let { put("deviceFamily", JsonPrimitive(it)) }
      modelIdentifier?.trim()?.takeIf { it.isNotEmpty() }?.let { put("modelIdentifier", JsonPrimitive(it)) }
      pushTransport?.trim()?.takeIf { it.isNotEmpty() }?.let { put("pushTransport", JsonPrimitive(it)) }
    }.toString()

  fun decodeResponse(payloadJson: String?): ResponsePayload? {
    if (payloadJson.isNullOrBlank()) return null
    val obj =
      try {
        json.parseToJsonElement(payloadJson).asObjectOrNull()
      } catch (_: Throwable) {
        null
      } ?: return null
    return ResponsePayload(
      ok = parseJsonBooleanFlag(obj, "ok"),
      event = parseJsonString(obj, "event"),
      handled = parseJsonBooleanFlag(obj, "handled"),
      reason = parseJsonString(obj, "reason"),
    )
  }
}
