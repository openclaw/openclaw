package ai.openclaw.android.voice

import android.content.Context
import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioTrack
import android.util.Log
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.io.ByteArrayOutputStream
import java.io.File
import java.net.HttpURLConnection
import java.net.URL

/**
 * Remote Speech Service that connects to Whisper.cpp ASR and Edge TTS servers.
 *
 * Server deployment:
 * 1. Deploy to ub22: ./scripts/deploy-edge-tts.sh
 * 2. Services run at:
 *    - Whisper ASR: http://ub22:10801
 *    - Edge TTS: http://ub22:10802
 */
class RemoteSpeechService(
  private val context: Context,
  private val scope: CoroutineScope,
  private val config: RemoteSpeechConfig,
) {
  companion object {
    private const val TAG = "RemoteSpeechService"
    private const val CONNECT_TIMEOUT = 10000
    private const val READ_TIMEOUT = 60000
    private const val SAMPLE_RATE = 16000
  }

  private val json = Json { ignoreUnknownKeys = true }

  // Service state
  private val _isConnected = MutableStateFlow(false)
  val isConnected: StateFlow<Boolean> = _isConnected

  private val _isInitializing = MutableStateFlow(false)
  val isInitializing: StateFlow<Boolean> = _isInitializing

  private val _statusText = MutableStateFlow("Disconnected")
  val statusText: StateFlow<String> = _statusText

  // Recognition state
  private var isRecognizing = false
  private var currentTranscript = ""

  // Callbacks
  var onPartialResult: ((String) -> Unit)? = null
  var onFinalResult: ((String) -> Unit)? = null
  var onError: ((Throwable) -> Unit)? = null

  // TTS state
  private var audioTrack: AudioTrack? = null
  private var isPlaying = false

  var onTtsComplete: (() -> Unit)? = null
  var onTtsError: ((Throwable) -> Unit)? = null

  /**
   * Check if remote services are available
   */
  suspend fun checkConnection(): Boolean = withContext(Dispatchers.IO) {
    try {
      _isInitializing.value = true
      _statusText.value = "Checking connection..."

      // Check Whisper ASR
      val whisperUrl = "${config.whisperBaseUrl}/health"
      val whisperOk = checkEndpoint(whisperUrl)

      // Check Edge TTS
      val edgeTtsUrl = "${config.edgeTtsBaseUrl}/health"
      val edgeTtsOk = checkEndpoint(edgeTtsUrl)

      _isConnected.value = whisperOk || edgeTtsOk

      _statusText.value = when {
        whisperOk && edgeTtsOk -> "Ready (Whisper + Edge TTS)"
        whisperOk -> "Ready (Whisper ASR only)"
        edgeTtsOk -> "Ready (Edge TTS only)"
        else -> "Services unavailable"
      }

      Log.d(TAG, "Connection check: Whisper=$whisperOk, EdgeTTS=$edgeTtsOk")
      _isConnected.value
    } catch (e: Throwable) {
      Log.e(TAG, "Connection check failed", e)
      _statusText.value = "Connection failed: ${e.message}"
      _isConnected.value = false
      false
    } finally {
      _isInitializing.value = false
    }
  }

  private fun checkEndpoint(urlString: String): Boolean {
    return try {
      val url = URL(urlString)
      val conn = url.openConnection() as HttpURLConnection
      conn.connectTimeout = CONNECT_TIMEOUT
      conn.readTimeout = READ_TIMEOUT
      conn.requestMethod = "GET"
      val responseCode = conn.responseCode
      conn.disconnect()
      responseCode == HttpURLConnection.HTTP_OK
    } catch (e: Throwable) {
      Log.w(TAG, "Endpoint check failed for $urlString: ${e.message}")
      false
    }
  }

  /**
   * Send audio to Whisper ASR server and get transcription
   */
  suspend fun transcribeAudio(audioData: ByteArray): String? = withContext(Dispatchers.IO) {
    try {
      val url = URL("${config.whisperBaseUrl}/inference")
      val boundary = "----WebKitFormBoundary${System.currentTimeMillis()}"

      val requestBody = buildMultipartBody(audioData, boundary)

      val conn = url.openConnection() as HttpURLConnection
      conn.connectTimeout = CONNECT_TIMEOUT
      conn.readTimeout = READ_TIMEOUT
      conn.requestMethod = "POST"
      conn.doInput = true
      conn.doOutput = true
      conn.setRequestProperty("Content-Type", "multipart/form-data; boundary=$boundary")

      conn.outputStream.use { os -> os.write(requestBody) }

      val responseCode = conn.responseCode
      if (responseCode != HttpURLConnection.HTTP_OK) {
        throw Exception("Whisper ASR error: HTTP $responseCode")
      }

      val response = conn.inputStream.bufferedReader().use { it.readText() }
      conn.disconnect()

      // Parse response - Whisper server returns JSON with "text" field
      val result = json.parseToJsonElement(response)
      val text = result.asObjectOrNull()?.get("text")?.asStringOrNull()

      Log.d(TAG, "Transcription result: ${text?.take(50)}...")
      text
    } catch (e: Throwable) {
      Log.e(TAG, "Transcription failed", e)
      onError?.invoke(e)
      null
    }
  }

  private fun buildMultipartBody(audioData: ByteArray, boundary: String): ByteArray {
    val lineEnding = "\r\n"
    val body = StringBuilder()

    // Add file part
    body.append("--$boundary$lineEnding")
    body.append("Content-Disposition: form-data; name=\"file\"; filename=\"audio.wav\"$lineEnding")
    body.append("Content-Type: audio/wav$lineEnding")
    body.append(lineEnding)

    val headerBytes = body.toString().toByteArray(Charsets.UTF_8)
    val footerBytes = (lineEnding + "--$boundary--$lineEnding").toByteArray(Charsets.UTF_8)

    // Combine header, audio data, and footer
    return ByteArrayOutputStream().apply {
      write(headerBytes)
      write(audioData)
      write(footerBytes)
    }.toByteArray()
  }

  /**
   * Convert text to speech using Edge TTS server
   */
  suspend fun synthesizeSpeech(text: String): Boolean = withContext(Dispatchers.IO) {
    try {
      Log.d(TAG, "Synthesizing speech for: ${text.take(50)}...")

      val url = URL("${config.edgeTtsBaseUrl}/synthesize")
      val requestBody = buildJsonObject {
        put("text", text)
        put("voice", "zh-CN-XiaoxiaoNeural")
      }

      val conn = url.openConnection() as HttpURLConnection
      conn.connectTimeout = CONNECT_TIMEOUT
      conn.readTimeout = READ_TIMEOUT
      conn.requestMethod = "POST"
      conn.doInput = true
      conn.doOutput = true
      conn.setRequestProperty("Content-Type", "application/json")

      conn.outputStream.use { os ->
        os.write(requestBody.toString().toByteArray(Charsets.UTF_8))
      }

      val responseCode = conn.responseCode
      if (responseCode != HttpURLConnection.HTTP_OK) {
        val errorBody = conn.errorStream?.bufferedReader()?.use { it.readText() }
        throw Exception("Edge TTS error: HTTP $responseCode - $errorBody")
      }

      // Get audio data (MP3 format)
      val audioData = conn.inputStream.readBytes()
      conn.disconnect()

      Log.d(TAG, "Received ${audioData.size} bytes of audio data")

      // Play audio
      withContext(Dispatchers.Main) {
        playAudio(audioData)
      }

      true
    } catch (e: Throwable) {
      Log.e(TAG, "Speech synthesis failed", e)
      onTtsError?.invoke(e)
      false
    }
  }

  private fun playAudio(audioData: ByteArray) {
    try {
      val minBufferSize = AudioTrack.getMinBufferSize(
        SAMPLE_RATE,
        AudioFormat.CHANNEL_OUT_MONO,
        AudioFormat.ENCODING_PCM_16BIT,
      )

      val audioFormat = AudioFormat.Builder()
        .setSampleRate(SAMPLE_RATE)
        .setChannelMask(AudioFormat.CHANNEL_OUT_MONO)
        .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
        .build()

      val audioAttributes = AudioAttributes.Builder()
        .setUsage(AudioAttributes.USAGE_MEDIA)
        .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
        .build()

      audioTrack = AudioTrack(
        audioAttributes,
        audioFormat,
        audioData.size,
        AudioTrack.MODE_STATIC,
        AudioManager.AUDIO_SESSION_ID_GENERATE,
      )

      audioTrack?.write(audioData, 0, audioData.size)
      audioTrack?.play()
      isPlaying = true

      // Wait for playback to complete
      scope.launch {
        while (isPlaying && audioTrack?.playState == AudioTrack.PLAYSTATE_PLAYING) {
          kotlinx.coroutines.delay(100)
        }
        audioTrack?.release()
        audioTrack = null
        isPlaying = false
        onTtsComplete?.invoke()
      }
    } catch (e: Throwable) {
      Log.e(TAG, "Audio playback failed", e)
      onTtsError?.invoke(e)
    }
  }

  fun stopPlayback() {
    try {
      audioTrack?.stop()
      audioTrack?.release()
      audioTrack = null
      isPlaying = false
    } catch (e: Throwable) {
      Log.e(TAG, "Stop playback failed", e)
    }
  }

  fun release() {
    Log.d(TAG, "Releasing remote speech service")
    stopPlayback()
    isRecognizing = false
    currentTranscript = ""
    onPartialResult = null
    onFinalResult = null
    onError = null
    onTtsComplete = null
    onTtsError = null
    _isConnected.value = false
    _statusText.value = "Released"
  }
}

