package ai.openclaw.app.chat

import ai.openclaw.app.gateway.GatewaySession
import ai.openclaw.app.voice.LocalSpeechSpeaking
import ai.openclaw.app.voice.TalkAudioPlaying
import ai.openclaw.app.voice.TalkSpeakAudio
import android.util.Log
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.util.concurrent.atomic.AtomicLong

private const val TAG = "MessageSpeech"

internal enum class MessageSpeechPhase {
  Preparing,
  Speaking,
  Failed,
}

/** Listen state; a failed request remains retryable without claiming audio or microphone use. */
internal data class MessageSpeechState(
  val messageId: String,
  val phase: MessageSpeechPhase,
) {
  val isActive: Boolean
    get() = phase != MessageSpeechPhase.Failed
}

/** Renders message text to an audio clip; null means fall back to local TTS. */
internal fun interface MessageSpeechSynthesizing {
  suspend fun synthesize(text: String): TalkSpeakAudio?
}

/** Gateway tts.speak client using the general configured TTS provider chain. */
internal class MessageSpeechClient(
  private val requestDetailed: suspend (String, String, Long) -> GatewaySession.RpcResult,
  private val json: Json = Json { ignoreUnknownKeys = true },
) : MessageSpeechSynthesizing {
  override suspend fun synthesize(text: String): TalkSpeakAudio? {
    val response =
      runCatchingCancellable {
        requestDetailed(
          "tts.speak",
          buildJsonObject { put("text", text) }.toString(),
          60_000,
        )
      }.getOrElse { err ->
        Log.d(TAG, "tts.speak request failed: ${err.message ?: err::class.simpleName}")
        return null
      }
    if (!response.ok) {
      // Provider/config absence and older gateways both degrade to the on-device voice.
      Log.d(TAG, "tts.speak unavailable: ${response.error?.message ?: "unknown error"}")
      return null
    }
    val payload =
      try {
        json.decodeFromString<TtsSpeakResponse>(response.payloadJson ?: "")
      } catch (err: Throwable) {
        Log.d(TAG, "tts.speak payload invalid: ${err.message ?: err::class.simpleName}")
        return null
      }
    val bytes =
      try {
        android.util.Base64.decode(payload.audioBase64, android.util.Base64.DEFAULT)
      } catch (err: Throwable) {
        Log.d(TAG, "tts.speak audio decode failed: ${err.message ?: err::class.simpleName}")
        return null
      }
    if (bytes.isEmpty()) return null
    return TalkSpeakAudio(
      bytes = bytes,
      outputFormat = payload.outputFormat,
      mimeType = payload.mimeType,
      fileExtension = payload.fileExtension,
    )
  }
}

@Serializable
private data class TtsSpeakResponse(
  val audioBase64: String,
  val provider: String,
  val outputFormat: String? = null,
  val mimeType: String? = null,
  val fileExtension: String? = null,
)

/** Drives one active chat Listen request, preferring gateway audio over local TTS. */
internal class MessageSpeechController(
  private val scope: CoroutineScope,
  private val synthesizer: MessageSpeechSynthesizing,
  private val player: TalkAudioPlaying,
  private val localSpeech: LocalSpeechSpeaking,
) {
  private val _state = MutableStateFlow<MessageSpeechState?>(null)
  val state: StateFlow<MessageSpeechState?> = _state.asStateFlow()

  // A superseded playback's completion must not clear state owned by the next request.
  private val generation = AtomicLong(0)
  private var job: Job? = null

  fun toggle(
    messageId: String,
    text: String,
  ) {
    if (_state.value?.let { it.messageId == messageId && it.isActive } == true) {
      stop()
      return
    }
    start(messageId = messageId, text = text)
  }

  fun stop() {
    generation.incrementAndGet()
    job?.cancel()
    job = null
    player.stop()
    localSpeech.stop()
    _state.value = null
  }

  private fun start(
    messageId: String,
    text: String,
  ) {
    stop()
    val spoken = text.trim()
    if (spoken.isEmpty()) return
    val token = generation.incrementAndGet()
    _state.value = MessageSpeechState(messageId = messageId, phase = MessageSpeechPhase.Preparing)
    job =
      scope.launch {
        try {
          val clip = synthesizer.synthesize(spoken)
          if (generation.get() != token) return@launch
          _state.value = MessageSpeechState(messageId = messageId, phase = MessageSpeechPhase.Speaking)
          if (!playClip(clip) && generation.get() == token) {
            localSpeech.speak(spoken)
          }
        } catch (err: CancellationException) {
          throw err
        } catch (err: Throwable) {
          Log.w(TAG, "local speech failed: ${err.message ?: err::class.simpleName}")
          if (generation.get() == token) _state.value = MessageSpeechState(messageId, MessageSpeechPhase.Failed)
        } finally {
          if (generation.get() == token && _state.value?.isActive == true) _state.value = null
        }
      }
  }

  private suspend fun playClip(clip: TalkSpeakAudio?): Boolean {
    if (clip == null) return false
    return runCatchingCancellable {
      player.play(clip)
      true
    }.getOrElse { err ->
      Log.w(TAG, "clip playback failed: ${err.message ?: err::class.simpleName}")
      false
    }
  }
}
