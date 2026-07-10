package ai.openclaw.mobile.core

import kotlinx.serialization.decodeFromString
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

private val coreJson = Json { ignoreUnknownKeys = true }

/** Platform-preserving rules for decimal DNS-SD escapes. */
enum class BonjourEscapePolicy {
  UTF8_BYTES,
  UNICODE_SCALARS,
}

/** Platform-preserving rules for custom gateway header values. */
enum class HeaderValuePolicy {
  ASCII_PRINTABLE,
  NO_CONTROL_CHARACTERS,
}

/** Canonical device-auth payload serialization. */
object DeviceAuthPayload {
  fun buildV2(
    deviceId: String,
    clientId: String,
    clientMode: String,
    role: String,
    scopes: List<String>,
    signedAtMs: Long,
    token: String?,
    nonce: String,
  ): String =
    serialize(
      version = "v2",
      deviceId = deviceId,
      clientId = clientId,
      clientMode = clientMode,
      role = role,
      scopes = scopes,
      signedAtMs = signedAtMs,
      token = token,
      nonce = nonce,
    )

  fun buildV3(
    deviceId: String,
    clientId: String,
    clientMode: String,
    role: String,
    scopes: List<String>,
    signedAtMs: Long,
    token: String?,
    nonce: String,
    platform: String?,
    deviceFamily: String?,
  ): String =
    serialize(
      version = "v3",
      deviceId = deviceId,
      clientId = clientId,
      clientMode = clientMode,
      role = role,
      scopes = scopes,
      signedAtMs = signedAtMs,
      token = token,
      nonce = nonce,
      metadata = listOf(normalizeMetadataField(platform), normalizeMetadataField(deviceFamily)),
    )

  /** Lowercases ASCII metadata without applying a locale-sensitive transform. */
  fun normalizeMetadataField(value: String?): String {
    val trimmed = value?.trim().orEmpty()
    return buildString(trimmed.length) {
      for (character in trimmed) {
        append(if (character in 'A'..'Z') (character.code + 32).toChar() else character)
      }
    }
  }

  private fun serialize(
    version: String,
    deviceId: String,
    clientId: String,
    clientMode: String,
    role: String,
    scopes: List<String>,
    signedAtMs: Long,
    token: String?,
    nonce: String,
    metadata: List<String> = emptyList(),
  ): String =
    listOf(
      version,
      deviceId,
      clientId,
      clientMode,
      role,
      scopes.joinToString(","),
      signedAtMs.toString(),
      token.orEmpty(),
      nonce,
    ).plus(metadata).joinToString("|")
}

/** Decoder for DNS-SD service names with decimal escape sequences. */
object BonjourEscapes {
  fun decode(
    input: String,
    policy: BonjourEscapePolicy,
  ): String =
    when (policy) {
      BonjourEscapePolicy.UTF8_BYTES -> decodeUtf8Bytes(input)
      BonjourEscapePolicy.UNICODE_SCALARS -> decodeUnicodeScalars(input)
    }

  private fun decodeUtf8Bytes(input: String): String {
    if (input.isEmpty()) return input

    val bytes = mutableListOf<Byte>()
    var index = 0
    while (index < input.length) {
      val escape = decimalEscapeAt(input, index)
      if (escape != null && escape in 0..255) {
        bytes += escape.toByte()
        index += 4
        continue
      }

      val nextIndex = nextCodePointEnd(input, index)
      bytes += input.substring(index, nextIndex).encodeToByteArray().toList()
      index = nextIndex
    }
    return bytes.toByteArray().decodeToString()
  }

  private fun decodeUnicodeScalars(input: String): String {
    if (input.isEmpty()) return input

    return buildString(input.length) {
      var index = 0
      while (index < input.length) {
        val escape = decimalEscapeAt(input, index)
        if (escape != null && escape.isUnicodeScalar()) {
          appendUnicodeScalar(escape)
          index += 4
        } else {
          append(input[index])
          index += 1
        }
      }
    }
  }

  private fun decimalEscapeAt(
    input: String,
    index: Int,
  ): Int? {
    if (input[index] != '\\' || index + 3 >= input.length) return null
    val digits = input.substring(index + 1, index + 4)
    return digits.takeIf { it.all(Char::isDigit) }?.toIntOrNull()
  }

  private fun Int.isUnicodeScalar(): Boolean = this in 0..0x10FFFF && this !in 0xD800..0xDFFF

  private fun StringBuilder.appendUnicodeScalar(codePoint: Int) {
    if (codePoint <= 0xFFFF) {
      append(codePoint.toChar())
      return
    }
    val surrogate = codePoint - 0x10000
    append(((surrogate shr 10) + 0xD800).toChar())
    append(((surrogate and 0x3FF) + 0xDC00).toChar())
  }

