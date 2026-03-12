package ai.openclaw.app.voice

import java.net.HttpURLConnection
import java.net.URL
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

internal data class ElevenLabsVoice(val voiceId: String, val name: String?)

internal data class TalkModeResolvedVoice(
  val voiceId: String?,
  val fallbackVoiceId: String?,
  val defaultVoiceId: String?,
  val currentVoiceId: String?,
  val selectedVoiceName: String? = null,
)

internal object TalkModeVoiceResolver {
  fun resolveVoiceAlias(value: String?, voiceAliases: Map<String, String>): String? {
    val trimmed = value?.trim().orEmpty()
    if (trimmed.isEmpty()) return null
    val normalized = normalizeAliasKey(trimmed)
    voiceAliases[normalized]?.let { return it }
    if (voiceAliases.values.any { it.equals(trimmed, ignoreCase = true) }) return trimmed
    return if (isLikelyVoiceId(trimmed)) trimmed else null
  }

  suspend fun resolveVoiceId(
    preferred: String?,
    fallbackVoiceId: String?,
    defaultVoiceId: String?,
    currentVoiceId: String?,
    voiceOverrideActive: Boolean,
    listVoices: suspend () -> List<ElevenLabsVoice>,
  ): TalkModeResolvedVoice {
    val trimmed = preferred?.trim().orEmpty()
    if (trimmed.isNotEmpty()) {
      return TalkModeResolvedVoice(
        voiceId = trimmed,
        fallbackVoiceId = fallbackVoiceId,
        defaultVoiceId = defaultVoiceId,
        currentVoiceId = currentVoiceId,
      )
    }
    if (!fallbackVoiceId.isNullOrBlank()) {
      return TalkModeResolvedVoice(
        voiceId = fallbackVoiceId,
        fallbackVoiceId = fallbackVoiceId,
        defaultVoiceId = defaultVoiceId,
        currentVoiceId = currentVoiceId,
      )
    }

    val first = listVoices().firstOrNull()
    if (first == null) {
      return TalkModeResolvedVoice(
        voiceId = null,
        fallbackVoiceId = fallbackVoiceId,
        defaultVoiceId = defaultVoiceId,
        currentVoiceId = currentVoiceId,
      )
    }

    return TalkModeResolvedVoice(
      voiceId = first.voiceId,
      fallbackVoiceId = first.voiceId,
      defaultVoiceId = if (defaultVoiceId.isNullOrBlank()) first.voiceId else defaultVoiceId,
      currentVoiceId = if (voiceOverrideActive) currentVoiceId else first.voiceId,
      selectedVoiceName = first.name,
    )
  }

  suspend fun listVoices(apiKey: String, json: Json): List<ElevenLabsVoice> {
    return withContext(Dispatchers.IO) {
      val url = URL("https://api.elevenlabs.io/v1/voices")
      val conn = url.openConnection() as HttpURLConnection
      conn.requestMethod = "GET"
      conn.connectTimeout = 15_000
      conn.readTimeout = 15_000
      conn.setRequestProperty("xi-api-key", apiKey)

      val code = conn.responseCode
      val stream = if (code >= 400) conn.errorStream else conn.inputStream
      val data = stream.readBytes()
      if (code >= 400) {
        val message = data.toString(Charsets.UTF_8)
        throw IllegalStateException("ElevenLabs voices failed: $code $message")
      }

      val root = json.parseToJsonElement(data.toString(Charsets.UTF_8)).asObjectOrNull()
      val voices = (root?.get("voices") as? JsonArray) ?: JsonArray(emptyList())
      voices.mapNotNull { entry ->
        val obj = entry.asObjectOrNull() ?: return@mapNotNull null
        val voiceId = obj["voice_id"].asStringOrNull() ?: return@mapNotNull null
        val name = obj["name"].asStringOrNull()
        ElevenLabsVoice(voiceId, name)
      }
    }
  }

  private fun isLikelyVoiceId(value: String): Boolean {
    if (value.length < 10) return false
    return value.all { it.isLetterOrDigit() || it == '-' || it == '_' }
  }

  private fun normalizeAliasKey(value: String): String =
    value.trim().lowercase()
}

private fun JsonElement?.asObjectOrNull(): JsonObject? = this as? JsonObject

private fun JsonElement?.asStringOrNull(): String? =
  (this as? JsonPrimitive)?.takeIf { it.isString }?.content
