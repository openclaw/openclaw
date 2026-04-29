package ai.openclaw.app.buddy

import ai.openclaw.app.chat.OutgoingAttachment
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

object BuddyCameraAttachment {
  private val json = Json { ignoreUnknownKeys = true }

  fun fromSnapPayload(payloadJson: String?): OutgoingAttachment? {
    if (payloadJson.isNullOrBlank()) return null
    val payload =
      try {
        json.parseToJsonElement(payloadJson) as? JsonObject
      } catch (_: Throwable) {
        null
      } ?: return null

    val format = payload["format"].asStringOrNull()?.trim()?.lowercase()
    if (format != "jpg" && format != "jpeg") return null
    val base64 = payload["base64"].asStringOrNull()?.trim().takeUnless { it.isNullOrEmpty() } ?: return null

    return OutgoingAttachment(
      type = "image",
      mimeType = "image/jpeg",
      fileName = "nemo-camera.jpg",
      base64 = base64,
    )
  }
}

private fun kotlinx.serialization.json.JsonElement?.asStringOrNull(): String? =
  when (this) {
    is JsonNull -> null
    is JsonPrimitive -> content
    else -> null
  }
