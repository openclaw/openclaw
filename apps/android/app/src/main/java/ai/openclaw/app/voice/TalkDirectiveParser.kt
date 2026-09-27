package ai.openclaw.app.voice

import ai.openclaw.app.node.parseJsonParamsObject
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/**
 * Optional first-line JSON overrides for one Talk request.
 */
data class TalkDirective(
  val voiceId: String? = null,
  val modelId: String? = null,
  val speed: Double? = null,
  val rateWpm: Int? = null,
  val stability: Double? = null,
  val similarity: Double? = null,
  val style: Double? = null,
  val speakerBoost: Boolean? = null,
  val seed: Long? = null,
  val normalize: String? = null,
  val language: String? = null,
  val outputFormat: String? = null,
  val latencyTier: Int? = null,
  val once: Boolean? = null,
)

/**
 * Parsed directive plus the utterance text after removing the directive line.
 */
data class TalkDirectiveParseResult(
  val directive: TalkDirective?,
  val stripped: String,
  val unknownKeys: List<String>,
)

object TalkDirectiveParser {
  /** Parses optional first-line JSON directives while preserving normal speech text. */
  fun parse(text: String): TalkDirectiveParseResult {
    val normalized = text.replace("\r\n", "\n")
    val lines = normalized.split("\n").toMutableList()
    val firstNonEmpty = lines.indexOfFirst { it.trim().isNotEmpty() }
    if (firstNonEmpty == -1) return TalkDirectiveParseResult(null, text, emptyList())

    val head = lines[firstNonEmpty].trim()
    // Directives are accepted only as a complete first-line JSON object; spoken text remains plain text.
    if (!head.startsWith("{") || !head.endsWith("}")) {
      return TalkDirectiveParseResult(null, text, emptyList())
    }

    val obj = parseJsonParamsObject(head) ?: return TalkDirectiveParseResult(null, text, emptyList())
    val knownKeys = mutableSetOf<String>()

    fun <T : Any> readAlias(
      vararg keys: String,
      convert: (JsonElement?) -> T?,
    ): T? {
      // Parsing and unknown-key reporting share the same case-insensitive aliases.
      knownKeys += keys.map { it.lowercase() }
      return keys.firstNotNullOfOrNull { convert(obj.valueForKey(it)) }
    }

    val speakerBoost = readAlias("speaker_boost", "speakerBoost") { it.asBooleanOrNull() }
    val noSpeakerBoost = readAlias("no_speaker_boost", "noSpeakerBoost") { it.asBooleanOrNull() }

    val directive =
      TalkDirective(
        voiceId = readAlias("voice", "voice_id", "voiceId") { it.asStringOrNull() },
        modelId = readAlias("model", "model_id", "modelId") { it.asStringOrNull() },
        speed = readAlias("speed") { it.asDoubleOrNull() },
        rateWpm = readAlias("rate", "wpm") { it.asIntOrNull() },
        stability = readAlias("stability") { it.asDoubleOrNull() },
        similarity = readAlias("similarity", "similarity_boost", "similarityBoost") { it.asDoubleOrNull() },
        style = readAlias("style") { it.asDoubleOrNull() },
        speakerBoost = speakerBoost ?: noSpeakerBoost?.not(),
        seed = readAlias("seed") { it.asLongOrNull() },
        normalize = readAlias("normalize", "apply_text_normalization") { it.asStringOrNull() },
        language = readAlias("lang", "language_code", "language") { it.asStringOrNull() },
        outputFormat = readAlias("output_format", "format") { it.asStringOrNull() },
        latencyTier = readAlias("latency", "latency_tier", "latencyTier") { it.asIntOrNull() },
        once = readAlias("once") { it.asBooleanOrNull() },
      )

    if (directive == TalkDirective()) return TalkDirectiveParseResult(null, text, emptyList())

    val unknownKeys = obj.keys.filter { !knownKeys.contains(it.lowercase()) }.sorted()

    lines.removeAt(firstNonEmpty)
    if (firstNonEmpty < lines.size) {
      if (lines[firstNonEmpty].trim().isEmpty()) {
        lines.removeAt(firstNonEmpty)
      }
    }

    return TalkDirectiveParseResult(directive, lines.joinToString("\n"), unknownKeys)
  }

  private fun JsonObject.valueForKey(key: String): JsonElement? = this[key] ?: entries.firstOrNull { it.key.equals(key, ignoreCase = true) }?.value
}

private fun JsonElement?.asStringOrNull(): String? =
  (this as? JsonPrimitive)
    ?.takeIf { it.isString }
    ?.content
    ?.trim()
    ?.takeIf { it.isNotEmpty() }

private fun JsonElement?.asDoubleOrNull(): Double? {
  val primitive = this as? JsonPrimitive ?: return null
  return primitive.content.toDoubleOrNull()
}

private fun JsonElement?.asIntOrNull(): Int? {
  val primitive = this as? JsonPrimitive ?: return null
  return primitive.content.toIntOrNull()
}

private fun JsonElement?.asLongOrNull(): Long? {
  val primitive = this as? JsonPrimitive ?: return null
  return primitive.content.toLongOrNull()
}

private fun JsonElement?.asBooleanOrNull(): Boolean? {
  val primitive = this as? JsonPrimitive ?: return null
  val content = primitive.content.trim().lowercase()
  // Accept dictated/config-style booleans in addition to strict JSON literals.
  return when (content) {
    "true", "yes", "1" -> true
    "false", "no", "0" -> false
    else -> null
  }
}