/**
 * Configuration for remote speech services
 */
data class RemoteSpeechConfig(
  val whisperBaseUrl: String,
  val edgeTtsBaseUrl: String,
) {
  companion object {
    /**
     * Default configuration for ub22 server (192.168.0.107)
     */
    fun default(): RemoteSpeechConfig {
      return RemoteSpeechConfig(
        whisperBaseUrl = "http://192.168.0.107:10801",
        edgeTtsBaseUrl = "http://192.168.0.107:10802",
      )
    }

    /**
     * Create custom configuration
     */
    fun create(
      whisperHost: String,
      whisperPort: Int,
      edgeTtsHost: String,
      edgeTtsPort: Int,
    ): RemoteSpeechConfig {
      return RemoteSpeechConfig(
        whisperBaseUrl = "http://$whisperHost:$whisperPort",
        edgeTtsBaseUrl = "http://$edgeTtsHost:$edgeTtsPort",
      )
    }
  }
}

// JSON parsing helpers
private fun kotlinx.serialization.json.JsonElement?.asObjectOrNull(): kotlinx.serialization.json.JsonObject? =
  this as? kotlinx.serialization.json.JsonObject

private fun kotlinx.serialization.json.JsonElement?.asStringOrNull(): String? =
  (this as? kotlinx.serialization.json.JsonPrimitive)?.takeIf { it.isString }?.content
