package ai.openclaw.app.voice

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

private val responseEnvelopeJson = Json { ignoreUnknownKeys = true }

data class TalkResponseEnvelopeParseResult(
  val response: String?,
  val isEnvelope: Boolean,
  val keys: List<String>,
)

object TalkResponseEnvelopeParser {
  fun parse(text: String): TalkResponseEnvelopeParseResult {
    for (candidate in jsonObjectCandidates(text)) {
      val obj = parseJsonObject(candidate) ?: continue
      if (!obj.containsKey("response")) continue
      val response =
        obj["response"]
          .asStringOrNull()
          ?.trim()
          ?.takeIf { it.isNotEmpty() }
      return TalkResponseEnvelopeParseResult(
        response = response,
        isEnvelope = true,
        keys = obj.keys.sorted(),
      )
    }
    return TalkResponseEnvelopeParseResult(response = null, isEnvelope = false, keys = emptyList())
  }

  fun isEnvelopeKey(key: String): Boolean {
    val normalized = key.replace("_", "").lowercase()
    return normalized in
      setOf(
        "response",
        "spoken",
        "display",
        "summary",
        "status",
        "actions",
        "handoff",
        "notification",
        "notifications",
        "metadata",
      )
  }

  private fun jsonObjectCandidates(text: String): List<String> {
    val normalized = text.replace("\r\n", "\n")
    val trimmed = normalized.trim()
    val candidates = mutableListOf<String>()
    unfencedJson(trimmed)?.let { candidates.add(it) }
    if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
      candidates.add(trimmed)
    }
    normalized
      .split("\n")
      .firstOrNull { it.trim().isNotEmpty() }
      ?.trim()
      ?.takeIf { it.startsWith("{") && it.endsWith("}") }
      ?.let { candidates.add(it) }
    return candidates.distinct()
  }

  private fun unfencedJson(text: String): String? {
    val lines = text.split("\n")
    if (lines.size < 3) return null
    val first = lines.first().trim().lowercase()
    val last = lines.last().trim()
    if ((first != "```json" && first != "```") || last != "```") return null
    return lines.drop(1).dropLast(1).joinToString("\n").trim()
  }

  private fun parseJsonObject(candidate: String): JsonObject? =
    try {
      responseEnvelopeJson.parseToJsonElement(candidate) as? JsonObject
    } catch (_: Throwable) {
      null
    }
}

private fun JsonPrimitive?.asStringOrNull(): String? = this?.takeIf { it.isString }?.content
