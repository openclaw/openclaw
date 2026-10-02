package ai.openclaw.app.voice

import ai.openclaw.app.gateway.GatewaySession
import kotlinx.coroutines.CancellationException
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.encodeToJsonElement
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.put

/** Decoded talk.speak audio bytes plus provider metadata needed for Android playback. */
internal data class TalkSpeakAudio(
  val bytes: ByteArray,
  val outputFormat: String?,
  val mimeType: String?,
  val fileExtension: String?,
)

internal sealed interface TalkSpeakResult {
  data class Success(
    val audio: TalkSpeakAudio,
  ) : TalkSpeakResult

  /** Provider or config absence allows Android local TTS to handle the reply. */
  data class FallbackToLocal(
    val message: String,
  ) : TalkSpeakResult

  /** Request, payload, or audio errors that should stay visible to the caller. */
  data class Failure(
    val message: String,
  ) : TalkSpeakResult
}

internal interface TalkSpeechSynthesizing {
  suspend fun synthesize(
    text: String,
    directive: TalkDirective?,
  ): TalkSpeakResult
}

/** Gateway RPC client for talk.speak with local-TTS fallback classification. */
internal class TalkSpeakClient(
  private val session: GatewaySession? = null,
  private val json: Json = Json { ignoreUnknownKeys = true },
  private val requestDetailed: (suspend (String, String, Long) -> GatewaySession.RpcResult)? = null,
) : TalkSpeechSynthesizing {
  override suspend fun synthesize(
    text: String,
    directive: TalkDirective?,
  ): TalkSpeakResult {
    val response =
      try {
        performRequest(
          method = "talk.speak",
          paramsJson =
            json.encodeToString(
              buildJsonObject {
                put("text", text)
                json.encodeToJsonElement(directive ?: TalkDirective()).jsonObject.forEach { (name, value) -> put(name, value) }
              },
            ),
          timeoutMs = 45_000,
        )
      } catch (err: CancellationException) {
        throw err
      } catch (err: Throwable) {
        return TalkSpeakResult.Failure(err.message ?: "talk.speak request failed")
      }
    if (!response.ok) {
      val error = response.error
      val message = error?.message ?: "talk.speak request failed"
      return if (isFallbackEligible(error)) {
        TalkSpeakResult.FallbackToLocal(message)
      } else {
        TalkSpeakResult.Failure(message)
      }
    }
    val payload =
      try {
        json.decodeFromString<TalkSpeakResponse>(response.payloadJson ?: "")
      } catch (err: Throwable) {
        return TalkSpeakResult.Failure(err.message ?: "talk.speak payload invalid")
      }
    val bytes =
      try {
        android.util.Base64.decode(payload.audioBase64, android.util.Base64.DEFAULT)
      } catch (err: Throwable) {
        return TalkSpeakResult.Failure(err.message ?: "talk.speak audio decode failed")
      }
    if (bytes.isEmpty()) {
      return TalkSpeakResult.Failure("talk.speak returned empty audio")
    }
    return TalkSpeakResult.Success(
      TalkSpeakAudio(
        bytes = bytes,
        outputFormat = payload.outputFormat,
        mimeType = payload.mimeType,
        fileExtension = payload.fileExtension,
      ),
    )
  }

  private fun isFallbackEligible(error: GatewaySession.ErrorShape?): Boolean {
    val reason = error?.details?.reason
    if (reason == null) return true
    // Only provider/config absence should fall back to Android TTS; payload and
    // transport errors should stay visible to the caller.
    return reason == "talk_unconfigured" ||
      reason == "talk_provider_unsupported" ||
      reason == "method_unavailable"
  }

  private suspend fun performRequest(
    method: String,
    paramsJson: String,
    timeoutMs: Long,
  ): GatewaySession.RpcResult {
    requestDetailed?.let { return it(method, paramsJson, timeoutMs) }
    val activeSession = session ?: throw IllegalStateException("session missing")
    return activeSession.requestDetailed(method = method, paramsJson = paramsJson, timeoutMs = timeoutMs)
  }
}

@Serializable
private data class TalkSpeakResponse(
  val audioBase64: String,
  val provider: String,
  val outputFormat: String? = null,
  val voiceCompatible: Boolean? = null,
  val mimeType: String? = null,
  val fileExtension: String? = null,
)
