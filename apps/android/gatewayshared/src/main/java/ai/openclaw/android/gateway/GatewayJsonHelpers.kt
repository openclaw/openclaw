package ai.openclaw.android.gateway

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

fun JsonElement?.asObjectOrNull(): JsonObject? = this as? JsonObject

fun JsonElement?.asArrayOrNull(): JsonArray? = this as? JsonArray

/**
 * Returns the string content of a [JsonPrimitive], or `null` for non-primitives
 * and [JsonNull]. Only actual JSON string values are returned; numeric and boolean
 * primitives yield `null`. Use [asLongOrNull] / [asBooleanOrNull] for those types.
 */
fun JsonElement?.asStringOrNull(): String? =
  when (this) {
    is JsonNull -> null
    is JsonPrimitive -> if (isString) content else null
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
