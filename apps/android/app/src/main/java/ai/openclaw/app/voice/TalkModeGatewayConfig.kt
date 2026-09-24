package ai.openclaw.app.voice

import ai.openclaw.app.i18n.NativeText
import ai.openclaw.app.i18n.nativeText
import ai.openclaw.app.isAndroidRealtimeRelayModelSupported
import ai.openclaw.app.normalizeMainKey
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import java.util.Locale

internal enum class TalkModeRoute {
  RealtimeRelay,
  NativeConfigured,
  NativeAndroidFallback,
  NativeGatewayFallback,
  ;

  val description: NativeText?
    get() =
      when (this) {
        RealtimeRelay -> null
        NativeConfigured -> nativeText("Native Talk: using device speech recognition and configured Talk voice.")
        NativeAndroidFallback -> nativeText("Native Talk: Gateway did not advertise GPT-Live relay support; using device speech recognition and configured Talk voice.")
        NativeGatewayFallback -> nativeText("Native Talk: Gateway relay is unavailable for this configuration; using device speech recognition and configured Talk voice.")
      }
}

internal data class TalkModeGatewayConfigState(
  val mainSessionKey: String,
  val speechLocale: String?,
  val interruptOnSpeech: Boolean?,
  val silenceTimeoutMs: Long,
  val route: TalkModeRoute,
) {
  val realtimeRelayModelSupported: Boolean get() = route == TalkModeRoute.RealtimeRelay
}

internal object TalkModeGatewayConfigParser {
  /** Reads gateway talk/session config into the runtime state TalkMode needs. */
  fun parse(config: JsonObject?): TalkModeGatewayConfigState {
    val talk = config?.get("talk").asObjectOrNull()
    // talk.config carries the top-level model (plus voice-model default) in
    // realtime.model, but a provider-level providers.<id>.model is NOT promoted
    // into it — fall back to the selected provider's entry so a gpt-live model
    // without a Gateway relay hint still takes the legacy native Talk route.
    val realtime = talk?.get("realtime").asObjectOrNull()
    val realtimeProvider = realtime?.get("provider").asStringOrNull()
    val realtimeClientHints =
      config
        ?.get("clientHints")
        .asObjectOrNull()
        ?.get("realtime")
        .asObjectOrNull()
    val realtimeModel =
      realtime?.get("model").asStringOrNull()
        ?: realtimeProvider?.let { provider ->
          realtime
            ?.get("providers")
            .asObjectOrNull()
            ?.get(provider)
            .asObjectOrNull()
            ?.get("model")
            .asStringOrNull()
        }
    val sessionCfg = config?.get("session").asObjectOrNull()
    return TalkModeGatewayConfigState(
      mainSessionKey = normalizeMainKey(sessionCfg?.get("mainKey").asStringOrNull()),
      speechLocale = normalizeSpeechLocaleTag(talk?.get("speechLocale").asStringOrNull()),
      interruptOnSpeech = talk?.get("interruptOnSpeech").asBooleanOrNull(),
      silenceTimeoutMs = resolvedSilenceTimeoutMs(talk),
      // gateway-relay carries only realtime sessions; stt-tts runs as native Talk
      // (device STT, chat.send, talk.speak) so the configured Talk voice is used.
      route =
        when {
          realtime?.get("mode").asStringOrNull() == "stt-tts" -> TalkModeRoute.NativeConfigured
          realtimeClientHints?.get("gatewayRelaySupported").asBooleanOrNull() == true -> TalkModeRoute.RealtimeRelay
          realtimeClientHints?.get("gatewayRelaySupported").asBooleanOrNull() == false -> TalkModeRoute.NativeGatewayFallback
          !isAndroidRealtimeRelayModelSupported(realtimeModel) -> TalkModeRoute.NativeAndroidFallback
          else -> TalkModeRoute.RealtimeRelay
        },
    )
  }

  /** Accepts only numeric whole-millisecond silence timeouts; malformed config uses defaults. */
  fun resolvedSilenceTimeoutMs(talk: JsonObject?): Long {
    val fallback = TalkDefaults.defaultSilenceTimeoutMs
    val primitive = talk?.get("silenceTimeoutMs") as? JsonPrimitive ?: return fallback
    if (primitive.isString) return fallback
    val timeout = primitive.content.toDoubleOrNull() ?: return fallback
    if (timeout <= 0 || timeout % 1.0 != 0.0 || timeout > Long.MAX_VALUE.toDouble()) {
      return fallback
    }
    return timeout.toLong()
  }
}

private fun JsonElement?.asStringOrNull(): String? =
  this
    ?.let { element ->
      element as? JsonPrimitive
    }?.contentOrNull

private fun JsonElement?.asBooleanOrNull(): Boolean? {
  val primitive = this as? JsonPrimitive ?: return null
  return primitive.booleanOrNull
}

private fun JsonElement?.asObjectOrNull(): JsonObject? = this as? JsonObject

internal fun normalizeSpeechLocaleTag(value: String?): String? {
  val candidate =
    value
      ?.trim()
      ?.replace('_', '-')
      ?.takeIf(String::isNotEmpty)
      ?: return null
  val locale = Locale.forLanguageTag(candidate)
  return locale
    .toLanguageTag()
    .takeIf { tag -> locale.language.isNotBlank() && tag != "und" }
}

internal fun realtimeTranscriptionLanguage(localeTag: String?): String? =
  localeTag
    ?.let(Locale::forLanguageTag)
    ?.language
    ?.lowercase(Locale.ROOT)
    ?.takeIf { language ->
      language.length == ISO_639_1_LANGUAGE_LENGTH &&
        language.all { character -> character in 'a'..'z' }
    }

internal fun resolveRealtimeTranscriptionLanguageHint(
  configuredLocaleTag: String?,
  requestedLanguage: String?,
  deviceLocaleTag: String?,
): String? =
  realtimeTranscriptionLanguage(
    configuredLocaleTag
      ?: requestedLanguage
      ?: deviceLocaleTag,
  )

private const val ISO_639_1_LANGUAGE_LENGTH = 2
