package com.steipete.clawdis.node.voice

import android.Manifest
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.media.AudioAttributes
import android.media.MediaPlayer
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import android.util.Log
import androidx.core.content.ContextCompat
import com.steipete.clawdis.node.bridge.BridgeSession
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.util.UUID
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

class TalkModeManager(
  private val context: Context,
  private val scope: CoroutineScope,
) {
  companion object {
    private const val tag = "TalkMode"
  }

  private val mainHandler = Handler(Looper.getMainLooper())
  private val json = Json { ignoreUnknownKeys = true }

  private val _isEnabled = MutableStateFlow(false)
  val isEnabled: StateFlow<Boolean> = _isEnabled

  private val _isListening = MutableStateFlow(false)
  val isListening: StateFlow<Boolean> = _isListening

  private val _isSpeaking = MutableStateFlow(false)
  val isSpeaking: StateFlow<Boolean> = _isSpeaking

  private val _statusText = MutableStateFlow("Off")
  val statusText: StateFlow<String> = _statusText

  private var recognizer: SpeechRecognizer? = null
  private var restartJob: Job? = null
  private var stopRequested = false
  private var listeningMode = false

  private var silenceJob: Job? = null
  private val silenceWindowMs = 700L
  private var lastTranscript: String = ""
  private var lastHeardAtMs: Long? = null
  private var lastSpokenText: String? = null
  private var lastInterruptedAtSeconds: Double? = null

  private var defaultVoiceId: String? = null
  private var currentVoiceId: String? = null
  private var defaultModelId: String? = null
  private var currentModelId: String? = null
  private var defaultOutputFormat: String? = null
  private var apiKey: String? = null
  private var interruptOnSpeech: Boolean = true
  private var voiceOverrideActive = false
  private var modelOverrideActive = false
  private var mainSessionKey: String = "main"

  private var session: BridgeSession? = null
  private var pendingRunId: String? = null
  private var pendingFinal: CompletableDeferred<Boolean>? = null
  private var chatSubscribedSessionKey: String? = null

  private var player: MediaPlayer? = null
  private var currentAudioFile: File? = null

  fun attachSession(session: BridgeSession) {
    this.session = session
    chatSubscribedSessionKey = null
  }

  fun setEnabled(enabled: Boolean) {
    if (_isEnabled.value == enabled) return
    _isEnabled.value = enabled
    if (enabled) {
      Log.d(tag, "enabled")
      start()
    } else {
      Log.d(tag, "disabled")
      stop()
    }
  }

  fun handleBridgeEvent(event: String, payloadJson: String?) {
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
      Log.d(tag, "start")

      if (!SpeechRecognizer.isRecognitionAvailable(context)) {
        _statusText.value = "Speech recognizer unavailable"
        Log.w(tag, "speech recognizer unavailable")
        return@post
      }

      val micOk =
        ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) ==
          PackageManager.PERMISSION_GRANTED
      if (!micOk) {
        _statusText.value = "Microphone permission required"
        Log.w(tag, "microphone permission required")
        return@post
      }

      try {
        recognizer?.destroy()
        recognizer = SpeechRecognizer.createSpeechRecognizer(context).also { it.setRecognitionListener(listener) }
        startListeningInternal(markListening = true)
        startSilenceMonitor()
        Log.d(tag, "listening")
      } catch (err: Throwable) {
        _statusText.value = "Start failed: ${err.message ?: err::class.simpleName}"
        Log.w(tag, "start failed: ${err.message ?: err::class.simpleName}")
      }
    }
  }

  private fun stop() {
    stopRequested = true
    listeningMode = false
    restartJob?.cancel()
    restartJob = null
    silenceJob?.cancel()
    silenceJob = null
    lastTranscript = ""
    lastHeardAtMs = null
    _isListening.value = false
    _statusText.value = "Off"
    stopSpeaking()
    chatSubscribedSessionKey = null

    mainHandler.post {
      recognizer?.cancel()
      recognizer?.destroy()
      recognizer = null
    }
  }

  private fun startListeningInternal(markListening: Boolean) {
    val r = recognizer ?: return
    val intent =
      Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
        putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
        putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true)
        putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 3)
        putExtra(RecognizerIntent.EXTRA_CALLING_PACKAGE, context.packageName)
      }

    if (markListening) {
      _statusText.value = "Listening"
      _isListening.value = true
    }
    r.startListening(intent)
  }

  private fun scheduleRestart(delayMs: Long = 350) {
    if (stopRequested) return
    restartJob?.cancel()
    restartJob =
      scope.launch {
        delay(delayMs)
        mainHandler.post {
          if (stopRequested) return@post
          try {
            recognizer?.cancel()
            val shouldListen = listeningMode
            val shouldInterrupt = _isSpeaking.value && interruptOnSpeech
            if (!shouldListen && !shouldInterrupt) return@post
            startListeningInternal(markListening = shouldListen)
          } catch (_: Throwable) {
            // handled by onError
          }
        }
      }
  }

  private fun handleTranscript(text: String, isFinal: Boolean) {
    val trimmed = text.trim()
    if (_isSpeaking.value && interruptOnSpeech) {
      if (shouldInterrupt(trimmed)) {
        stopSpeaking()
      }
      return
    }

    if (!_isListening.value) return

    if (trimmed.isNotEmpty()) {
      lastTranscript = trimmed
      lastHeardAtMs = SystemClock.elapsedRealtime()
    }

    if (isFinal) {
      lastTranscript = trimmed
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
    val transcript = lastTranscript.trim()
    if (transcript.isEmpty()) return
    val lastHeard = lastHeardAtMs ?: return
    val elapsed = SystemClock.elapsedRealtime() - lastHeard
    if (elapsed < silenceWindowMs) return
    scope.launch { finalizeTranscript(transcript) }
  }

  private suspend fun finalizeTranscript(transcript: String) {
    listeningMode = false
    _isListening.value = false
    _statusText.value = "Thinking…"
    lastTranscript = ""
    lastHeardAtMs = null

    reloadConfig()
    val prompt = buildPrompt(transcript)
    val bridge = session
    if (bridge == null) {
      _statusText.value = "Bridge not connected"
      Log.w(tag, "finalize: bridge not connected")
      start()
      return
    }

    try {
      val startedAt = System.currentTimeMillis().toDouble() / 1000.0
      subscribeChatIfNeeded(bridge = bridge, sessionKey = mainSessionKey)
      Log.d(tag, "chat.send start sessionKey=${mainSessionKey.ifBlank { "main" }} chars=${prompt.length}")
      val runId = sendChat(prompt, bridge)
      Log.d(tag, "chat.send ok runId=$runId")
      val ok = waitForChatFinal(runId)
      if (!ok) {
        Log.w(tag, "chat final timeout runId=$runId; attempting history fallback")
      }
      val assistant = waitForAssistantText(bridge, startedAt, if (ok) 12_000 else 25_000)
      if (assistant.isNullOrBlank()) {
        _statusText.value = "No reply"
        Log.w(tag, "assistant text timeout runId=$runId")
        start()
        return
      }
      Log.d(tag, "assistant text ok chars=${assistant.length}")
      playAssistant(assistant)
    } catch (err: Throwable) {
      _statusText.value = "Talk failed: ${err.message ?: err::class.simpleName}"
      Log.w(tag, "finalize failed: ${err.message ?: err::class.simpleName}")
    }

    if (_isEnabled.value) {
      start()
    }
  }

  private suspend fun subscribeChatIfNeeded(bridge: BridgeSession, sessionKey: String) {
    val key = sessionKey.trim()
    if (key.isEmpty()) return
    if (chatSubscribedSessionKey == key) return
    try {
      bridge.sendEvent("chat.subscribe", """{"sessionKey":"$key"}""")
      chatSubscribedSessionKey = key
      Log.d(tag, "chat.subscribe ok sessionKey=$key")
    } catch (err: Throwable) {
      Log.w(tag, "chat.subscribe failed sessionKey=$key err=${err.message ?: err::class.java.simpleName}")
    }
  }

  private fun buildPrompt(transcript: String): String {
    val lines = mutableListOf(
      "Talk Mode active. Reply in a concise, spoken tone.",
      "You may optionally prefix the response with JSON (first line) to set ElevenLabs voice, e.g. {\"voice\":\"<id>\",\"once\":true}.",
    )
    lastInterruptedAtSeconds?.let {
      lines.add("Assistant speech interrupted at ${"%.1f".format(it)}s.")
      lastInterruptedAtSeconds = null
    }
    lines.add("")
    lines.add(transcript)
    return lines.joinToString("\n")
  }

  private suspend fun sendChat(message: String, bridge: BridgeSession): String {
    val runId = UUID.randomUUID().toString()
    val params =
      buildJsonObject {
        put("sessionKey", JsonPrimitive(mainSessionKey.ifBlank { "main" }))
        put("message", JsonPrimitive(message))
        put("thinking", JsonPrimitive("low"))
        put("timeoutMs", JsonPrimitive(30_000))
        put("idempotencyKey", JsonPrimitive(runId))
      }
    val res = bridge.request("chat.send", params.toString())
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
    bridge: BridgeSession,
    sinceSeconds: Double,
    timeoutMs: Long,
  ): String? {
    val deadline = SystemClock.elapsedRealtime() + timeoutMs
    while (SystemClock.elapsedRealtime() < deadline) {
      val text = fetchLatestAssistantText(bridge, sinceSeconds)
      if (!text.isNullOrBlank()) return text
      delay(300)
    }
    return null
  }

  private suspend fun fetchLatestAssistantText(
    bridge: BridgeSession,
    sinceSeconds: Double? = null,
  ): String? {
    val key = mainSessionKey.ifBlank { "main" }
    val res = bridge.request("chat.history", "{\"sessionKey\":\"$key\"}")
    val root = json.parseToJsonElement(res).asObjectOrNull() ?: return null
    val messages = root["messages"] as? JsonArray ?: return null
    for (item in messages.reversed()) {
      val obj = item.asObjectOrNull() ?: continue
      if (obj["role"].asStringOrNull() != "assistant") continue
      if (sinceSeconds != null) {
        val timestamp = obj["timestamp"].asDoubleOrNull()
        if (timestamp != null && !TalkModeRuntime.isMessageTimestampAfter(timestamp, sinceSeconds)) continue
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
      Log.w(tag, "Unknown talk directive keys: ${parsed.unknownKeys}")
    }
    val directive = parsed.directive
    val cleaned = parsed.stripped.trim()
    if (cleaned.isEmpty()) return

    if (directive?.voiceId != null) {
      if (directive.once != true) {
        currentVoiceId = directive.voiceId
        voiceOverrideActive = true
      }
    }
    if (directive?.modelId != null) {
      if (directive.once != true) {
        currentModelId = directive.modelId
        modelOverrideActive = true
      }
    }

    val apiKey =
      apiKey?.trim()?.takeIf { it.isNotEmpty() }
        ?: System.getenv("ELEVENLABS_API_KEY")?.trim()
    val voiceId = directive?.voiceId ?: currentVoiceId ?: defaultVoiceId
    if (voiceId.isNullOrBlank()) {
      _statusText.value = "Missing voice ID"
      Log.w(tag, "missing voiceId")
      return
    }
    if (apiKey.isNullOrEmpty()) {
      _statusText.value = "Missing ELEVENLABS_API_KEY"
      Log.w(tag, "missing ELEVENLABS_API_KEY")
      return
    }

    _statusText.value = "Speaking…"
    _isSpeaking.value = true
    lastSpokenText = cleaned
    ensureInterruptListener()

    try {
      val ttsStarted = SystemClock.elapsedRealtime()
      val request =
        ElevenLabsRequest(
          text = cleaned,
          modelId = directive?.modelId ?: currentModelId ?: defaultModelId,
          outputFormat =
            TalkModeRuntime.validatedOutputFormat(directive?.outputFormat ?: defaultOutputFormat),
          speed = TalkModeRuntime.resolveSpeed(directive?.speed, directive?.rateWpm),
          stability = TalkModeRuntime.validatedUnit(directive?.stability),
          similarity = TalkModeRuntime.validatedUnit(directive?.similarity),
          style = TalkModeRuntime.validatedUnit(directive?.style),
          speakerBoost = directive?.speakerBoost,
          seed = TalkModeRuntime.validatedSeed(directive?.seed),
          normalize = TalkModeRuntime.validatedNormalize(directive?.normalize),
          language = TalkModeRuntime.validatedLanguage(directive?.language),
        )
      val audio = synthesize(voiceId = voiceId, apiKey = apiKey, request = request)
      Log.d(tag, "elevenlabs ok bytes=${audio.size} durMs=${SystemClock.elapsedRealtime() - ttsStarted}")
      playAudio(audio)
    } catch (err: Throwable) {
      _statusText.value = "Speak failed: ${err.message ?: err::class.simpleName}"
      Log.w(tag, "speak failed: ${err.message ?: err::class.simpleName}")
    }

    _isSpeaking.value = false
  }

  private suspend fun playAudio(data: ByteArray) {
    stopSpeaking(resetInterrupt = false)
    val file = File.createTempFile("talk-", ".mp3", context.cacheDir)
    file.writeBytes(data)
    currentAudioFile = file

    val player = MediaPlayer()
    this.player = player

    val finished = CompletableDeferred<Unit>()
    player.setAudioAttributes(
      AudioAttributes.Builder()
        .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
        .setUsage(AudioAttributes.USAGE_ASSISTANT)
        .build(),
    )
    player.setOnCompletionListener {
      finished.complete(Unit)
    }
    player.setOnErrorListener { _, _, _ ->
      finished.completeExceptionally(IllegalStateException("MediaPlayer error"))
      true
    }

    player.setDataSource(file.absolutePath)
    withContext(Dispatchers.Main) {
      player.setOnPreparedListener { it.start() }
      player.prepareAsync()
    }

    Log.d(tag, "play start")
    try {
      finished.await()
    } finally {
      cleanupPlayer()
    }
    Log.d(tag, "play done")
  }

  private fun stopSpeaking(resetInterrupt: Boolean = true) {
    if (!_isSpeaking.value) {
      cleanupPlayer()
      return
    }
    if (resetInterrupt) {
      val currentMs = player?.currentPosition?.toDouble() ?: 0.0
      lastInterruptedAtSeconds = currentMs / 1000.0
    }
    cleanupPlayer()
    _isSpeaking.value = false
  }

  private fun cleanupPlayer() {
    player?.stop()
    player?.release()
    player = null
    currentAudioFile?.delete()
    currentAudioFile = null
  }

  private fun shouldInterrupt(transcript: String): Boolean {
    val trimmed = transcript.trim()
    if (trimmed.length < 3) return false
    val spoken = lastSpokenText?.lowercase()
    if (spoken != null && spoken.contains(trimmed.lowercase())) return false
    return true
  }

  private suspend fun reloadConfig() {
    val bridge = session ?: return
    val envVoice = System.getenv("ELEVENLABS_VOICE_ID")?.trim()
    val sagVoice = System.getenv("SAG_VOICE_ID")?.trim()
    val envKey = System.getenv("ELEVENLABS_API_KEY")?.trim()
    try {
      val res = bridge.request("config.get", "{}")
      val root = json.parseToJsonElement(res).asObjectOrNull()
      val config = root?.get("config").asObjectOrNull()
      val talk = config?.get("talk").asObjectOrNull()
      val sessionCfg = config?.get("session").asObjectOrNull()
      val mainKey = sessionCfg?.get("mainKey").asStringOrNull()?.trim()?.takeIf { it.isNotEmpty() } ?: "main"
      val voice = talk?.get("voiceId")?.asStringOrNull()?.trim()?.takeIf { it.isNotEmpty() }
      val model = talk?.get("modelId")?.asStringOrNull()?.trim()?.takeIf { it.isNotEmpty() }
      val outputFormat = talk?.get("outputFormat")?.asStringOrNull()?.trim()?.takeIf { it.isNotEmpty() }
      val key = talk?.get("apiKey")?.asStringOrNull()?.trim()?.takeIf { it.isNotEmpty() }
      val interrupt = talk?.get("interruptOnSpeech")?.asBooleanOrNull()

      mainSessionKey = mainKey
      defaultVoiceId = voice ?: envVoice?.takeIf { it.isNotEmpty() } ?: sagVoice?.takeIf { it.isNotEmpty() }
      if (!voiceOverrideActive) currentVoiceId = defaultVoiceId
      defaultModelId = model
      if (!modelOverrideActive) currentModelId = defaultModelId
      defaultOutputFormat = outputFormat
      apiKey = key ?: envKey?.takeIf { it.isNotEmpty() }
      if (interrupt != null) interruptOnSpeech = interrupt
    } catch (_: Throwable) {
      defaultVoiceId = envVoice?.takeIf { it.isNotEmpty() } ?: sagVoice?.takeIf { it.isNotEmpty() }
      apiKey = envKey?.takeIf { it.isNotEmpty() }
    }
  }

  private fun parseRunId(jsonString: String): String? {
    val obj = json.parseToJsonElement(jsonString).asObjectOrNull() ?: return null
    return obj["runId"].asStringOrNull()
  }

  private suspend fun synthesize(voiceId: String, apiKey: String, request: ElevenLabsRequest): ByteArray {
    return withContext(Dispatchers.IO) {
      val url = URL("https://api.elevenlabs.io/v1/text-to-speech/$voiceId")
      val conn = url.openConnection() as HttpURLConnection
      conn.requestMethod = "POST"
      conn.connectTimeout = 30_000
      conn.readTimeout = 30_000
      conn.setRequestProperty("Content-Type", "application/json")
      conn.setRequestProperty("Accept", "audio/mpeg")
      conn.setRequestProperty("xi-api-key", apiKey)
      conn.doOutput = true

      val payload = buildRequestPayload(request)
      conn.outputStream.use { it.write(payload.toByteArray()) }

      val code = conn.responseCode
      val stream = if (code >= 400) conn.errorStream else conn.inputStream
      val data = stream.readBytes()
      if (code >= 400) {
        val message = String(data)
        throw IllegalStateException("ElevenLabs failed: $code $message")
      }
      data
    }
  }

  private fun buildRequestPayload(request: ElevenLabsRequest): String {
    val voiceSettingsEntries =
      buildJsonObject {
        request.speed?.let { put("speed", JsonPrimitive(it)) }
        request.stability?.let { put("stability", JsonPrimitive(it)) }
        request.similarity?.let { put("similarity_boost", JsonPrimitive(it)) }
        request.style?.let { put("style", JsonPrimitive(it)) }
        request.speakerBoost?.let { put("use_speaker_boost", JsonPrimitive(it)) }
      }

    val payload =
      buildJsonObject {
        put("text", JsonPrimitive(request.text))
        request.modelId?.takeIf { it.isNotEmpty() }?.let { put("model_id", JsonPrimitive(it)) }
        request.outputFormat?.takeIf { it.isNotEmpty() }?.let { put("output_format", JsonPrimitive(it)) }
        request.seed?.let { put("seed", JsonPrimitive(it)) }
        request.normalize?.let { put("apply_text_normalization", JsonPrimitive(it)) }
        request.language?.let { put("language_code", JsonPrimitive(it)) }
        if (voiceSettingsEntries.isNotEmpty()) {
          put("voice_settings", voiceSettingsEntries)
        }
      }

    return payload.toString()
  }

  private data class ElevenLabsRequest(
    val text: String,
    val modelId: String?,
    val outputFormat: String?,
    val speed: Double?,
    val stability: Double?,
    val similarity: Double?,
    val style: Double?,
    val speakerBoost: Boolean?,
    val seed: Long?,
    val normalize: String?,
    val language: String?,
  )

  private object TalkModeRuntime {
    fun resolveSpeed(speed: Double?, rateWpm: Int?): Double? {
      if (rateWpm != null && rateWpm > 0) {
        val resolved = rateWpm.toDouble() / 175.0
        if (resolved <= 0.5 || resolved >= 2.0) return null
        return resolved
      }
      if (speed != null) {
        if (speed <= 0.5 || speed >= 2.0) return null
        return speed
      }
      return null
    }

    fun validatedUnit(value: Double?): Double? {
      if (value == null) return null
      if (value < 0 || value > 1) return null
      return value
    }

    fun validatedSeed(value: Long?): Long? {
      if (value == null) return null
      if (value < 0 || value > 4294967295L) return null
      return value
    }

    fun validatedNormalize(value: String?): String? {
      val normalized = value?.trim()?.lowercase() ?: return null
      return if (normalized in listOf("auto", "on", "off")) normalized else null
    }

    fun validatedLanguage(value: String?): String? {
      val normalized = value?.trim()?.lowercase() ?: return null
      if (normalized.length != 2) return null
      if (!normalized.all { it in 'a'..'z' }) return null
      return normalized
    }

    fun validatedOutputFormat(value: String?): String? {
      val trimmed = value?.trim()?.lowercase() ?: return null
      if (trimmed.isEmpty()) return null
      return if (trimmed.startsWith("mp3_")) trimmed else null
    }

    fun isMessageTimestampAfter(timestamp: Double, sinceSeconds: Double): Boolean {
      val sinceMs = sinceSeconds * 1000
      return if (timestamp > 10_000_000_000) {
        timestamp >= sinceMs - 500
      } else {
        timestamp >= sinceSeconds - 0.5
      }
    }
  }

  private fun ensureInterruptListener() {
    if (!interruptOnSpeech || !_isEnabled.value) return
    mainHandler.post {
      if (stopRequested) return@post
      if (!SpeechRecognizer.isRecognitionAvailable(context)) return@post
      try {
        if (recognizer == null) {
          recognizer = SpeechRecognizer.createSpeechRecognizer(context).also { it.setRecognitionListener(listener) }
        }
        recognizer?.cancel()
        startListeningInternal(markListening = false)
      } catch (_: Throwable) {
        // ignore
      }
    }
  }

  private val listener =
    object : RecognitionListener {
      override fun onReadyForSpeech(params: Bundle?) {
        if (_isEnabled.value) {
          _statusText.value = if (_isListening.value) "Listening" else _statusText.value
        }
      }

      override fun onBeginningOfSpeech() {}

      override fun onRmsChanged(rmsdB: Float) {}

      override fun onBufferReceived(buffer: ByteArray?) {}

      override fun onEndOfSpeech() {
        scheduleRestart()
      }

      override fun onError(error: Int) {
        if (stopRequested) return
        _isListening.value = false
        if (error == SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS) {
          _statusText.value = "Microphone permission required"
          return
        }

        _statusText.value =
          when (error) {
            SpeechRecognizer.ERROR_AUDIO -> "Audio error"
            SpeechRecognizer.ERROR_CLIENT -> "Client error"
            SpeechRecognizer.ERROR_NETWORK -> "Network error"
            SpeechRecognizer.ERROR_NETWORK_TIMEOUT -> "Network timeout"
            SpeechRecognizer.ERROR_NO_MATCH -> "Listening"
            SpeechRecognizer.ERROR_RECOGNIZER_BUSY -> "Recognizer busy"
            SpeechRecognizer.ERROR_SERVER -> "Server error"
            SpeechRecognizer.ERROR_SPEECH_TIMEOUT -> "Listening"
            else -> "Speech error ($error)"
          }
        scheduleRestart(delayMs = 600)
      }

      override fun onResults(results: Bundle?) {
        val list = results?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION).orEmpty()
        list.firstOrNull()?.let { handleTranscript(it, isFinal = true) }
        scheduleRestart()
      }

      override fun onPartialResults(partialResults: Bundle?) {
        val list = partialResults?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION).orEmpty()
        list.firstOrNull()?.let { handleTranscript(it, isFinal = false) }
      }

      override fun onEvent(eventType: Int, params: Bundle?) {}
    }
}

private fun JsonElement?.asObjectOrNull(): JsonObject? = this as? JsonObject

private fun JsonElement?.asStringOrNull(): String? =
  (this as? JsonPrimitive)?.takeIf { it.isString }?.content

private fun JsonElement?.asDoubleOrNull(): Double? {
  val primitive = this as? JsonPrimitive ?: return null
  return primitive.content.toDoubleOrNull()
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
