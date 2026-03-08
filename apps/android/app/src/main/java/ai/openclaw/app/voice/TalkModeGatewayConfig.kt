package ai.openclaw.app.voice

import ai.openclaw.app.normalizeMainKey
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull

internal data class TalkModeGatewayConfigState(
  val activeProvider: String,
  val normalizedPayload: Boolean,
  val missingResolvedPayload: Boolean,
  val mainSessionKey: String,
  val defaultVoiceId: String?,
  val voiceAliases: Map<String, String>,
  val defaultModelId: String,
  val defaultOutputFormat: String,
  val apiKey: String?,
  val interruptOnSpeech: Boolean?,
  val silenceTimeoutMs: Long,
)

internal object TalkModeGatewayConfigParser {
  fun parse(
    config: JsonObject?,
    defaultProvider: String,
    defaultModelIdFallback: String,
    defaultOutputFormatFallback: String,
    envVoice: String?,
    sagVoice: String?,
    envKey: String?,
  ): TalkModeGatewayConfigState {
    val talk = config?.get("talk").asObjectOrNull()
    val selection = TalkModeManager.selectTalkProviderConfig(talk)
    val activeProvider = selection?.provider ?: defaultProvider
    val activeConfig = selection?.config
    val sessionCfg = config?.get("session").asObjectOrNull()
    val mainKey = normalizeMainKey(sessionCfg?.get("mainKey").asStringOrNull())
    val voice = activeConfig?.get("voiceId")?.asStringOrNull()?.trim()?.takeIf { it.isNotEmpty() }
    val aliases =
      activeConfig?.get("voiceAliases").asObjectOrNull()?.entries?.mapNotNull { (key, value) ->
        val id = value.asStringOrNull()?.trim()?.takeIf { it.isNotEmpty() } ?: return@mapNotNull null
        normalizeTalkAliasKey(key).takeIf { it.isNotEmpty() }?.let { it to id }
      }?.toMap().orEmpty()
    val model = activeConfig?.get("modelId")?.asStringOrNull()?.trim()?.takeIf { it.isNotEmpty() }
    val outputFormat =
      activeConfig?.get("outputFormat")?.asStringOrNull()?.trim()?.takeIf { it.isNotEmpty() }
    val key = activeConfig?.get("apiKey")?.asStringOrNull()?.trim()?.takeIf { it.isNotEmpty() }
    val interrupt = talk?.get("interruptOnSpeech")?.asBooleanOrNull()
    val silenceTimeoutMs = TalkModeManager.resolvedSilenceTimeoutMs(talk)

    return TalkModeGatewayConfigState(
      activeProvider = activeProvider,
      normalizedPayload = selection?.normalizedPayload == true,
      missingResolvedPayload = talk != null && selection == null,
      mainSessionKey = mainKey,
      defaultVoiceId =
        if (activeProvider == defaultProvider) {
          voice ?: envVoice?.takeIf { it.isNotEmpty() } ?: sagVoice?.takeIf { it.isNotEmpty() }
        } else {
          voice
        },
      voiceAliases = aliases,
      defaultModelId = model ?: defaultModelIdFallback,
      defaultOutputFormat = outputFormat ?: defaultOutputFormatFallback,
      apiKey = key ?: envKey?.takeIf { it.isNotEmpty() },
      interruptOnSpeech = interrupt,
      silenceTimeoutMs = silenceTimeoutMs,
    )
  }

  fun fallback(
    defaultProvider: String,
    defaultModelIdFallback: String,
    defaultOutputFormatFallback: String,
    envVoice: String?,
    sagVoice: String?,
    envKey: String?,
  ): TalkModeGatewayConfigState =
    TalkModeGatewayConfigState(
      activeProvider = defaultProvider,
      normalizedPayload = false,
      missingResolvedPayload = false,
      mainSessionKey = "main",
      defaultVoiceId = envVoice?.takeIf { it.isNotEmpty() } ?: sagVoice?.takeIf { it.isNotEmpty() },
      voiceAliases = emptyMap(),
      defaultModelId = defaultModelIdFallback,
      defaultOutputFormat = defaultOutputFormatFallback,
      apiKey = envKey?.takeIf { it.isNotEmpty() },
      interruptOnSpeech = null,
      silenceTimeoutMs = TalkDefaults.defaultSilenceTimeoutMs,
    )
}

private fun normalizeTalkAliasKey(value: String): String =
  value.trim().lowercase()

private fun JsonElement?.asStringOrNull(): String? =
  this?.let { element ->
    element as? JsonPrimitive
  }?.contentOrNull

private fun JsonElement?.asBooleanOrNull(): Boolean? {
  val primitive = this as? JsonPrimitive ?: return null
  return primitive.booleanOrNull
}

private fun JsonElement?.asObjectOrNull(): JsonObject? =
  this as? JsonObject
