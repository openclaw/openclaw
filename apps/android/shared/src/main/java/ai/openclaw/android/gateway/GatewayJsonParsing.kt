package ai.openclaw.android.gateway

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement

/**
 * Parses a raw JSON string into a [JsonElement], returning `null` for blank
 * or malformed input. This is a convenience wrapper around
 * [Json.parseToJsonElement] that never throws.
 */
fun parseJsonOrNull(payload: String): JsonElement? {
  val trimmed = payload.trim()
  if (trimmed.isEmpty()) return null
  return try {
    Json.parseToJsonElement(trimmed)
  } catch (_: Throwable) {
    null
  }
}
