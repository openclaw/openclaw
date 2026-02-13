package ai.openclaw.android.node

import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

const val DEFAULT_SEAM_COLOR_ARGB: Long = 0xFF4F7A9A

data class Quad<A, B, C, D>(val first: A, val second: B, val third: C, val fourth: D)

fun String.toJsonString(): String {
  val escaped =
    this.replace("\\", "\\\\")
      .replace("\"", "\\\"")
      .replace("\n", "\\n")
      .replace("\r", "\\r")
  return "\"$escaped\""
}

fun JsonElement?.asObjectOrNull(): JsonObject? = this as? JsonObject

fun JsonElement?.asStringOrNull(): String? =
  when (this) {
    is JsonNull -> null
    is JsonPrimitive -> content
    else -> null
  }

fun parseHexColorArgb(raw: String?): Long? {
  val trimmed = raw?.trim().orEmpty()
  if (trimmed.isEmpty()) return null
  val hex = if (trimmed.startsWith("#")) trimmed.drop(1) else trimmed
  if (hex.length != 6) return null
  val rgb = hex.toLongOrNull(16) ?: return null
  return 0xFF000000L or rgb
}

fun invokeErrorFromThrowable(err: Throwable): Pair<String, String> {
  val raw = (err.message ?: "").trim()
  if (raw.isEmpty()) return "UNAVAILABLE" to "UNAVAILABLE: error"

  val idx = raw.indexOf(':')
  if (idx <= 0) return "UNAVAILABLE" to raw
  val code = raw.substring(0, idx).trim().ifEmpty { "UNAVAILABLE" }
  val message = raw.substring(idx + 1).trim().ifEmpty { raw }
  return code to "$code: $message"
}

fun normalizeMainKey(raw: String?): String? {
  val trimmed = raw?.trim().orEmpty()
  return if (trimmed.isEmpty()) null else trimmed
}

fun isCanonicalMainSessionKey(key: String): Boolean {
  return key == "main"
}