  private fun nextCodePointEnd(
    input: String,
    index: Int,
  ): Int =
    if (
      input[index].isHighSurrogate() &&
      index + 1 < input.length &&
      input[index + 1].isLowSurrogate()
    ) {
      index + 2
    } else {
      index + 1
    }
}

/** Validates user-supplied gateway headers without owning their storage or transport. */
object GatewayCustomHeaders {
  private val reservedNames = setOf("connection", "content-length", "host", "proxy-connection", "upgrade")
  private const val reservedPrefix = "sec-websocket-"
  private const val tokenPunctuation = "!#$%&'*+-.^_`|~"

  fun isReservedName(name: String): Boolean {
    val normalized = name.trim().lowercase()
    return normalized in reservedNames || normalized.startsWith(reservedPrefix)
  }

  fun sanitized(
    headers: Map<String, String>,
    valuePolicy: HeaderValuePolicy,
  ): Map<String, String> {
    val result = linkedMapOf<String, String>()
    for ((rawName, value) in headers) {
      val name = rawName.trim()
      if (name.isEmpty() || isReservedName(name) || !name.all(::isTokenCharacter)) continue
      if (!value.isAllowed(valuePolicy)) continue
      result[name] = value
    }
    return result
  }

  private fun isTokenCharacter(character: Char): Boolean =
    character in '0'..'9' ||
      character in 'A'..'Z' ||
      character in 'a'..'z' ||
      character in tokenPunctuation

  private fun String.isAllowed(policy: HeaderValuePolicy): Boolean =
    when (policy) {
      HeaderValuePolicy.ASCII_PRINTABLE -> all { it in ' '..'~' }
      HeaderValuePolicy.NO_CONTROL_CHARACTERS -> all { it.code !in 0..0x1F && it.code !in 0x7F..0x9F }
    }
}

/** Optional first-line JSON overrides for one Talk request. */
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

/** Parsed directive plus the utterance text after removing the directive line. */
data class TalkDirectiveParseResult(
  val directive: TalkDirective?,
  val stripped: String,
  val unknownKeys: List<String>,
)

/** Preserves platform-specific parsing contracts at the shared parser boundary. */
data class TalkDirectiveParsingOptions(
  val discardLeadingBlankLines: Boolean,
  val acceptsDecimalNumbersForIntegers: Boolean,
)

object TalkDirectiveParser {
  val androidOptions = TalkDirectiveParsingOptions(
    discardLeadingBlankLines = false,
    acceptsDecimalNumbersForIntegers = false,
  )
  val appleOptions = TalkDirectiveParsingOptions(
    discardLeadingBlankLines = true,
    acceptsDecimalNumbersForIntegers = true,
  )

  fun parse(
    text: String,
    options: TalkDirectiveParsingOptions = androidOptions,
  ): TalkDirectiveParseResult {
    val normalized = text.replace("\r\n", "\n")
    val lines = normalized.split("\n").toMutableList()
    if (lines.isEmpty()) return TalkDirectiveParseResult(null, text, emptyList())

    var firstNonEmpty = lines.indexOfFirst { it.trim().isNotEmpty() }
    if (firstNonEmpty == -1) return TalkDirectiveParseResult(null, text, emptyList())
    if (options.discardLeadingBlankLines && firstNonEmpty > 0) {
      lines.subList(0, firstNonEmpty).clear()
      firstNonEmpty = 0
    }

    val head = lines[firstNonEmpty].trim()
    if (!head.startsWith("{") || !head.endsWith("}")) return TalkDirectiveParseResult(null, text, emptyList())
    val objectValue = parseJsonObject(head) ?: return TalkDirectiveParseResult(null, text, emptyList())

    val speakerBoost =
      boolValue(objectValue, listOf("speaker_boost", "speakerBoost"))
        ?: boolValue(objectValue, listOf("no_speaker_boost", "noSpeakerBoost"))?.not()
    val directive =
      TalkDirective(
        voiceId = stringValue(objectValue, listOf("voice", "voice_id", "voiceId")),
        modelId = stringValue(objectValue, listOf("model", "model_id", "modelId")),
        speed = doubleValue(objectValue, listOf("speed")),
        rateWpm = intValue(objectValue, listOf("rate", "wpm"), options),
        stability = doubleValue(objectValue, listOf("stability")),
        similarity = doubleValue(objectValue, listOf("similarity", "similarity_boost", "similarityBoost")),
        style = doubleValue(objectValue, listOf("style")),
        speakerBoost = speakerBoost,
        seed = longValue(objectValue, listOf("seed"), options),
        normalize = stringValue(objectValue, listOf("normalize", "apply_text_normalization")),
        language = stringValue(objectValue, listOf("lang", "language_code", "language")),
        outputFormat = stringValue(objectValue, listOf("output_format", "format")),
        latencyTier = intValue(objectValue, listOf("latency", "latency_tier", "latencyTier"), options),
        once = boolValue(objectValue, listOf("once")),
      )
    if (!directive.hasValue()) return TalkDirectiveParseResult(null, text, emptyList())

    val knownKeys = setOf(
      "voice", "voice_id", "voiceid", "model", "model_id", "modelid", "speed", "rate", "wpm",
      "stability", "similarity", "similarity_boost", "similarityboost", "style", "speaker_boost",
      "speakerboost", "no_speaker_boost", "nospeakerboost", "seed", "normalize",
      "apply_text_normalization", "lang", "language_code", "language", "output_format", "format",
      "latency", "latency_tier", "latencytier", "once",
    )
    val unknownKeys = objectValue.keys.filter { it.lowercase() !in knownKeys }.sorted()

    lines.removeAt(firstNonEmpty)
    if (firstNonEmpty < lines.size && lines[firstNonEmpty].trim().isEmpty()) {
      lines.removeAt(firstNonEmpty)
    }
    return TalkDirectiveParseResult(directive, lines.joinToString("\n"), unknownKeys)
  }

