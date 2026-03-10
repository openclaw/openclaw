package ai.openclaw.android.voice

import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioTrack
import android.util.Log
import com.k2fsa.sherpa.onnx.GeneratedAudio
import com.k2fsa.sherpa.onnx.OfflineTts
import com.k2fsa.sherpa.onnx.OfflineTtsConfig
import com.k2fsa.sherpa.onnx.OfflineTtsModelConfig
import com.k2fsa.sherpa.onnx.OfflineTtsVitsModelConfig
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.File

/**
 * Wrapper for sherpa-onnx OfflineTts for offline text-to-speech synthesis.
 * Provides local TTS capabilities without requiring network connectivity.
 *
 * This class uses the official sherpa-onnx Kotlin API.
 * The native library provides OfflineTts for text-to-speech synthesis.
 */
class SherpaOnnxTts(
  private val modelDir: File,
  private val modelName: String,
) {
  companion object {
    private const val TAG = "SherpaOnnxTts"

    // Audio parameters
    private const val DEFAULT_SAMPLE_RATE = 22050
    private const val CHANNELS = 1 // Mono
  }

  // Sherpa-onnx TTS instance
  private var tts: OfflineTts? = null

  // Playback
  private var audioTrack: AudioTrack? = null
  private var playbackJob: Job? = null
  private var stopRequested = false

  // State
  private val _isSpeaking = MutableStateFlow(false)
  val isSpeaking: StateFlow<Boolean> = _isSpeaking

  private val _speakingText = MutableStateFlow<String?>(null)
  val speakingText: StateFlow<String?> = _speakingText

  // Callbacks
  var onStart: (() -> Unit)? = null
  var onComplete: (() -> Unit)? = null
  var onError: ((Throwable) -> Unit)? = null

  // Voice settings
  var speed: Float = 1.0f
    set(value) {
      field = value.coerceIn(0.5f, 2.0f)
    }

  var speakerId: Int = 0
    set(value) {
      field = value.coerceAtLeast(0)
    }

  suspend fun initialize(): Boolean = withContext(Dispatchers.IO) {
    try {
      Log.d(TAG, "Initializing TTS with model: $modelName")

      val modelPath = File(modelDir, "tts/$modelName").absolutePath
      val config = createTtsConfig(modelPath)

      tts = OfflineTts(assetManager = null, config = config)

      Log.d(TAG, "TTS initialized successfully")
      true
    } catch (e: Throwable) {
      Log.e(TAG, "Failed to initialize TTS", e)
      onError?.invoke(e)
      false
    }
  }

  private fun createTtsConfig(modelPath: String): OfflineTtsConfig {
    // For vits-zh-hf or similar:
    val vitsModelConfig = OfflineTtsVitsModelConfig(
      model = "$modelPath/model.onnx",
      tokens = "$modelPath/tokens.txt",
      dataDir = "",  // Empty string means use model directory
    )

    val modelConfig = OfflineTtsModelConfig(
      vits = vitsModelConfig,
      numThreads = 4,
      debug = true,
      provider = "cpu",
    )

    // For vits-icefall-zh-aishell3, we need to include rule FST files
    val ruleFsts = "$modelPath/date.fst,$modelPath/number.fst,$modelPath/phone.fst,$modelPath/new_heteronym.fst"
    val ruleFars = "$modelPath/rule.far"

    return OfflineTtsConfig(
      model = modelConfig,
      ruleFsts = ruleFsts,
      ruleFars = ruleFars,
      maxNumSentences = 1,
    )
  }

  /**
   * Synthesize and speak text
   */
  suspend fun speak(
    text: String,
    scope: CoroutineScope,
  ): Boolean = withContext(Dispatchers.IO) {
    try {
      if (_isSpeaking.value) {
        Log.w(TAG, "Already speaking, stopping current speech")
        stop()
      }

      if (text.isBlank()) {
        Log.w(TAG, "Empty text provided")
        return@withContext false
      }

      Log.d(TAG, "Speaking: ${text.take(100)}...")
      _speakingText.value = text
      _isSpeaking.value = true
      stopRequested = false

      // Generate audio
      val audio = tts?.generate(text = text, sid = speakerId, speed = speed)
      if (audio == null || audio.samples.isEmpty()) {
        throw IllegalStateException("Failed to generate audio")
      }

      Log.d(TAG, "Audio generated: ${audio.samples.size} samples")

      // Start playback
      playbackJob = scope.launch(Dispatchers.Main) {
        try {
          playAudio(audio)
        } catch (e: Throwable) {
          Log.e(TAG, "Playback failed", e)
          onError?.invoke(e)
          _isSpeaking.value = false
          _speakingText.value = null
        }
      }

      true
    } catch (e: Throwable) {
      Log.e(TAG, "Failed to speak", e)
      onError?.invoke(e)
      _isSpeaking.value = false
      _speakingText.value = null
      false
    }
  }

  private suspend fun playAudio(audio: GeneratedAudio) = withContext(Dispatchers.Main) {
    val sampleRate = audio.sampleRate

    val minBufferSize = AudioTrack.getMinBufferSize(
      sampleRate,
      AudioFormat.CHANNEL_OUT_MONO,
      AudioFormat.ENCODING_PCM_16BIT,
    )

    if (minBufferSize <= 0) {
      throw IllegalStateException("Invalid buffer size: $minBufferSize")
    }

    val bufferSize = maxOf(minBufferSize * 2, 8192)

    audioTrack = AudioTrack.Builder()
      .setAudioAttributes(
        AudioAttributes.Builder()
          .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
          .setUsage(AudioAttributes.USAGE_ASSISTANT)
          .build(),
      )
      .setAudioFormat(
        AudioFormat.Builder()
          .setSampleRate(sampleRate)
          .setChannelMask(AudioFormat.CHANNEL_OUT_MONO)
          .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
          .build(),
      )
      .setBufferSizeInBytes(bufferSize)
      .setTransferMode(AudioTrack.MODE_STREAM)
      .setSessionId(AudioManager.AUDIO_SESSION_ID_GENERATE)
      .build()

    if (audioTrack?.state != AudioTrack.STATE_INITIALIZED) {
      throw IllegalStateException("AudioTrack initialization failed")
    }

    onStart?.invoke()

    audioTrack?.play()
    Log.d(TAG, "Playback started")

    try {
      // Convert float samples to PCM16
      val pcmData = convertFloatToPcm16(audio.samples)

      var offset = 0
      val writeBuffer = ByteArray(bufferSize)

      while (offset < pcmData.size && !stopRequested) {
        val chunkSize = minOf(bufferSize, pcmData.size - offset)
        System.arraycopy(pcmData, offset, writeBuffer, 0, chunkSize)

        val written = audioTrack?.write(writeBuffer, 0, chunkSize) ?: -1
        if (written < 0) {
          throw IllegalStateException("AudioTrack write failed: $written")
        }

        offset += written

        // Small delay to prevent buffer underrun
        delay(10)
      }

      // Wait for playback to complete
      if (!stopRequested) {
        delay(100) // Allow buffer to drain
      }
    } finally {
      audioTrack?.stop()
      audioTrack?.release()
      audioTrack = null

      _isSpeaking.value = false
      _speakingText.value = null

      if (!stopRequested) {
        onComplete?.invoke()
      }

      Log.d(TAG, "Playback completed")
    }
  }

  private fun convertFloatToPcm16(floatSamples: FloatArray): ByteArray {
    val pcmData = ByteArray(floatSamples.size * 2)
    for (i in floatSamples.indices) {
      // Clamp to [-1, 1] and convert to 16-bit PCM
      val clamped = floatSamples[i].coerceIn(-1f, 1f)
      val sample = (clamped * 32767f).toInt().toShort()
      pcmData[i * 2] = (sample.toInt() and 0xFF).toByte()
      pcmData[i * 2 + 1] = ((sample.toInt() shr 8) and 0xFF).toByte()
    }
    return pcmData
  }

  /**
   * Stop current speech
   */
  fun stop() {
    Log.d(TAG, "Stopping speech")
    stopRequested = true
    playbackJob?.cancel()
    playbackJob = null

    audioTrack?.apply {
      if (playState == AudioTrack.PLAYSTATE_PLAYING) {
        pause()
        flush()
      }
      release()
    }
    audioTrack = null

    _isSpeaking.value = false
    _speakingText.value = null
  }

  /**
   * Generate audio without playing
   */
  fun generateAudioFile(text: String): ByteArray? {
    val audio = tts?.generate(text = text, sid = speakerId, speed = speed) ?: return null
    return convertFloatToPcm16(audio.samples)
  }

  /**
   * Get TTS properties
   */
  fun getSampleRate(): Int {
    return tts?.sampleRate() ?: DEFAULT_SAMPLE_RATE
  }

  fun getNumSpeakers(): Int {
    return tts?.numSpeakers() ?: 1
  }

  fun release() {
    Log.d(TAG, "Releasing TTS")
    stop()

    tts?.release()
    tts = null

    onStart = null
    onComplete = null
    onError = null
  }
}
