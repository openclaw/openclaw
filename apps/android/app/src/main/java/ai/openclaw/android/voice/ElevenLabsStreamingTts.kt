package ai.openclaw.android.voice

import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioTrack
import android.util.Base64
import android.util.Log
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import okhttp3.*
import org.json.JSONObject
import kotlin.math.max

/**
 * Streams text chunks to ElevenLabs WebSocket API and plays audio in real-time.
 *
 * Usage:
 *   1. Create instance with voice/API config
 *   2. Call [start] to open WebSocket + AudioTrack
 *   3. Call [sendText] with incremental text chunks as they arrive
 *   4. Call [finish] when the full response is ready (sends EOS to ElevenLabs)
 *   5. Call [stop] to cancel/cleanup at any time
 *
 * Audio playback begins as soon as the first audio chunk arrives from ElevenLabs,
 * typically within ~100ms of the first text chunk for eleven_flash_v2_5.
 *
 * Note: eleven_v3 does NOT support WebSocket streaming. Use eleven_flash_v2_5
 * or eleven_flash_v2 for lowest latency.
 */
class ElevenLabsStreamingTts(
  private val scope: CoroutineScope,
  private val voiceId: String,
  private val apiKey: String,
  private val modelId: String = "eleven_flash_v2_5",
  private val outputFormat: String = "pcm_24000",
  private val sampleRate: Int = 24000,
) {
  companion object {
    private const val TAG = "ElevenLabsStreamTTS"
    private const val BASE_URL = "wss://api.elevenlabs.io/v1/text-to-speech"

    /** Models that support WebSocket input streaming */
    val STREAMING_MODELS = setOf(
      "eleven_flash_v2_5",
      "eleven_flash_v2",
      "eleven_multilingual_v2",
      "eleven_turbo_v2_5",
      "eleven_turbo_v2",
      "eleven_monolingual_v1",
    )

    fun supportsStreaming(modelId: String): Boolean = modelId in STREAMING_MODELS
  }

  private val _isPlaying = MutableStateFlow(false)
  val isPlaying: StateFlow<Boolean> = _isPlaying

  private var webSocket: WebSocket? = null
  private var audioTrack: AudioTrack? = null
  private var trackStarted = false
  private var client: OkHttpClient? = null
  @Volatile private var stopped = false
  @Volatile private var finished = false
  @Volatile var hasReceivedAudio = false
    private set
  private var drainJob: Job? = null

  // Track text already sent so we only send incremental chunks
  private var sentTextLength = 0
  @Volatile private var wsReady = false
  private val pendingText = mutableListOf<String>()

  /**
   * Open the WebSocket connection and prepare AudioTrack.
   * Must be called before [sendText].
   */
  fun start() {
    stopped = false
    finished = false
    hasReceivedAudio = false
    sentTextLength = 0
    trackStarted = false
    wsReady = false
    sentFullText = ""
    synchronized(pendingText) { pendingText.clear() }

    // Prepare AudioTrack
    val minBuffer = AudioTrack.getMinBufferSize(
      sampleRate,
      AudioFormat.CHANNEL_OUT_MONO,
      AudioFormat.ENCODING_PCM_16BIT,
    )
    val bufferSize = max(minBuffer * 2, 8 * 1024)
    val track = AudioTrack(
      AudioAttributes.Builder()
        .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
        .setUsage(AudioAttributes.USAGE_MEDIA)
        .build(),
      AudioFormat.Builder()
        .setSampleRate(sampleRate)
        .setChannelMask(AudioFormat.CHANNEL_OUT_MONO)
        .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
        .build(),
      bufferSize,
      AudioTrack.MODE_STREAM,
      AudioManager.AUDIO_SESSION_ID_GENERATE,
    )
    if (track.state != AudioTrack.STATE_INITIALIZED) {
      track.release()
      Log.e(TAG, "AudioTrack init failed")
      return
    }
    audioTrack = track
    _isPlaying.value = true

    // Open WebSocket
    val url = "$BASE_URL/$voiceId/stream-input?model_id=$modelId&output_format=$outputFormat"
    val okClient = OkHttpClient.Builder()
      .readTimeout(30, java.util.concurrent.TimeUnit.SECONDS)
      .writeTimeout(10, java.util.concurrent.TimeUnit.SECONDS)
      .build()
    client = okClient

    val request = Request.Builder()
      .url(url)
      .header("xi-api-key", apiKey)
      .build()

    webSocket = okClient.newWebSocket(request, object : WebSocketListener() {
      override fun onOpen(webSocket: WebSocket, response: Response) {
        Log.d(TAG, "WebSocket connected")
        // Send initial config with voice settings
        val config = JSONObject().apply {
          put("text", " ")
          put("voice_settings", JSONObject().apply {
            put("stability", 0.5)
            put("similarity_boost", 0.8)
            put("use_speaker_boost", false)
          })
          put("generation_config", JSONObject().apply {
            put("chunk_length_schedule", org.json.JSONArray(listOf(120, 160, 250, 290)))
          })
        }
        webSocket.send(config.toString())
        wsReady = true
        // Flush any text that was queued before WebSocket was ready
        synchronized(pendingText) {
          for (queued in pendingText) {
            val msg = JSONObject().apply { put("text", queued) }
            webSocket.send(msg.toString())
            Log.d(TAG, "flushed queued chunk: ${queued.length} chars")
          }
          pendingText.clear()
        }
        // Send deferred EOS if finish() was called before WebSocket was ready
        if (finished) {
          val eos = JSONObject().apply { put("text", "") }
          webSocket.send(eos.toString())
          Log.d(TAG, "sent deferred EOS")
        }
      }

      override fun onMessage(webSocket: WebSocket, text: String) {
        if (stopped) return
        try {
          val json = JSONObject(text)
          val audio = json.optString("audio", "")
          if (audio.isNotEmpty()) {
            val pcmBytes = Base64.decode(audio, Base64.DEFAULT)
            writeToTrack(pcmBytes)
          }
        } catch (e: Exception) {
          Log.e(TAG, "Error parsing WebSocket message: ${e.message}")
        }
      }

      override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
        Log.e(TAG, "WebSocket error: ${t.message}")
        stopped = true
        cleanup()
      }

      override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
        Log.d(TAG, "WebSocket closed: $code $reason")
        // Wait for AudioTrack to finish playing buffered audio, then cleanup
        drainJob = scope.launch(Dispatchers.IO) {
          drainAudioTrack()
          cleanup()
        }
      }
    })
  }

  /**
   * Send incremental text. Call with the full accumulated text so far —
   * only the new portion (since last send) will be transmitted.
   */
  // Track the full text we've sent so we can detect replacement vs append
  private var sentFullText = ""

  /**
      // If we already sent a superset of this text, it's just a stale/out-of-order
      // event from a different thread — not a real divergence. Ignore it.
      if (sentFullText.startsWith(fullText)) return true
   * Returns true if text was accepted, false if text diverged (caller should restart).
   */
  @Synchronized
  fun sendText(fullText: String): Boolean {
    if (stopped) return false
    if (finished) return true  // Already finishing — not a diverge, don't restart

    // Detect text replacement: if the new text doesn't start with what we already sent,
    // the stream has diverged (e.g., tool call interrupted and text was replaced).
    if (sentFullText.isNotEmpty() && !fullText.startsWith(sentFullText)) {
      // If we already sent a superset of this text, it's just a stale/out-of-order
      // event from a different thread — not a real divergence. Ignore it.
      if (sentFullText.startsWith(fullText)) return true
      Log.d(TAG, "text diverged — sent='${sentFullText.take(60)}' new='${fullText.take(60)}'")
      return false
    }

    if (fullText.length > sentTextLength) {
      val newText = fullText.substring(sentTextLength)
      sentTextLength = fullText.length
      sentFullText = fullText

      val ws = webSocket
      if (ws != null && wsReady) {
        val msg = JSONObject().apply { put("text", newText) }
        ws.send(msg.toString())
        Log.d(TAG, "sent chunk: ${newText.length} chars")
      } else {
        // Queue if WebSocket not connected yet (ws null = still connecting, wsReady false = handshake pending)
        synchronized(pendingText) { pendingText.add(newText) }
        Log.d(TAG, "queued chunk: ${newText.length} chars (ws not ready)")
      }
    }
    return true
  }

  /**
   * Signal that no more text is coming. Sends EOS to ElevenLabs.
   * The WebSocket will close after generating remaining audio.
   */
  @Synchronized
  fun finish() {
    if (stopped || finished) return
    finished = true
    val ws = webSocket
    if (ws != null && wsReady) {
      // Send empty text to signal end of stream
      val eos = JSONObject().apply { put("text", "") }
      ws.send(eos.toString())
      Log.d(TAG, "sent EOS")
    }
    // else: WebSocket not ready yet; onOpen will send EOS after flushing queued text
  }

  /**
   * Immediately stop playback and close everything.
   */
  fun stop() {
    stopped = true
    finished = true
    drainJob?.cancel()
    drainJob = null
    webSocket?.cancel()
    webSocket = null
    val track = audioTrack
    audioTrack = null
    if (track != null) {
      try {
        track.pause()
        track.flush()
        track.release()
      } catch (_: Throwable) {}
    }
    _isPlaying.value = false
    client?.dispatcher?.executorService?.shutdown()
    client = null
  }

  private fun writeToTrack(pcmBytes: ByteArray) {
    val track = audioTrack ?: return
    if (stopped) return

    // Start playback on first audio chunk — avoids underrun
    if (!trackStarted) {
      track.play()
      trackStarted = true
      hasReceivedAudio = true
      Log.d(TAG, "AudioTrack started on first chunk")
    }

    var offset = 0
    while (offset < pcmBytes.size && !stopped) {
      val wrote = track.write(pcmBytes, offset, pcmBytes.size - offset)
      if (wrote <= 0) {
        if (stopped) return
        Log.w(TAG, "AudioTrack write returned $wrote")
        break
      }
      offset += wrote
    }
  }

  private fun drainAudioTrack() {
    if (stopped) return
    // Wait up to 10s for audio to finish playing
    val deadline = System.currentTimeMillis() + 10_000
    while (!stopped && System.currentTimeMillis() < deadline) {
      // Check if track is still playing
      val track = audioTrack ?: return
      if (track.playState != AudioTrack.PLAYSTATE_PLAYING) return
      try {
        Thread.sleep(100)
      } catch (_: InterruptedException) {
        return
      }
    }
  }

  private fun cleanup() {
    val track = audioTrack
    audioTrack = null
    if (track != null) {
      try {
        track.stop()
        track.release()
      } catch (_: Throwable) {}
    }
    _isPlaying.value = false
    client?.dispatcher?.executorService?.shutdown()
    client = null
  }
}
