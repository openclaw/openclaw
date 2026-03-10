package ai.openclaw.android.voice

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioRecord
import android.media.AudioTrack
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import android.util.Log
import androidx.core.content.ContextCompat
import ai.openclaw.android.gateway.GatewaySession
import ai.openclaw.android.isCanonicalMainSessionKey
import ai.openclaw.android.normalizeMainKey
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlin.math.max
import java.io.ByteArrayOutputStream
import java.util.UUID

/**
 * TalkModeManager with hybrid speech support:
 * - sherpa-onnx for offline ASR/TTS (preferred when available)
 * - RemoteSpeechService for Whisper ASR + Edge TTS (fallback)
 * - System TTS as last resort
 */
class TalkModeManagerSherpa(
  private val context: Context,
  private val scope: CoroutineScope,
  private val session: GatewaySession,
  private val supportsChatSubscribe: Boolean,
  private val isConnected: () -> Boolean,
) {
  companion object {
    private const val TAG = "TalkMode"
    private const val SILENCE_WINDOW_MS = 700L
  }

  private val mainHandler = Handler(Looper.getMainLooper())
  private val json = Json { ignoreUnknownKeys = true }

  // State flows
  private val _isEnabled = MutableStateFlow(false)
  val isEnabled: StateFlow<Boolean> = _isEnabled

  private val _isListening = MutableStateFlow(false)
  val isListening: StateFlow<Boolean> = _isListening

  private val _isSpeaking = MutableStateFlow(false)
  val isSpeaking: StateFlow<Boolean> = _isSpeaking

  private val _statusText = MutableStateFlow("Off")
  val statusText: StateFlow<String> = _statusText

  private val _lastAssistantText = MutableStateFlow<String?>(null)
  val lastAssistantText: StateFlow<String?> = _lastAssistantText

  private val _usingFallbackTts = MutableStateFlow(false)
  val usingFallbackTts: StateFlow<Boolean> = _usingFallbackTts

  private val _sherpaInitializing = MutableStateFlow(false)
  val sherpaInitializing: StateFlow<Boolean> = _sherpaInitializing

  // sherpa-onnx manager
  private var sherpaManager: SherpaOnnxManager? = null
  private var useSherpa: Boolean = false

  // Remote speech service (Whisper ASR + Edge TTS)
  private var remoteService: RemoteSpeechService? = null
  private var useRemoteService: Boolean = false

  // Audio recording for remote ASR
  private var audioRecord: android.media.AudioRecord? = null
  private var recordingJob: Job? = null
  private var isRecording = false
  private var audioBuffer = ByteArrayOutputStream()

  // Recognition state
  private var stopRequested = false
  private var listeningMode = false
  private var silenceJob: Job? = null
  private var lastTranscript: String = ""
  private var lastHeardAtMs: Long? = null
  private var lastSpokenText: String? = null
  private var lastInterruptedAtSeconds: Double? = null

  // TTS state
  private var systemTts: TextToSpeech? = null
  private var systemTtsPending: CompletableDeferred<Unit>? = null
  private var systemTtsPendingId: String? = null

  // Chat state
  private var mainSessionKey: String = "main"
  private var pendingRunId: String? = null
  private var pendingFinal: CompletableDeferred<Boolean>? = null
  private var chatSubscribedSessionKey: String? = null

  // Settings
  private var interruptOnSpeech: Boolean = true
  private var voiceAliases: Map<String, String> = emptyMap()

  // TTS settings
  private var ttsSpeed: Float = 1.0f
  private var ttsSpeakerId: Int = 0

  fun setMainSessionKey(sessionKey: String?) {
    val trimmed = sessionKey?.trim().orEmpty()
    if (trimmed.isEmpty()) return
    if (isCanonicalMainSessionKey(mainSessionKey)) return
    mainSessionKey = trimmed
  }

  /**
   * Initialize sherpa-onnx for offline ASR and TTS
   */
  suspend fun initializeSherpa(
    asrModel: String? = null,
    ttsModel: String? = null,
  ): Boolean {
    if (_sherpaInitializing.value) return false

    return try {
      _sherpaInitializing.value = true
      _statusText.value = "Initializing offline speech..."

      sherpaManager = SherpaOnnxManager(context, scope)
      val initialized = sherpaManager!!.initialize(asrModel, ttsModel)

      if (initialized) {
        useSherpa = true
        useRemoteService = false
        _statusText.value = "Ready (offline)"

        // Setup callbacks
        sherpaManager?.recognizer?.apply {
          onPartialResult = { text -> handlePartialTranscript(text) }
          onFinalResult = { text -> handleFinalTranscript(text) }
          onError = { err -> Log.e(TAG, "ASR error", err) }
        }

        sherpaManager?.tts?.apply {
          onStart = { Log.d(TAG, "TTS started") }
          onComplete = { _isSpeaking.value = false }
          onError = { err -> Log.e(TAG, "TTS error", err) }
        }

        Log.d(TAG, "sherpa-onnx initialized successfully")
      } else {
        _statusText.value = "Offline speech unavailable"
        useSherpa = false
        // Try remote service as fallback
        initializeRemoteService()
      }

      initialized
    } catch (e: Throwable) {
      Log.e(TAG, "Failed to initialize sherpa-onnx", e)
      _statusText.value = "Offline speech failed"
      useSherpa = false
      // Try remote service as fallback
      scope.launch { initializeRemoteService() }
      false
    } finally {
      _sherpaInitializing.value = false
    }
  }

  /**
   * Initialize remote speech service (Whisper ASR + Edge TTS)
   */
  private suspend fun initializeRemoteService() {
    try {
      Log.d(TAG, "Initializing remote speech service...")
      val config = RemoteSpeechConfig.default()
      remoteService = RemoteSpeechService(context, scope, config)

      val connected = remoteService?.checkConnection() ?: false
      if (connected) {
        useRemoteService = true
        _statusText.value = "Ready (Whisper + Edge TTS)"

        // Setup callbacks
        remoteService?.onPartialResult = { text -> handlePartialTranscript(text) }
        remoteService?.onFinalResult = { text -> handleFinalTranscript(text) }
        remoteService?.onError = { err -> Log.e(TAG, "Remote ASR error", err) }
        remoteService?.onTtsComplete = { _isSpeaking.value = false }
        remoteService?.onTtsError = { err -> Log.e(TAG, "Remote TTS error", err) }

        Log.d(TAG, "Remote speech service initialized successfully")
      } else {
        useRemoteService = false
        _statusText.value = "Remote speech unavailable"
      }
    } catch (e: Throwable) {
      Log.e(TAG, "Failed to initialize remote speech service", e)
      useRemoteService = false
    }
  }

  fun setEnabled(enabled: Boolean) {
    if (_isEnabled.value == enabled) return
    _isEnabled.value = enabled
    if (enabled) {
      Log.d(TAG, "enabled")
      // Check which speech service is available
      when {
        useSherpa -> {
          _statusText.value = "Ready (offline)"
          Log.d(TAG, "Talk Mode enabled with sherpa-onnx")
        }
        useRemoteService -> {
          _statusText.value = "Ready (Whisper + Edge TTS)"
          Log.d(TAG, "Talk Mode enabled with remote speech")
        }
        else -> {
          // Try to initialize remote service on-demand
          scope.launch {
            _statusText.value = "Initializing remote speech..."
            initializeRemoteService()
            if (!useRemoteService) {
              _statusText.value = "Ready（系统 TTS）"
              Log.d(TAG, "Talk Mode enabled with system TTS fallback")
            }
          }
        }
      }
    } else {
      Log.d(TAG, "disabled")
      stop()
    }
  }

  fun handleGatewayEvent(event: String, payloadJson: String?) {
    if (event != "chat") return
    if (payloadJson.isNullOrBlank()) return
    val pending = pendingRunId ?: return
    val obj =
      try {
        json.parseToJsonElement(payloadJson).asObjectOrNull()
      } catch (_: Throwable) {
        null
      } ?: return
    val runId = obj["runId"].asStringOrNull() ?: return
    if (runId != pending) return
    val state = obj["state"].asStringOrNull() ?: return
    if (state == "final") {
      pendingFinal?.complete(true)
      pendingFinal = null
      pendingRunId = null
    }
  }

  private fun start() {
    mainHandler.post {
      if (_isListening.value) return@post
      stopRequested = false
      listeningMode = true
      Log.d(TAG, "start")

      val micOk =
        ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) ==
          PackageManager.PERMISSION_GRANTED
      if (!micOk) {
        _statusText.value = "Microphone permission required"
        Log.w(TAG, "microphone permission required")
        return@post
      }

      try {
        if (useSherpa && sherpaManager?.isAsrReady() == true) {
          // Use sherpa-onnx ASR
          scope.launch {
            val started = sherpaManager?.recognizer?.startRecognition(scope) ?: false
            if (started) {
              _statusText.value = "Listening"
              _isListening.value = true
              startSilenceMonitor()
              Log.d(TAG, "listening (sherpa-onnx)")
            } else {
              _statusText.value = "Recognition start failed"
            }
          }
        } else if (useRemoteService && remoteService != null) {
          // Use remote Whisper ASR - start recording audio
          _statusText.value = "Listening (Whisper)"
          _isListening.value = true
          startRemoteRecording()
          Log.d(TAG, "listening (remote Whisper ASR)")
        } else {
          // No ASR available
          _statusText.value = "Speech recognition unavailable"
          Log.w(TAG, "no ASR available")
        }
      } catch (err: Throwable) {
        _statusText.value = "Start failed: ${err.message ?: err::class.simpleName}"
        Log.w(TAG, "start failed: ${err.message ?: err::class.simpleName}")
      }
    }
  }

  private fun stop() {
    stopRequested = true
    listeningMode = false
    silenceJob?.cancel()
    silenceJob = null
    lastTranscript = ""
    lastHeardAtMs = null
    _isListening.value = false
    _statusText.value = "Off"
    stopSpeaking()
    _usingFallbackTts.value = false
    chatSubscribedSessionKey = null

    sherpaManager?.recognizer?.stopRecognition()
    stopRemoteRecording()
    systemTts?.stop()
    systemTtsPending?.cancel()
    systemTtsPending = null
    systemTtsPendingId = null
  }

  /**
   * Start recording audio for remote Whisper ASR
   */
  private fun startRemoteRecording() {
    try {
      val sampleRate = 16000
      val channelConfig = AudioFormat.CHANNEL_IN_MONO
      val audioFormat = AudioFormat.ENCODING_PCM_16BIT
      val bufferSize = AudioRecord.getMinBufferSize(sampleRate, channelConfig, audioFormat) * 2

      audioRecord = AudioRecord(
        android.media.MediaRecorder.AudioSource.MIC,
        sampleRate,
        channelConfig,
        audioFormat,
        bufferSize
      )

      audioBuffer = ByteArrayOutputStream()
      isRecording = true

      recordingJob = scope.launch(Dispatchers.IO) {
        audioRecord?.startRecording()
        val buffer = ByteArray(bufferSize)

        while (isRecording && audioRecord?.recordingState == AudioRecord.RECORDSTATE_RECORDING) {
          val read = audioRecord?.read(buffer, 0, bufferSize) ?: -1
          if (read > 0) {
            audioBuffer.write(buffer, 0, read)
            lastHeardAtMs = SystemClock.elapsedRealtime()
          }
          delay(100)
        }

        audioRecord?.stop()
      }

      Log.d(TAG, "Remote recording started")
    } catch (e: Throwable) {
      Log.e(TAG, "Failed to start remote recording", e)
      _statusText.value = "Recording failed: ${e.message}"
    }
  }

  /**
   * Stop recording and send audio to Whisper ASR
   */
  private fun stopRemoteRecording() {
    try {
      isRecording = false
      recordingJob?.cancel()
      recordingJob = null

      if (audioRecord != null) {
        try {
          audioRecord?.stop()
          audioRecord?.release()
        } catch (_: Throwable) {
          // Ignore cleanup errors
        }
        audioRecord = null
      }

      // Send recorded audio to Whisper ASR
      val audioData = audioBuffer.toByteArray()
      if (audioData.isNotEmpty()) {
        scope.launch(Dispatchers.IO) {
          try {
            _statusText.value = "Transcribing..."
            val result = remoteService?.transcribeAudio(audioData)
            if (!result.isNullOrBlank()) {
              handleFinalTranscript(result)
            }
          } catch (e: Throwable) {
            Log.e(TAG, "Transcription failed", e)
            _statusText.value = "Transcription failed"
          }
        }
      }

      audioBuffer.reset()
      Log.d(TAG, "Remote recording stopped")
    } catch (e: Throwable) {
      Log.e(TAG, "Failed to stop remote recording", e)
    }
  }

  private fun handlePartialTranscript(text: String) {
    if (_isSpeaking.value && interruptOnSpeech) {
      if (shouldInterrupt(text)) {
        stopSpeaking()
      }
      return
    }

    if (!_isListening.value) return

    if (text.isNotEmpty()) {
      lastTranscript = text
      lastHeardAtMs = SystemClock.elapsedRealtime()
    }
  }

  private fun handleFinalTranscript(text: String) {
    val trimmed = text.trim()
    if (trimmed.isEmpty()) return

    lastTranscript = trimmed
    lastHeardAtMs = SystemClock.elapsedRealtime()

    scope.launch {
      listeningMode = false
      _isListening.value = false
      _statusText.value = "Thinking…"

      reloadConfig()
      val prompt = buildPrompt(trimmed)
      if (!isConnected()) {
        _statusText.value = "Gateway not connected"
        Log.w(TAG, "finalize: gateway not connected")
        start()
        return@launch
      }

      try {
        val startedAt = System.currentTimeMillis().toDouble() / 1000.0
        subscribeChatIfNeeded(session = session, sessionKey = mainSessionKey)
        Log.d(TAG, "chat.send start sessionKey=${mainSessionKey.ifBlank { "main" }} chars=${prompt.length}")
        val runId = sendChat(prompt, session)
        Log.d(TAG, "chat.send ok runId=$runId")
        val ok = waitForChatFinal(runId)
        if (!ok) {
          Log.w(TAG, "chat final timeout runId=$runId; attempting history fallback")
        }
        val assistant = waitForAssistantText(session, startedAt, if (ok) 12_000 else 25_000)
        if (assistant.isNullOrBlank()) {
          _statusText.value = "No reply"
          Log.w(TAG, "assistant text timeout runId=$runId")
          start()
          return@launch
        }
        Log.d(TAG, "assistant text ok chars=${assistant.length}")
        playAssistant(assistant)
      } catch (err: Throwable) {
        _statusText.value = "Talk failed: ${err.message ?: err::class.simpleName}"
        Log.w(TAG, "finalize failed: ${err.message ?: err::class.simpleName}")
      }

      if (_isEnabled.value) {
        start()
      }
    }
  }

  private fun startSilenceMonitor() {
    silenceJob?.cancel()
    silenceJob =
      scope.launch {
        while (_isEnabled.value) {
          delay(200)
          checkSilence()
        }
      }
  }

  private fun checkSilence() {
    if (!_isListening.value) return

    // For remote Whisper ASR, check silence and trigger transcription
    if (useRemoteService && isRecording) {
      val lastHeard = lastHeardAtMs ?: return
      val elapsed = SystemClock.elapsedRealtime() - lastHeard
      if (elapsed >= SILENCE_WINDOW_MS) {
        // Silence detected, stop recording and transcribe
        scope.launch {
          stopRemoteRecording()
        }
        return
      }
    }

    // For sherpa-onnx, silence detection is handled internally
    // This is a fallback for when using the recognizer directly
    if (!useSherpa && !useRemoteService) {
      val transcript = lastTranscript.trim()
      if (transcript.isEmpty()) return
      val lastHeard = lastHeardAtMs ?: return
      val elapsed = SystemClock.elapsedRealtime() - lastHeard
      if (elapsed < SILENCE_WINDOW_MS) return
      scope.launch { finalizeTranscript(transcript) }
    }
  }

  private suspend fun finalizeTranscript(transcript: String) {
    // This is handled by handleFinalTranscript in sherpa-onnx
  }

  private suspend fun subscribeChatIfNeeded(session: GatewaySession, sessionKey: String) {
    if (!supportsChatSubscribe) return
    val key = sessionKey.trim()
    if (key.isEmpty()) return
    if (chatSubscribedSessionKey == key) return
    try {
      session.sendNodeEvent("chat.subscribe", """{"sessionKey":"$key"}""")
      chatSubscribedSessionKey = key
      Log.d(TAG, "chat.subscribe ok sessionKey=$key")
    } catch (err: Throwable) {
      Log.w(TAG, "chat.subscribe failed sessionKey=$key err=${err.message ?: err::class.java.simpleName}")
    }
  }

  private fun buildPrompt(transcript: String): String {
    val lines = mutableListOf(
      "Talk Mode active. Reply in a concise, spoken tone.",
    )
    lastInterruptedAtSeconds?.let {
      lines.add("Assistant speech interrupted at ${"%.1f".format(it)}s.")
      lastInterruptedAtSeconds = null
    }
    lines.add("")
    lines.add(transcript)
    return lines.joinToString("\n")
  }

  private suspend fun sendChat(message: String, session: GatewaySession): String {
    val runId = UUID.randomUUID().toString()
    val params =
      buildJsonObject {
        put("sessionKey", JsonPrimitive(mainSessionKey.ifBlank { "main" }))
        put("message", JsonPrimitive(message))
        put("thinking", JsonPrimitive("low"))
        put("timeoutMs", JsonPrimitive(30_000))
        put("idempotencyKey", JsonPrimitive(runId))
      }
    val res = session.request("chat.send", params.toString())
    val parsed = parseRunId(res) ?: runId
    if (parsed != runId) {
      pendingRunId = parsed
    }
    return parsed
  }

  private suspend fun waitForChatFinal(runId: String): Boolean {
    pendingFinal?.cancel()
    val deferred = CompletableDeferred<Boolean>()
    pendingRunId = runId
    pendingFinal = deferred

    val result =
      withContext(Dispatchers.IO) {
        try {
          kotlinx.coroutines.withTimeout(120_000) { deferred.await() }
        } catch (_: Throwable) {
          false
        }
      }

    if (!result) {
      pendingFinal = null
      pendingRunId = null
    }
    return result
  }

  private suspend fun waitForAssistantText(
    session: GatewaySession,
    sinceSeconds: Double,
    timeoutMs: Long,
  ): String? {
    val deadline = SystemClock.elapsedRealtime() + timeoutMs
    while (SystemClock.elapsedRealtime() < deadline) {
      val text = fetchLatestAssistantText(session, sinceSeconds)
      if (!text.isNullOrBlank()) return text
      delay(300)
    }
    return null
  }

  private suspend fun fetchLatestAssistantText(
    session: GatewaySession,
    sinceSeconds: Double? = null,
  ): String? {
    val key = mainSessionKey.ifBlank { "main" }
    val res = session.request("chat.history", "{\"sessionKey\":\"$key\"}")
    val root = json.parseToJsonElement(res).asObjectOrNull() ?: return null
    val messages = root["messages"] as? JsonArray ?: return null
    for (item in messages.reversed()) {
      val obj = item.asObjectOrNull() ?: continue
      if (obj["role"].asStringOrNull() != "assistant") continue
      if (sinceSeconds != null) {
        val timestamp = obj["timestamp"].asDoubleOrNull()
        if (timestamp != null && !isMessageTimestampAfter(timestamp, sinceSeconds)) continue
      }
      val content = obj["content"] as? JsonArray ?: continue
      val text =
        content.mapNotNull { entry ->
          entry.asObjectOrNull()?.get("text")?.asStringOrNull()?.trim()
        }.filter { it.isNotEmpty() }
      if (text.isNotEmpty()) return text.joinToString("\n")
    }
    return null
  }

  private suspend fun playAssistant(text: String) {
    val parsed = TalkDirectiveParser.parse(text)
    if (parsed.unknownKeys.isNotEmpty()) {
      Log.w(TAG, "Unknown talk directive keys: ${parsed.unknownKeys}")
    }
    val directive = parsed.directive
    val cleaned = parsed.stripped.trim()
    if (cleaned.isEmpty()) return
    _lastAssistantText.value = cleaned

    // Update TTS settings from directive
    directive?.speed?.let {
      ttsSpeed = (it / 175.0).toFloat().coerceIn(0.5f, 2.0f)
    }
    // speakerId is not part of TalkDirective, use default value

    _statusText.value = "Speaking…"
    _isSpeaking.value = true
    lastSpokenText = cleaned

    try {
      if (useSherpa && sherpaManager?.isTtsReady() == true) {
        // Use sherpa-onnx TTS
        _usingFallbackTts.value = false
        sherpaManager?.tts?.apply {
          this.speed = ttsSpeed
          this.speakerId = ttsSpeakerId
          speak(cleaned, scope)
        }
        Log.d(TAG, "sherpa-onnx TTS ok")
      } else if (useRemoteService && remoteService != null) {
        // Use remote Edge TTS
        _usingFallbackTts.value = false
        _statusText.value = "Speaking (Edge TTS)…"
        remoteService?.synthesizeSpeech(cleaned)
        Log.d(TAG, "remote Edge TTS ok")
      } else {
        // Fall back to system TTS
        _usingFallbackTts.value = true
        _statusText.value = "Speaking (System)…"
        speakWithSystemTts(cleaned)
      }
    } catch (err: Throwable) {
      Log.w(TAG, "speak failed: ${err.message ?: err::class.simpleName}; falling back to system voice")
      try {
        _usingFallbackTts.value = true
        _statusText.value = "Speaking (System)…"
        speakWithSystemTts(cleaned)
      } catch (fallbackErr: Throwable) {
        _statusText.value = "Speak failed: ${fallbackErr.message ?: fallbackErr::class.simpleName}"
        Log.w(TAG, "system voice failed: ${fallbackErr.message ?: fallbackErr::class.simpleName}")
      }
    }

    _isSpeaking.value = false
  }

  private suspend fun speakWithSystemTts(text: String) {
    val trimmed = text.trim()
    if (trimmed.isEmpty()) return
    val ok = ensureSystemTts()
    if (!ok) {
      throw IllegalStateException("system TTS unavailable")
    }

    val tts = systemTts ?: throw IllegalStateException("system TTS unavailable")
    val utteranceId = "talk-${UUID.randomUUID()}"
    val deferred = CompletableDeferred<Unit>()
    systemTtsPending?.cancel()
    systemTtsPending = deferred
    systemTtsPendingId = utteranceId

    withContext(Dispatchers.Main) {
      val params = Bundle()
      tts.speak(trimmed, TextToSpeech.QUEUE_FLUSH, params, utteranceId)
    }

    withContext(Dispatchers.IO) {
      try {
        kotlinx.coroutines.withTimeout(180_000) { deferred.await() }
      } catch (err: Throwable) {
        throw err
      }
    }
  }

  private suspend fun ensureSystemTts(): Boolean {
    if (systemTts != null) return true
    return withContext(Dispatchers.Main) {
      val deferred = CompletableDeferred<Boolean>()
      val tts =
        try {
          TextToSpeech(context) { status ->
            deferred.complete(status == TextToSpeech.SUCCESS)
          }
        } catch (_: Throwable) {
          deferred.complete(false)
          null
        }
      if (tts == null) return@withContext false

      tts.setOnUtteranceProgressListener(
        object : UtteranceProgressListener() {
          override fun onStart(utteranceId: String?) {}

          override fun onDone(utteranceId: String?) {
            if (utteranceId == null) return
            if (utteranceId != systemTtsPendingId) return
            systemTtsPending?.complete(Unit)
            systemTtsPending = null
            systemTtsPendingId = null
          }

          @Suppress("OVERRIDE_DEPRECATION")
          @Deprecated("Deprecated in Java")
          override fun onError(utteranceId: String?) {
            if (utteranceId == null) return
            if (utteranceId != systemTtsPendingId) return
            systemTtsPending?.completeExceptionally(IllegalStateException("system TTS error"))
            systemTtsPending = null
            systemTtsPendingId = null
          }

          override fun onError(utteranceId: String?, errorCode: Int) {
            if (utteranceId == null) return
            if (utteranceId != systemTtsPendingId) return
            systemTtsPending?.completeExceptionally(IllegalStateException("system TTS error $errorCode"))
            systemTtsPending = null
            systemTtsPendingId = null
          }
        },
      )

      val ok =
        try {
          deferred.await()
        } catch (_: Throwable) {
          false
        }
      if (ok) {
        systemTts = tts
      } else {
        tts.shutdown()
      }
      ok
    }
  }

  private fun stopSpeaking(resetInterrupt: Boolean = true) {
    if (!_isSpeaking.value) {
      sherpaManager?.tts?.stop()
      systemTts?.stop()
      systemTtsPending?.cancel()
      systemTtsPending = null
      systemTtsPendingId = null
      return
    }
    if (resetInterrupt) {
      // Track interruption time if needed
      lastInterruptedAtSeconds = System.currentTimeMillis().toDouble() / 1000.0
    }
    sherpaManager?.tts?.stop()
    systemTts?.stop()
    systemTtsPending?.cancel()
    systemTtsPending = null
    systemTtsPendingId = null
    _isSpeaking.value = false
  }

  private fun shouldInterrupt(transcript: String): Boolean {
    val trimmed = transcript.trim()
    if (trimmed.length < 3) return false
    val spoken = lastSpokenText?.lowercase()
    if (spoken != null && spoken.contains(trimmed.lowercase())) return false
    return true
  }

  private suspend fun reloadConfig() {
    try {
      val res = session.request("talk.config", """{"includeSecrets":true}""")
      val root = json.parseToJsonElement(res).asObjectOrNull()
      val config = root?.get("config").asObjectOrNull()
      val talk = config?.get("talk").asObjectOrNull()
      val sessionCfg = config?.get("session").asObjectOrNull()
      val mainKey = normalizeMainKey(sessionCfg?.get("mainKey").asStringOrNull())

      if (!isCanonicalMainSessionKey(mainSessionKey)) {
        mainSessionKey = mainKey
      }

      val interrupt = talk?.get("interruptOnSpeech")?.asBooleanOrNull()
      if (interrupt != null) interruptOnSpeech = interrupt

      // Load TTS settings
      talk?.get("ttsSpeed")?.asDoubleOrNull()?.let {
        ttsSpeed = (it / 175.0).toFloat().coerceIn(0.5f, 2.0f)
      }
      talk?.get("speakerId")?.asIntOrNull()?.coerceAtLeast(0)?.let {
        ttsSpeakerId = it
      }
    } catch (_: Throwable) {
      // Use defaults
    }
  }

  private fun parseRunId(jsonString: String): String? {
    val obj = json.parseToJsonElement(jsonString).asObjectOrNull() ?: return null
    return obj["runId"].asStringOrNull()
  }

  private fun isMessageTimestampAfter(timestamp: Double, sinceSeconds: Double): Boolean {
    val sinceMs = sinceSeconds * 1000
    return if (timestamp > 10_000_000_000) {
      timestamp >= sinceMs - 500
    } else {
      timestamp >= sinceSeconds - 0.5
    }
  }

  fun release() {
    stop()
    sherpaManager?.release()
    sherpaManager = null
    remoteService?.release()
    remoteService = null
    useRemoteService = false
    systemTts?.shutdown()
    systemTts = null
  }
}

// Extension functions for JSON parsing
private fun JsonElement?.asObjectOrNull(): JsonObject? = this as? JsonObject

private fun JsonElement?.asStringOrNull(): String? =
  (this as? JsonPrimitive)?.takeIf { it.isString }?.content

private fun JsonElement?.asDoubleOrNull(): Double? {
  val primitive = this as? JsonPrimitive ?: return null
  return primitive.content.toDoubleOrNull()
}

private fun JsonElement?.asIntOrNull(): Int? {
  val primitive = this as? JsonPrimitive ?: return null
  return primitive.content.toIntOrNull()
}

private fun JsonElement?.asBooleanOrNull(): Boolean? {
  val primitive = this as? JsonPrimitive ?: return null
  val content = primitive.content.trim().lowercase()
  return when (content) {
    "true", "yes", "1" -> true
    "false", "no", "0" -> false
    else -> null
  }
}
