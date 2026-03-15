package ai.openclaw.android.gateway

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

fun JsonElement?.asObjectOrNull(): JsonObject? = this as? JsonObject

fun JsonElement?.asArrayOrNull(): JsonArray? = this as? JsonArray

fun JsonElement?.asStringOrNull(): String? =
  when (this) {
    is JsonNull -> null
    is JsonPrimitive -> content
    else -> null
  }

fun JsonElement?.asBooleanOrNull(): Boolean? =
  when (this) {
    is JsonPrimitive -> {
      val c = content.trim()
      when {
        c.equals("true", ignoreCase = true) -> true
        c.equals("false", ignoreCase = true) -> false
        else -> null
      }
    }
    else -> null
  }

fun JsonElement?.asLongOrNull(): Long? =
  when (this) {
    is JsonPrimitive -> content.toLongOrNull()
    else -> null
  }

fun parseJsonOrNull(payload: String): JsonElement? {
  val trimmed = payload.trim()
  if (trimmed.isEmpty()) return null
  return try {
    Json.parseToJsonElement(trimmed)
  } catch (_: Throwable) {
    null
  }
}
