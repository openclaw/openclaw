package ai.openclaw.app.voice

import android.Manifest
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.media.MediaPlayer
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import android.util.Base64
import android.util.Log
import androidx.core.content.ContextCompat
import ai.openclaw.app.gateway.GatewaySession
import ai.openclaw.app.isCanonicalMainSessionKey
import java.io.File
import java.util.UUID
import java.util.concurrent.atomic.AtomicLong
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.ensureActive
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
  private val session: GatewaySession,
  private val supportsChatSubscribe: Boolean,
  private val isConnected: () -> Boolean,
) {
  companion object {
    private const val tag = "TalkMode"
    private const val listenWatchdogMs = 12_000L
    private const val chatFinalWaitWithSubscribeMs = 45_000L
    private const val chatFinalWaitWithoutSubscribeMs = 6_000L
    private const val maxCachedRunCompletions = 128
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

  private val _lastAssistantText = MutableStateFlow<String?>(null)
  val lastAssistantText: StateFlow<String?> = _lastAssistantText

  private var recognizer: SpeechRecognizer? = null
  private var restartJob: Job? = null
  private var stopRequested = false
  private var listeningMode = false

  private var silenceJob: Job? = null
  private var silenceWindowMs = TalkDefaults.defaultSilenceTimeoutMs
  private var lastTranscript: String = ""
  private var lastHeardAtMs: Long? = null
  private var lastSpokenText: String? = null
  private var lastInterruptedAtSeconds: Double? = null

  private var currentVoiceId: String? = null
  private var currentModelId: String? = null
  // Interrupt-on-speech is disabled by default: starting a SpeechRecognizer during
  // TTS creates an audio session conflict on some OEMs. Can be enabled via gateway talk config.
  private var interruptOnSpeech: Boolean = false
  private var mainSessionKey: String = "main"

  @Volatile private var pendingRunId: String? = null
  private var pendingFinal: CompletableDeferred<Boolean>? = null
  private val completedRunsLock = Any()
  private val completedRunStates = LinkedHashMap<String, Boolean>()
  private val completedRunTexts = LinkedHashMap<String, String>()
  private var chatSubscribedSessionKey: String? = null
  private var configLoaded = false
  @Volatile private var playbackEnabled = true
  private val playbackGeneration = AtomicLong(0L)

  private var ttsJob: Job? = null
  private var player: MediaPlayer? = null
  @Volatile private var finalizeInFlight = false
  private var listenWatchdogJob: Job? = null

  private var audioFocusRequest: AudioFocusRequest? = null
  private val audioFocusListener = AudioManager.OnAudioFocusChangeListener { focusChange ->
    when (focusChange) {
      AudioManager.AUDIOFOCUS_LOSS,
      AudioManager.AUDIOFOCUS_LOSS_TRANSIENT -> {
        if (_isSpeaking.value) {
          Log.d(tag, "audio focus lost; stopping TTS")
          stopSpeaking(resetInterrupt = true)
        }
      }
      else -> { /* regained or duck — ignore */ }
    }
  }

  suspend fun ensureChatSubscribed() {
    reloadConfig()
    subscribeChatIfNeeded(session = session, sessionKey = mainSessionKey.ifBlank { "main" })
  }

  fun setMainSessionKey(sessionKey: String?) {
    val trimmed = sessionKey?.trim().orEmpty()
    if (trimmed.isEmpty()) return
    if (isCanonicalMainSessionKey(mainSessionKey)) return
    mainSessionKey = trimmed
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

  /**
   * Speak a wake-word command through TalkMode's full pipeline:
   * chat.send → wait for final → read assistant text → TTS.
   * Calls [onComplete] when done so the caller can disable TalkMode and re-arm VoiceWake.
   */
  fun speakWakeCommand(command: String, onComplete: () -> Unit) {
    scope.launch {
      try {
        reloadConfig()
        subscribeChatIfNeeded(session = session, sessionKey = mainSessionKey.ifBlank { "main" })
        val startedAt = System.currentTimeMillis().toDouble() / 1000.0
        val prompt = buildPrompt(command)
        val runId = sendChat(prompt, session)
        val ok = waitForChatFinal(runId)
        val assistant = consumeRunText(runId)
          ?: waitForAssistantText(session, startedAt, if (ok) 12_000 else 25_000)
        if (!assistant.isNullOrBlank()) {
          val playbackToken = playbackGeneration.incrementAndGet()
          _statusText.value = "Speaking…"
          playAssistant(assistant, playbackToken)
        } else {
          _statusText.value = "No reply"
        }
      } catch (err: Throwable) {
        Log.w(tag, "speakWakeCommand failed: ${err.message}")
      }
      onComplete()
    }
  }

  /** When true, play TTS for all final chat responses (even ones we didn't initiate). */
  @Volatile var ttsOnAllResponses = false

  fun playTtsForText(text: String) {
    val playbackToken = playbackGeneration.incrementAndGet()
    ttsJob?.cancel()
    ttsJob = scope.launch {
      reloadConfig()
      ensurePlaybackActive(playbackToken)
      _isSpeaking.value = true
      _statusText.value = "Speaking…"
      playAssistant(text, playbackToken)
      ttsJob = null
    }
  }

  fun handleGatewayEvent(event: String, payloadJson: String?) {
    if (ttsOnAllResponses) {
      Log.d(tag, "gateway event: $event")
    }
    if (event == "agent" && ttsOnAllResponses) {
      return
    }
    if (event != "chat") return
    if (payloadJson.isNullOrBlank()) return
    val obj =
      try {
        json.parseToJsonElement(payloadJson).asObjectOrNull()
      } catch (_: Throwable) {
        null
      } ?: return
    val runId = obj["runId"].asStringOrNull() ?: return
    val state = obj["state"].asStringOrNull() ?: return

    // Only speak events for the active session — prevents TTS from other
    // sessions/channels leaking into voice mode (privacy + correctness).
    val eventSession = obj["sessionKey"]?.asStringOrNull()
    val activeSession = mainSessionKey.ifBlank { "main" }
    if (eventSession != null && eventSession != activeSession) return

    // If this is a response we initiated, handle normally below.
    // Otherwise, if ttsOnAllResponses, finish streaming TTS on terminal events.
    val pending = pendingRunId
    if (pending == null || runId != pending) {
      if (ttsOnAllResponses && state == "final") {
        val text = extractTextFromChatEventMessage(obj["message"])
        if (!text.isNullOrBlank()) {
          playTtsForText(text)
        }
      }
      if (pending == null || runId != pending) return
    }
    Log.d(tag, "chat event arrived runId=$runId state=$state pendingRunId=$pendingRunId")
    val terminal =
      when (state) {
        "final" -> true
        "aborted", "error" -> false
        else -> null
      } ?: return
    // Cache text from final event so we never need to poll chat.history
    if (terminal) {
      val text = extractTextFromChatEventMessage(obj["message"])
      if (!text.isNullOrBlank()) {
        synchronized(completedRunsLock) {
          completedRunTexts[runId] = text
          while (completedRunTexts.size > maxCachedRunCompletions) {
            completedRunTexts.entries.firstOrNull()?.let { completedRunTexts.remove(it.key) }
          }
        }
      }
    }
    cacheRunCompletion(runId, terminal)

    if (runId != pendingRunId) return
    pendingFinal?.complete(terminal)
    pendingFinal = null
    pendingRunId = null
  }

  fun setPlaybackEnabled(enabled: Boolean) {
    if (playbackEnabled == enabled) return
    playbackEnabled = enabled
    if (!enabled) {
      playbackGeneration.incrementAndGet()
      stopSpeaking()
    }
  }

  suspend fun refreshConfig() {
    reloadConfig()
  }

  suspend fun speakAssistantReply(text: String) {
    if (!playbackEnabled) return
    val playbackToken = playbackGeneration.incrementAndGet()
    stopSpeaking(resetInterrupt = false)
    ensureConfigLoaded()
    ensurePlaybackActive(playbackToken)
    playAssistant(text, playbackToken)
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
    finalizeInFlight = false
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
    pendingRunId = null
    pendingFinal?.cancel()
    pendingFinal = null
    synchronized(completedRunsLock) {
      completedRunStates.clear()
      completedRunTexts.clear()
    }

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
        // Use cloud recognition — it handles natural speech and pauses better
        // than on-device which cuts off aggressively after short silences.
        putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_COMPLETE_SILENCE_LENGTH_MILLIS, 2500L)
        putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_POSSIBLY_COMPLETE_SILENCE_LENGTH_MILLIS, 1800L)
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
            val shouldListen = listeningMode && !finalizeInFlight
            val shouldInterrupt = _isSpeaking.value && interruptOnSpeech && shouldAllowSpeechInterrupt()
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
      // Don't finalize immediately — let the silence monitor trigger after
      // silenceWindowMs. This allows the recognizer to fire onResults and
      // still give the user a natural pause before we send.
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
    if (finalizeInFlight) return
    finalizeInFlight = true
    scope.launch {
      try {
        finalizeTranscript(transcript)
      } finally {
        finalizeInFlight = false
      }
    }
  }

  private suspend fun finalizeTranscript(transcript: String) {
    listeningMode = false
    _isListening.value = false
    _statusText.value = "Thinking…"
    lastTranscript = ""
    lastHeardAtMs = null
    // Release SpeechRecognizer before making the API call and playing TTS.
    // Must use withContext(Main) — not post() — so we WAIT for destruction before
    // proceeding. A fire-and-forget post() races with TTS startup: the recognizer
    // stays alive, picks up TTS audio as speech (onBeginningOfSpeech), and the
    // OS kills the AudioTrack write (returns 0) on OxygenOS/OnePlus devices.
    withContext(Dispatchers.Main) {
      recognizer?.cancel()
      recognizer?.destroy()
      recognizer = null
    }

    ensureConfigLoaded()
    val prompt = buildPrompt(transcript)
    if (!isConnected()) {
      _statusText.value = "Gateway not connected"
      Log.w(tag, "finalize: gateway not connected")
      start()
      return
    }

    try {
      val startedAt = System.currentTimeMillis().toDouble() / 1000.0
      subscribeChatIfNeeded(session = session, sessionKey = mainSessionKey)
      Log.d(tag, "chat.send start sessionKey=${mainSessionKey.ifBlank { "main" }} chars=${prompt.length}")
      val runId = sendChat(prompt, session)
      Log.d(tag, "chat.send ok runId=$runId")
      val ok = waitForChatFinal(runId)
      if (!ok) {
        Log.w(tag, "chat final timeout runId=$runId; attempting history fallback")
      }
      // Use text cached from the final event first — avoids chat.history polling
      val assistant = consumeRunText(runId)
        ?: waitForAssistantText(session, startedAt, if (ok) 12_000 else 25_000)
      if (assistant.isNullOrBlank()) {
        _statusText.value = "No reply"
        Log.w(tag, "assistant text timeout runId=$runId")
        start()
        return
      }
      Log.d(tag, "assistant text ok chars=${assistant.length}")
      val playbackToken = playbackGeneration.incrementAndGet()
      stopSpeaking(resetInterrupt = false)
      ensurePlaybackActive(playbackToken)
      playAssistant(assistant, playbackToken)
    } catch (err: Throwable) {
      if (err is CancellationException) {
        Log.d(tag, "finalize speech cancelled")
        return
      }
      _statusText.value = "Talk failed: ${err.message ?: err::class.simpleName}"
      Log.w(tag, "finalize failed: ${err.message ?: err::class.simpleName}")
    }

    if (_isEnabled.value) {
      start()
    }
  }

  private suspend fun subscribeChatIfNeeded(session: GatewaySession, sessionKey: String) {
    if (!supportsChatSubscribe) return
    val key = sessionKey.trim()
    if (key.isEmpty()) return
    if (chatSubscribedSessionKey == key) return
    val sent = session.sendNodeEvent("chat.subscribe", """{"sessionKey":"$key"}""")
    if (sent) {
      chatSubscribedSessionKey = key
      Log.d(tag, "chat.subscribe ok sessionKey=$key")
    } else {
      Log.w(tag, "chat.subscribe failed sessionKey=$key")
    }
  }

  private fun buildPrompt(transcript: String): String {
    val lines = mutableListOf(
      "Talk Mode active. Reply in a concise, spoken tone.",
      "You may optionally prefix the response with JSON (first line) to set ElevenLabs voice (id or alias), e.g. {\"voice\":\"<id>\",\"once\":true}.",
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

  private fun cacheRunCompletion(runId: String, isFinal: Boolean) {
    synchronized(completedRunsLock) {
      completedRunStates[runId] = isFinal
      while (completedRunStates.size > maxCachedRunCompletions) {
        val first = completedRunStates.entries.firstOrNull() ?: break
        completedRunStates.remove(first.key)
      }
    }
  }

  private fun consumeRunCompletion(runId: String): Boolean? {
    synchronized(completedRunsLock) {
      return completedRunStates.remove(runId)
    }
  }

  private fun consumeRunText(runId: String): String? {
    synchronized(completedRunsLock) {
      return completedRunTexts.remove(runId)
    }
  }

  private fun extractTextFromChatEventMessage(messageEl: JsonElement?): String? {
    val msg = messageEl?.asObjectOrNull() ?: return null
    val content = msg["content"] as? JsonArray ?: return null
    return content.mapNotNull { entry ->
      entry.asObjectOrNull()?.get("text")?.asStringOrNull()?.trim()
    }.filter { it.isNotEmpty() }.joinToString("\n").takeIf { it.isNotBlank() }
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

  private suspend fun playAssistant(text: String, playbackToken: Long) {
    val parsed = TalkDirectiveParser.parse(text)
    if (parsed.unknownKeys.isNotEmpty()) {
      Log.w(tag, "Unknown talk directive keys: ${parsed.unknownKeys}")
    }
    val directive = parsed.directive
    val cleaned = parsed.stripped.trim()
    if (cleaned.isEmpty()) return
    _lastAssistantText.value = cleaned

    val requestedVoice = directive?.voiceId?.trim()?.takeIf { it.isNotEmpty() }

    if (directive?.voiceId != null) {
      if (directive.once != true) {
        currentVoiceId = requestedVoice
      }
    }
    if (directive?.modelId != null) {
      if (directive.once != true) {
        currentModelId = directive.modelId?.trim()?.takeIf { it.isNotEmpty() }
      }
    }
    ensurePlaybackActive(playbackToken)

    _statusText.value = "Speaking…"
    _isSpeaking.value = true
    lastSpokenText = cleaned
    ensureInterruptListener()
    requestAudioFocusForTts()

    try {
      val ttsStarted = SystemClock.elapsedRealtime()
      val speech = requestTalkSpeak(cleaned, directive)
      playGatewaySpeech(speech, playbackToken)
      Log.d(tag, "talk.speak ok durMs=${SystemClock.elapsedRealtime() - ttsStarted} provider=${speech.provider}")
    } catch (err: Throwable) {
      if (isPlaybackCancelled(err, playbackToken)) {
        Log.d(tag, "assistant speech cancelled")
        return
      }
      _statusText.value = "Speak failed: ${err.message ?: err::class.simpleName}"
      Log.w(tag, "talk.speak failed: ${err.message ?: err::class.simpleName}")
    } finally {

      _isSpeaking.value = false
    }
  }

  private data class GatewayTalkSpeech(
    val audioBase64: String,
    val provider: String,
    val outputFormat: String?,
    val mimeType: String?,
    val fileExtension: String?,
  )

  private suspend fun requestTalkSpeak(text: String, directive: TalkDirective?): GatewayTalkSpeech {
    val modelId =
      directive?.modelId?.trim()?.takeIf { it.isNotEmpty() } ?: currentModelId?.trim()?.takeIf { it.isNotEmpty() }
    val voiceId =
      directive?.voiceId?.trim()?.takeIf { it.isNotEmpty() } ?: currentVoiceId?.trim()?.takeIf { it.isNotEmpty() }
    val params =
      buildJsonObject {
        put("text", JsonPrimitive(text))
        voiceId?.let { put("voiceId", JsonPrimitive(it)) }
        modelId?.let { put("modelId", JsonPrimitive(it)) }
        TalkModeRuntime.resolveSpeed(directive?.speed, directive?.rateWpm)?.let {
          put("speed", JsonPrimitive(it))
        }
        TalkModeRuntime.validatedStability(directive?.stability, modelId)?.let {
          put("stability", JsonPrimitive(it))
        }
        TalkModeRuntime.validatedUnit(directive?.similarity)?.let {
          put("similarity", JsonPrimitive(it))
        }
        TalkModeRuntime.validatedUnit(directive?.style)?.let {
          put("style", JsonPrimitive(it))
        }
        directive?.speakerBoost?.let { put("speakerBoost", JsonPrimitive(it)) }
        TalkModeRuntime.validatedSeed(directive?.seed)?.let { put("seed", JsonPrimitive(it)) }
        TalkModeRuntime.validatedNormalize(directive?.normalize)?.let {
          put("normalize", JsonPrimitive(it))
        }
        TalkModeRuntime.validatedLanguage(directive?.language)?.let {
          put("language", JsonPrimitive(it))
        }
      }
    val res = session.request("talk.speak", params.toString())
    val root = json.parseToJsonElement(res).asObjectOrNull() ?: error("talk.speak returned invalid JSON")
    val audioBase64 = root["audioBase64"].asStringOrNull()?.trim().orEmpty()
    val provider = root["provider"].asStringOrNull()?.trim().orEmpty()
    if (audioBase64.isEmpty()) {
      error("talk.speak missing audioBase64")
    }
    if (provider.isEmpty()) {
      error("talk.speak missing provider")
    }
    return GatewayTalkSpeech(
      audioBase64 = audioBase64,
      provider = provider,
      outputFormat = root["outputFormat"].asStringOrNull()?.trim(),
      mimeType = root["mimeType"].asStringOrNull()?.trim(),
      fileExtension = root["fileExtension"].asStringOrNull()?.trim(),
    )
  }

  private suspend fun playGatewaySpeech(speech: GatewayTalkSpeech, playbackToken: Long) {
    ensurePlaybackActive(playbackToken)
    stopSpeaking(resetInterrupt = false)
    ensurePlaybackActive(playbackToken)

    val audioBytes =
      try {
        Base64.decode(speech.audioBase64, Base64.DEFAULT)
      } catch (err: IllegalArgumentException) {
        throw IllegalStateException("talk.speak returned invalid audio", err)
      }
    val suffix = resolveGatewayAudioSuffix(speech)
    val tempFile =
      withContext(Dispatchers.IO) { File.createTempFile("tts_", suffix, context.cacheDir) }
    try {
      withContext(Dispatchers.IO) { tempFile.writeBytes(audioBytes) }
      val player = MediaPlayer()
      this.player = player
      val finished = CompletableDeferred<Unit>()
      player.setAudioAttributes(
        AudioAttributes.Builder()
          .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
          .setUsage(AudioAttributes.USAGE_MEDIA)
          .build(),
      )
      player.setOnCompletionListener { finished.complete(Unit) }
      player.setOnErrorListener { _, what, extra ->
        finished.completeExceptionally(IllegalStateException("MediaPlayer error what=$what extra=$extra"))
        true
      }
      player.setDataSource(tempFile.absolutePath)
      withContext(Dispatchers.IO) { player.prepare() }
      ensurePlaybackActive(playbackToken)
      player.start()
      finished.await()
      ensurePlaybackActive(playbackToken)
    } finally {
      try {
        cleanupPlayer()
      } catch (_: Throwable) {}
      tempFile.delete()
    }
  }

  private fun resolveGatewayAudioSuffix(speech: GatewayTalkSpeech): String {
    val extension = speech.fileExtension?.trim()
    if (!extension.isNullOrEmpty()) {
      return if (extension.startsWith(".")) extension else ".$extension"
    }
    val mimeType = speech.mimeType?.trim()?.lowercase()
    if (mimeType == "audio/mpeg") return ".mp3"
    if (mimeType == "audio/ogg") return ".ogg"
    if (mimeType == "audio/wav") return ".wav"
    if (mimeType == "audio/webm") return ".webm"
    val outputFormat = speech.outputFormat?.trim()?.lowercase().orEmpty()
    if (outputFormat == "mp3" || outputFormat.startsWith("mp3_") || outputFormat.endsWith("-mp3")) return ".mp3"
    if (outputFormat == "opus" || outputFormat.startsWith("opus_")) return ".ogg"
    if (outputFormat.endsWith("-wav")) return ".wav"
    if (outputFormat.endsWith("-webm")) return ".webm"
    return ".audio"
  }

  fun stopTts() {
    stopSpeaking(resetInterrupt = true)
    _isSpeaking.value = false
    _statusText.value = "Listening"
  }

  private fun stopSpeaking(resetInterrupt: Boolean = true) {
    if (!_isSpeaking.value) {
      cleanupPlayer()
      abandonAudioFocus()
      return
    }
    if (resetInterrupt) {
      val currentMs = player?.currentPosition?.toDouble() ?: 0.0
      lastInterruptedAtSeconds = currentMs / 1000.0
    }
    cleanupPlayer()
    _isSpeaking.value = false
    abandonAudioFocus()
  }

  private fun shouldAllowSpeechInterrupt(): Boolean {
    return !finalizeInFlight
  }

  private fun clearListenWatchdog() {
    listenWatchdogJob?.cancel()
    listenWatchdogJob = null
  }

  private fun requestAudioFocusForTts(): Boolean {
    val am = context.getSystemService(Context.AUDIO_SERVICE) as? AudioManager ?: return true
    val req = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK)
      .setAudioAttributes(
        AudioAttributes.Builder()
          .setUsage(AudioAttributes.USAGE_MEDIA)
          .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
          .build()
      )
      .setOnAudioFocusChangeListener(audioFocusListener)
      .build()
    audioFocusRequest = req
    val result = am.requestAudioFocus(req)
    Log.d(tag, "audio focus request result=$result")
    return result == AudioManager.AUDIOFOCUS_REQUEST_GRANTED || result == AudioManager.AUDIOFOCUS_REQUEST_DELAYED
  }

  private fun abandonAudioFocus() {
    val am = context.getSystemService(Context.AUDIO_SERVICE) as? AudioManager ?: return
    audioFocusRequest?.let {
      am.abandonAudioFocusRequest(it)
      Log.d(tag, "audio focus abandoned")
    }
    audioFocusRequest = null
  }

  private fun cleanupPlayer() {
    player?.stop()
    player?.release()
    player = null
  }

  private fun shouldInterrupt(transcript: String): Boolean {
    val trimmed = transcript.trim()
    if (trimmed.length < 3) return false
    val spoken = lastSpokenText?.lowercase()
    if (spoken != null && spoken.contains(trimmed.lowercase())) return false
    return true
  }

  private fun ensurePlaybackActive(playbackToken: Long) {
    if (!playbackEnabled || playbackToken != playbackGeneration.get()) {
      throw CancellationException("assistant speech cancelled")
    }
  }

  private fun isPlaybackCancelled(err: Throwable?, playbackToken: Long): Boolean {
    if (err is CancellationException) return true
    return !playbackEnabled || playbackToken != playbackGeneration.get()
  }

  private suspend fun ensureConfigLoaded() {
    if (!configLoaded) {
      reloadConfig()
    }
  }

  private suspend fun reloadConfig() {
    try {
      val res = session.request("talk.config", "{}")
      val root = json.parseToJsonElement(res).asObjectOrNull()
      val parsed = TalkModeGatewayConfigParser.parse(root?.get("config").asObjectOrNull())
      if (!isCanonicalMainSessionKey(mainSessionKey)) {
        mainSessionKey = parsed.mainSessionKey
      }
      silenceWindowMs = parsed.silenceTimeoutMs
      parsed.interruptOnSpeech?.let { interruptOnSpeech = it }
      configLoaded = true
    } catch (_: Throwable) {
      silenceWindowMs = TalkDefaults.defaultSilenceTimeoutMs
      configLoaded = false
    }
  }

  private fun parseRunId(jsonString: String): String? {
    val obj = json.parseToJsonElement(jsonString).asObjectOrNull() ?: return null
    return obj["runId"].asStringOrNull()
  }

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

    fun validatedStability(value: Double?, modelId: String?): Double? {
      if (value == null) return null
      val normalized = modelId?.trim()?.lowercase()
      if (normalized == "eleven_v3") {
        return if (value == 0.0 || value == 0.5 || value == 1.0) value else null
      }
      return validatedUnit(value)
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
    if (!interruptOnSpeech || !_isEnabled.value || !shouldAllowSpeechInterrupt()) return
    // Don't create a new recognizer when we just destroyed one for TTS (finalizeInFlight=true).
    // Starting a new recognizer mid-TTS causes audio session conflict that kills AudioTrack
    // writes (returns 0) and MediaPlayer on OxygenOS/OnePlus devices.
    if (finalizeInFlight) return
    mainHandler.post {
      if (stopRequested || finalizeInFlight) return@post
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
        clearListenWatchdog()
        // Don't restart while a transcript is being processed — the recognizer
        // competing for audio resources kills AudioTrack PCM playback.
        if (!finalizeInFlight) {
          scheduleRestart()
        }
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