  private fun parseJsonObject(line: String): JsonObject? =
    runCatching { coreJson.parseToJsonElement(line) as? JsonObject }.getOrNull()

  private fun stringValue(objectValue: JsonObject, keys: List<String>): String? =
    keys.firstNotNullOfOrNull { key -> objectValue.valueForKey(key).asStringOrNull()?.trim()?.ifEmpty { null } }

  private fun doubleValue(objectValue: JsonObject, keys: List<String>): Double? =
    keys.firstNotNullOfOrNull { key -> objectValue.valueForKey(key).asDoubleOrNull() }

  private fun intValue(
    objectValue: JsonObject,
    keys: List<String>,
    options: TalkDirectiveParsingOptions,
  ): Int? = keys.firstNotNullOfOrNull { key -> objectValue.valueForKey(key).asIntOrNull(options) }

  private fun longValue(
    objectValue: JsonObject,
    keys: List<String>,
    options: TalkDirectiveParsingOptions,
  ): Long? = keys.firstNotNullOfOrNull { key -> objectValue.valueForKey(key).asLongOrNull(options) }

  private fun boolValue(objectValue: JsonObject, keys: List<String>): Boolean? =
    keys.firstNotNullOfOrNull { key -> objectValue.valueForKey(key).asBooleanOrNull() }

  private fun JsonObject.valueForKey(key: String): JsonElement? =
    this[key] ?: entries.firstOrNull { it.key.equals(key, ignoreCase = true) }?.value

  private fun TalkDirective.hasValue(): Boolean =
    listOf(
      voiceId, modelId, speed, rateWpm, stability, similarity, style, speakerBoost, seed, normalize,
      language, outputFormat, latencyTier, once,
    ).any { it != null }
}

private fun JsonElement?.asStringOrNull(): String? = (this as? JsonPrimitive)?.takeIf { it.isString }?.content

private fun JsonElement?.asDoubleOrNull(): Double? = (this as? JsonPrimitive)?.content?.toDoubleOrNull()

private fun JsonElement?.asIntOrNull(options: TalkDirectiveParsingOptions): Int? {
  val content = (this as? JsonPrimitive)?.content ?: return null
  return content.toIntOrNull() ?: options.takeIf { it.acceptsDecimalNumbersForIntegers }?.let { content.toDoubleOrNull()?.toInt() }
}

private fun JsonElement?.asLongOrNull(options: TalkDirectiveParsingOptions): Long? {
  val content = (this as? JsonPrimitive)?.content ?: return null
  return content.toLongOrNull() ?: options.takeIf { it.acceptsDecimalNumbersForIntegers }?.let { content.toDoubleOrNull()?.toLong() }
}

private fun JsonElement?.asBooleanOrNull(): Boolean? =
  when ((this as? JsonPrimitive)?.content?.trim()?.lowercase()) {
    "true", "yes", "1" -> true
    "false", "no", "0" -> false
    else -> null
  }

/**
 * Stable Apple entry points. The Swift facade owns native value types and never exposes generated
 * Kotlin declarations to application code.
 */
object MobileCoreBridge {
  fun decodeBonjourEscapesForApple(input: String): String =
    BonjourEscapes.decode(input, BonjourEscapePolicy.UNICODE_SCALARS)

  fun isReservedGatewayHeaderName(name: String): Boolean = GatewayCustomHeaders.isReservedName(name)

  fun sanitizeGatewayHeadersForApple(headersJson: String): String {
    val headers = runCatching { coreJson.decodeFromString<Map<String, String>>(headersJson) }.getOrDefault(emptyMap())
    return coreJson.encodeToString(GatewayCustomHeaders.sanitized(headers, HeaderValuePolicy.NO_CONTROL_CHARACTERS))
  }

  fun parseTalkDirectiveForApple(text: String): TalkDirectiveParseResult =
    TalkDirectiveParser.parse(text, TalkDirectiveParser.appleOptions)
}
