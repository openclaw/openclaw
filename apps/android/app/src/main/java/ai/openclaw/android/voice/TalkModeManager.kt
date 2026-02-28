package ai.openclaw.android.voice

import android.Manifest
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioTrack
import android.media.MediaPlayer
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import android.util.Log
import androidx.core.content.ContextCompat
import ai.openclaw.android.gateway.GatewaySession
import ai.openclaw.android.isCanonicalMainSessionKey
import ai.openclaw.android.normalizeMainKey
import android.os.Build
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
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
import kotlin.math.max

class TalkModeManager(
  private val context: Context,
  private val scope: CoroutineScope,
  private val session: GatewaySession,
  private val supportsChatSubscribe: Boolean,
  private val isConnected: () -> Boolean,
) {
  companion object {
    private const val tag = "TalkMode"
    private const val defaultModelIdFallback = "eleven_v3"
    private const val defaultOutputFormatFallback = "pcm_24000"
private const val defaultTalkProvider = "elevenlabs"
    private const val silenceWindowMs = 500L
    private const val listenWatchdogMs = 12_000L
    private const val chatFinalWaitWithSubscribeMs = 45_000L
    private const val chatFinalWaitWithoutSubscribeMs = 6_000L
    private const val maxCachedRunCompletions = 128

    internal data class TalkProviderConfigSelection(
      val provider: String,
      val config: JsonObject,
      val normalizedPayload: Boolean,
    )

    private fun normalizeTalkProviderId(raw: String?): String? {
      val trimmed = raw?.trim()?.lowercase().orEmpty()
      return trimmed.takeIf { it.isNotEmpty() }
    }

    internal fun selectTalkProviderConfig(talk: JsonObject?): TalkProviderConfigSelection? {
      if (talk == null) return null
      val rawProvider = talk["provider"].asStringOrNull()
      val rawProviders = talk["providers"].asObjectOrNull()
      val hasNormalizedPayload = rawProvider != null || rawProviders != null
      if (hasNormalizedPayload) {
        val providers =
          rawProviders?.entries?.mapNotNull { (key, value) ->
            val providerId = normalizeTalkProviderId(key) ?: return@mapNotNull null
            val providerConfig = value.asObjectOrNull() ?: return@mapNotNull null
            providerId to providerConfig
          }?.toMap().orEmpty()
        val providerId =
          normalizeTalkProviderId(rawProvider)
            ?: providers.keys.sorted().firstOrNull()
            ?: defaultTalkProvider
        return TalkProviderConfigSelection(
          provider = providerId,
          config = providers[providerId] ?: buildJsonObject {},
          normalizedPayload = true,
        )
      }
      return TalkProviderConfigSelection(
        provider = defaultTalkProvider,
        config = talk,
        normalizedPayload = false,
      )
    }
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

  private val _usingFallbackTts = MutableStateFlow(false)
  val usingFallbackTts: StateFlow<Boolean> = _usingFallbackTts

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
  private var fallbackVoiceId: String? = null
  private var defaultModelId: String? = null
  private var currentModelId: String? = null
  private var defaultOutputFormat: String? = null
  private var apiKey: String? = null
  private var voiceAliases: Map<String, String> = emptyMap()
  // Interrupt-on-speech is disabled by default: starting a SpeechRecognizer during
  // TTS creates an audio session conflict on OxygenOS/OnePlus that causes AudioTrack
  // write to return 0 and MediaPlayer to error. Can be enabled via gateway talk config.
  private var activeProviderIsElevenLabs: Boolean = true
  private var interruptOnSpeech: Boolean = false
  private var voiceOverrideActive = false
  private var modelOverrideActive = false
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
  private var streamingSource: StreamingMediaDataSource? = null
  private var pcmTrack: AudioTrack? = null
  @Volatile private var pcmStopRequested = false
  @Volatile private var finalizeInFlight = false
  private var listenWatchdogJob: Job? = null
  private var systemTts: TextToSpeech? = null
  private var systemTtsPending: CompletableDeferred<Unit>? = null
  private var systemTtsPendingId: String? = null

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

  // Streaming TTS: active session keyed by runId
  private var streamingTts: ElevenLabsStreamingTts? = null
  private var streamingFullText: String = ""
  @Volatile private var lastHandledStreamingRunId: String? = null
  private var drainingTts: ElevenLabsStreamingTts? = null

  private fun stopActiveStreamingTts() {
    streamingTts?.stop()
    streamingTts = null
    drainingTts?.stop()
    drainingTts = null
    streamingFullText = ""
  }

  /** Handle agent stream events — only speak assistant text, not tool calls or thinking. */
  private fun handleAgentStreamEvent(payloadJson: String?) {
    if (payloadJson.isNullOrBlank()) return
    val payload = try {
      json.parseToJsonElement(payloadJson).asObjectOrNull()
    } catch (_: Throwable) { null } ?: return

    // Only speak events for the active session — prevents TTS leaking from
    // concurrent sessions/channels (privacy + correctness).
    val eventSession = payload["sessionKey"]?.asStringOrNull()
    val activeSession = mainSessionKey.ifBlank { "main" }
    if (eventSession != null && eventSession != activeSession) return

    val stream = payload["stream"]?.asStringOrNull() ?: return
    if (stream != "assistant") return  // Only speak assistant text
    val data = payload["data"]?.asObjectOrNull() ?: return
    if (data["type"]?.asStringOrNull() == "thinking") return  // Skip thinking tokens
    val text = data["text"]?.asStringOrNull()?.trim() ?: return
    if (text.isEmpty()) return
    if (!playbackEnabled) {
      stopActiveStreamingTts()
      return
    }

    // Start streaming session if not already active
    if (streamingTts == null) {
      if (!activeProviderIsElevenLabs) return  // Non-ElevenLabs provider — skip streaming TTS
      val voiceId = currentVoiceId ?: defaultVoiceId
      val apiKey = this.apiKey
      if (voiceId == null || apiKey == null) {
        Log.w(tag, "streaming TTS: missing voiceId or apiKey")
        return
      }
      val modelId = currentModelId ?: defaultModelId ?: ""
      val streamModel = if (ElevenLabsStreamingTts.supportsStreaming(modelId)) {
        modelId
      } else {
        "eleven_flash_v2_5"
      }
      val tts = ElevenLabsStreamingTts(
        scope = scope,
        voiceId = voiceId,
        apiKey = apiKey,
        modelId = streamModel,
        outputFormat = "pcm_24000",
        sampleRate = 24000,
      )
      streamingTts = tts
      streamingFullText = ""
      _isSpeaking.value = true
      _statusText.value = "Speaking…"
      tts.start()
      Log.d(tag, "streaming TTS started for agent assistant text")
      lastHandledStreamingRunId = null  // will be set on final
    }

    val accepted = streamingTts?.sendText(text) ?: false
    if (!accepted && streamingTts != null) {
      Log.d(tag, "text diverged, restarting streaming TTS")
      streamingTts?.stop()
      streamingTts = null
      // Restart with the new text
      val voiceId2 = currentVoiceId ?: defaultVoiceId
      val apiKey2 = this.apiKey
      if (voiceId2 != null && apiKey2 != null) {
        val modelId2 = currentModelId ?: defaultModelId ?: ""
        val streamModel2 = if (ElevenLabsStreamingTts.supportsStreaming(modelId2)) modelId2 else "eleven_flash_v2_5"
        val newTts = ElevenLabsStreamingTts(
          scope = scope, voiceId = voiceId2, apiKey = apiKey2,
          modelId = streamModel2, outputFormat = "pcm_24000", sampleRate = 24000,
        )
        streamingTts = newTts
        streamingFullText = text
        newTts.start()
        newTts.sendText(streamingFullText)
        Log.d(tag, "streaming TTS restarted with new text")
      }
    }
  }

  /** Called when chat final/error/aborted arrives — finish any active streaming TTS. */
  private fun finishStreamingTts() {
    streamingFullText = ""
    val tts = streamingTts ?: return
    // Null out immediately so the next response creates a fresh TTS instance.
    // The drain coroutine below holds a reference to this instance for cleanup.
    streamingTts = null
    drainingTts = tts
    tts.finish()
    scope.launch {
      delay(500)
      while (tts.isPlaying.value) { delay(200) }
      if (drainingTts === tts) drainingTts = null
      _isSpeaking.value = false
      _statusText.value = "Ready"
    }
  }

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
      handleAgentStreamEvent(payloadJson)
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
      if (ttsOnAllResponses && state in listOf("final", "error", "aborted")) {
        // Skip if we already handled TTS for this run (multiple final events
        // can arrive on different threads for the same run).
        if (lastHandledStreamingRunId == runId) {
          if (pending == null || runId != pending) return
        }
        lastHandledStreamingRunId = runId
        val stts = streamingTts
        if (stts != null) {
          // Finish streaming and let the drain coroutine handle playback completion.
          // Don’t check hasReceivedAudio synchronously — audio may still be in flight
          // from the WebSocket (EOS was just sent). The drain coroutine in finishStreamingTts
          // waits for playback to complete; if ElevenLabs truly fails, the user just won’t
          // hear anything (silent failure is better than double-speaking with system TTS).
          finishStreamingTts()
        } else if (state == "final") {
          // No streaming was active — fall back to non-streaming
          val text = extractTextFromChatEventMessage(obj["message"])
          if (!text.isNullOrBlank()) {
            playTtsForText(text)
          }
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
      stopActiveStreamingTts()
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
    _usingFallbackTts.value = false
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
    systemTts?.stop()
    systemTtsPending?.cancel()
    systemTtsPending = null
    systemTtsPendingId = null
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
    val resolvedVoice = resolveVoiceAlias(requestedVoice)
    if (requestedVoice != null && resolvedVoice == null) {
      Log.w(tag, "unknown voice alias: $requestedVoice")
    }

    if (directive?.voiceId != null) {
      if (directive.once != true) {
        currentVoiceId = resolvedVoice
        voiceOverrideActive = true
      }
    }
    if (directive?.modelId != null) {
      if (directive.once != true) {
        currentModelId = directive.modelId
        modelOverrideActive = true
      }
    }
    ensurePlaybackActive(playbackToken)

    val apiKey =
      apiKey?.trim()?.takeIf { it.isNotEmpty() }
        ?: System.getenv("ELEVENLABS_API_KEY")?.trim()
    val preferredVoice = resolvedVoice ?: currentVoiceId ?: defaultVoiceId
    val voiceId =
      if (!apiKey.isNullOrEmpty()) {
        resolveVoiceId(preferredVoice, apiKey)
      } else {
        null
      }

    _statusText.value = "Speaking…"
    _isSpeaking.value = true
    lastSpokenText = cleaned
    ensureInterruptListener()
    requestAudioFocusForTts()

    try {
      val canUseElevenLabs = !voiceId.isNullOrBlank() && !apiKey.isNullOrEmpty()
      if (!canUseElevenLabs) {
        if (voiceId.isNullOrBlank()) {
          Log.w(tag, "missing voiceId; falling back to system voice")
        }
        if (apiKey.isNullOrEmpty()) {
          Log.w(tag, "missing ELEVENLABS_API_KEY; falling back to system voice")
        }
        ensurePlaybackActive(playbackToken)
        _usingFallbackTts.value = true
        _statusText.value = "Speaking (System)…"
        speakWithSystemTts(cleaned, playbackToken)
      } else {
        _usingFallbackTts.value = false
        val ttsStarted = SystemClock.elapsedRealtime()
        val modelId = directive?.modelId ?: currentModelId ?: defaultModelId
        val request =
          ElevenLabsRequest(
            text = cleaned,
            modelId = modelId,
            outputFormat =
              TalkModeRuntime.validatedOutputFormat(directive?.outputFormat ?: defaultOutputFormat),
            speed = TalkModeRuntime.resolveSpeed(directive?.speed, directive?.rateWpm),
            stability = TalkModeRuntime.validatedStability(directive?.stability, modelId),
            similarity = TalkModeRuntime.validatedUnit(directive?.similarity),
            style = TalkModeRuntime.validatedUnit(directive?.style),
            speakerBoost = directive?.speakerBoost,
            seed = TalkModeRuntime.validatedSeed(directive?.seed),
            normalize = TalkModeRuntime.validatedNormalize(directive?.normalize),
            language = TalkModeRuntime.validatedLanguage(directive?.language),
            latencyTier = TalkModeRuntime.validatedLatencyTier(directive?.latencyTier),
          )
        streamAndPlay(voiceId = voiceId!!, apiKey = apiKey!!, request = request, playbackToken = playbackToken)
        Log.d(tag, "elevenlabs stream ok durMs=${SystemClock.elapsedRealtime() - ttsStarted}")
      }
    } catch (err: Throwable) {
      if (isPlaybackCancelled(err, playbackToken)) {
        Log.d(tag, "assistant speech cancelled")
        return
      }
      Log.w(tag, "speak failed: ${err.message ?: err::class.simpleName}; falling back to system voice")
      try {
        ensurePlaybackActive(playbackToken)
        _usingFallbackTts.value = true
        _statusText.value = "Speaking (System)…"
        speakWithSystemTts(cleaned, playbackToken)
      } catch (fallbackErr: Throwable) {
        if (isPlaybackCancelled(fallbackErr, playbackToken)) {
          Log.d(tag, "assistant fallback speech cancelled")
          return
        }
        _statusText.value = "Speak failed: ${fallbackErr.message ?: fallbackErr::class.simpleName}"
        Log.w(tag, "system voice failed: ${fallbackErr.message ?: fallbackErr::class.simpleName}")
      }
    } finally {

      _isSpeaking.value = false
    }
  }

  private suspend fun streamAndPlay(
    voiceId: String,
    apiKey: String,
    request: ElevenLabsRequest,
    playbackToken: Long,
  ) {
    ensurePlaybackActive(playbackToken)
    stopSpeaking(resetInterrupt = false)
    ensurePlaybackActive(playbackToken)

    pcmStopRequested = false
    val pcmSampleRate = TalkModeRuntime.parsePcmSampleRate(request.outputFormat)
    if (pcmSampleRate != null) {
      try {
        streamAndPlayPcm(
          voiceId = voiceId,
          apiKey = apiKey,
          request = request,
          sampleRate = pcmSampleRate,
          playbackToken = playbackToken,
        )
        return
      } catch (err: Throwable) {
        if (isPlaybackCancelled(err, playbackToken) || pcmStopRequested) return
        Log.w(tag, "pcm playback failed; falling back to mp3: ${err.message ?: err::class.simpleName}")
      }
    }

    // When falling back from PCM, rewrite format to MP3 and download to file.
    // File-based playback avoids custom DataSource races and is reliable across OEMs.
    val mp3Request = if (request.outputFormat?.startsWith("pcm_") == true) {
      request.copy(outputFormat = "mp3_44100_128")
    } else {
      request
    }
    streamAndPlayMp3(voiceId = voiceId, apiKey = apiKey, request = mp3Request, playbackToken = playbackToken)
  }

  private suspend fun streamAndPlayMp3(
    voiceId: String,
    apiKey: String,
    request: ElevenLabsRequest,
    playbackToken: Long,
  ) {
    val dataSource = StreamingMediaDataSource()
    streamingSource = dataSource

    val player = MediaPlayer()
    this.player = player

    val prepared = CompletableDeferred<Unit>()
    val finished = CompletableDeferred<Unit>()

    player.setAudioAttributes(
      AudioAttributes.Builder()
        .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
        .setUsage(AudioAttributes.USAGE_MEDIA)
        .build(),
    )
    player.setOnPreparedListener {
      it.start()
      prepared.complete(Unit)
    }
    player.setOnCompletionListener {
      finished.complete(Unit)
    }
    player.setOnErrorListener { _, _, _ ->
      finished.completeExceptionally(IllegalStateException("MediaPlayer error"))
      true
    }

    player.setDataSource(dataSource)
    withContext(Dispatchers.Main) {
      player.prepareAsync()
    }

    val fetchError = CompletableDeferred<Throwable?>()
    val fetchJob =
      scope.launch(Dispatchers.IO) {
        try {
          streamTts(voiceId = voiceId, apiKey = apiKey, request = request, sink = dataSource, playbackToken = playbackToken)
          fetchError.complete(null)
        } catch (err: Throwable) {
          dataSource.fail()
          fetchError.complete(err)
        }
      }

    Log.d(tag, "play start")
    try {
      ensurePlaybackActive(playbackToken)
      prepared.await()
      ensurePlaybackActive(playbackToken)
      finished.await()
      ensurePlaybackActive(playbackToken)
      fetchError.await()?.let { throw it }
    } finally {
      fetchJob.cancel()
      cleanupPlayer()
    }
    Log.d(tag, "play done")
  }

  /**
   * Download ElevenLabs audio to a temp file, then play from disk via MediaPlayer.
   * Simpler and more reliable than streaming: avoids custom DataSource races and
   * AudioTrack underrun issues on OxygenOS/OnePlus.
   */
  private suspend fun streamAndPlayViaFile(voiceId: String, apiKey: String, request: ElevenLabsRequest) {
    val tempFile = withContext(Dispatchers.IO) {
      val file = File.createTempFile("tts_", ".mp3", context.cacheDir)
      val conn = openTtsConnection(voiceId = voiceId, apiKey = apiKey, request = request)
      try {
        val payload = buildRequestPayload(request)
        conn.outputStream.use { it.write(payload.toByteArray()) }
        val code = conn.responseCode
        if (code >= 400) {
          val body = conn.errorStream?.readBytes()?.toString(Charsets.UTF_8) ?: ""
          file.delete()
          throw IllegalStateException("ElevenLabs failed: $code $body")
        }
        Log.d(tag, "elevenlabs http code=$code voiceId=$voiceId format=${request.outputFormat}")
        // Manual loop so cancellation is honoured on every chunk.
        // input.copyTo() is a single blocking call with no yield points; if the
        // coroutine is cancelled mid-download the entire response would finish
        // before cancellation was observed.
        conn.inputStream.use { input ->
          file.outputStream().use { out ->
            val buf = ByteArray(8192)
            var n: Int
            while (input.read(buf).also { n = it } != -1) {
              ensureActive()
              out.write(buf, 0, n)
            }
          }
        }
      } catch (err: Throwable) {
        file.delete()
        throw err
      } finally {
        conn.disconnect()
      }
      file
    }
    try {
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
      Log.d(tag, "file play start bytes=${tempFile.length()}")
      player.start()
      finished.await()
      Log.d(tag, "file play done")
    } finally {
      try { cleanupPlayer() } catch (_: Throwable) {}
      tempFile.delete()
    }
  }

  private suspend fun streamAndPlayPcm(
    voiceId: String,
    apiKey: String,
    request: ElevenLabsRequest,
    sampleRate: Int,
    playbackToken: Long,
  ) {
    ensurePlaybackActive(playbackToken)
    val minBuffer =
      AudioTrack.getMinBufferSize(
        sampleRate,
        AudioFormat.CHANNEL_OUT_MONO,
        AudioFormat.ENCODING_PCM_16BIT,
      )
    if (minBuffer <= 0) {
      throw IllegalStateException("AudioTrack buffer size invalid: $minBuffer")
    }

    val bufferSize = max(minBuffer * 2, 8 * 1024)
    val track =
      AudioTrack(
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
      throw IllegalStateException("AudioTrack init failed")
    }
    pcmTrack = track
    // Don't call track.play() yet — start the track only when the first audio
    // chunk arrives from ElevenLabs (see streamPcm). OxygenOS/OnePlus kills an
    // AudioTrack that underruns (no data written) for ~1+ seconds, causing
    // write() to return 0. Deferring play() until first data avoids the underrun.

    Log.d(tag, "pcm play start sampleRate=$sampleRate bufferSize=$bufferSize")
    try {
      streamPcm(voiceId = voiceId, apiKey = apiKey, request = request, track = track, playbackToken = playbackToken)
    } finally {
      cleanupPcmTrack()
    }
    Log.d(tag, "pcm play done")
  }

  private suspend fun speakWithSystemTts(text: String, playbackToken: Long) {
    val trimmed = text.trim()
    if (trimmed.isEmpty()) return
    ensurePlaybackActive(playbackToken)
    val ok = ensureSystemTts()
    if (!ok) {
      throw IllegalStateException("system TTS unavailable")
    }
    ensurePlaybackActive(playbackToken)

    val tts = systemTts ?: throw IllegalStateException("system TTS unavailable")
    val utteranceId = "talk-${UUID.randomUUID()}"
    val deferred = CompletableDeferred<Unit>()
    systemTtsPending?.cancel()
    systemTtsPending = deferred
    systemTtsPendingId = utteranceId

    withContext(Dispatchers.Main) {
      ensurePlaybackActive(playbackToken)
      val params = Bundle()
      tts.speak(trimmed, TextToSpeech.QUEUE_FLUSH, params, utteranceId)
    }

    withContext(Dispatchers.IO) {
      try {
        kotlinx.coroutines.withTimeout(180_000) { deferred.await() }
      } catch (err: Throwable) {
        throw err
      }
      ensurePlaybackActive(playbackToken)
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

  /** Stop any active TTS immediately — call when user taps mic to barge in. */
  fun stopTts() {
    stopActiveStreamingTts()
    stopSpeaking(resetInterrupt = true)
    _isSpeaking.value = false
    _statusText.value = "Listening"
  }

  private fun stopSpeaking(resetInterrupt: Boolean = true) {
    pcmStopRequested = true
    if (!_isSpeaking.value) {
      cleanupPlayer()
      cleanupPcmTrack()
      systemTts?.stop()
      systemTtsPending?.cancel()
      systemTtsPending = null
      systemTtsPendingId = null
      abandonAudioFocus()
      return
    }
    if (resetInterrupt) {
      val currentMs = player?.currentPosition?.toDouble() ?: 0.0
      lastInterruptedAtSeconds = currentMs / 1000.0
    }
    cleanupPlayer()
    cleanupPcmTrack()
    systemTts?.stop()
    systemTtsPending?.cancel()
    systemTtsPending = null
    systemTtsPendingId = null
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
    return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
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
      result == AudioManager.AUDIOFOCUS_REQUEST_GRANTED || result == AudioManager.AUDIOFOCUS_REQUEST_DELAYED
    } else {
      @Suppress("DEPRECATION")
      val result = am.requestAudioFocus(
        audioFocusListener,
        AudioManager.STREAM_MUSIC,
        AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK,
      )
      result == AudioManager.AUDIOFOCUS_REQUEST_GRANTED
    }
  }

  private fun abandonAudioFocus() {
    val am = context.getSystemService(Context.AUDIO_SERVICE) as? AudioManager ?: return
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      audioFocusRequest?.let {
        am.abandonAudioFocusRequest(it)
        Log.d(tag, "audio focus abandoned")
      }
      audioFocusRequest = null
    } else {
      @Suppress("DEPRECATION")
      am.abandonAudioFocus(audioFocusListener)
    }
  }

  private fun cleanupPlayer() {
    player?.stop()
    player?.release()
    player = null
    streamingSource?.close()
    streamingSource = null
  }

  private fun cleanupPcmTrack() {
    val track = pcmTrack ?: return
    try {
      track.pause()
      track.flush()
      track.stop()
    } catch (_: Throwable) {
      // ignore cleanup errors
    } finally {
      track.release()
    }
    pcmTrack = null
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
    val envVoice = System.getenv("ELEVENLABS_VOICE_ID")?.trim()
    val sagVoice = System.getenv("SAG_VOICE_ID")?.trim()
    val envKey = System.getenv("ELEVENLABS_API_KEY")?.trim()
    try {
      val res = session.request("talk.config", """{"includeSecrets":true}""")
      val root = json.parseToJsonElement(res).asObjectOrNull()
      val config = root?.get("config").asObjectOrNull()
      val talk = config?.get("talk").asObjectOrNull()
      val selection = selectTalkProviderConfig(talk)
      val activeProvider = selection?.provider ?: defaultTalkProvider
      val activeConfig = selection?.config
      val sessionCfg = config?.get("session").asObjectOrNull()
      val mainKey = normalizeMainKey(sessionCfg?.get("mainKey").asStringOrNull())
      val voice = activeConfig?.get("voiceId")?.asStringOrNull()?.trim()?.takeIf { it.isNotEmpty() }
      val aliases =
        activeConfig?.get("voiceAliases").asObjectOrNull()?.entries?.mapNotNull { (key, value) ->
          val id = value.asStringOrNull()?.trim()?.takeIf { it.isNotEmpty() } ?: return@mapNotNull null
          normalizeAliasKey(key).takeIf { it.isNotEmpty() }?.let { it to id }
        }?.toMap().orEmpty()
      val model = activeConfig?.get("modelId")?.asStringOrNull()?.trim()?.takeIf { it.isNotEmpty() }
      val outputFormat =
        activeConfig?.get("outputFormat")?.asStringOrNull()?.trim()?.takeIf { it.isNotEmpty() }
      val key = activeConfig?.get("apiKey")?.asStringOrNull()?.trim()?.takeIf { it.isNotEmpty() }
      val interrupt = talk?.get("interruptOnSpeech")?.asBooleanOrNull()

      if (!isCanonicalMainSessionKey(mainSessionKey)) {
        mainSessionKey = mainKey
      }
      defaultVoiceId =
        if (activeProvider == defaultTalkProvider) {
          voice ?: envVoice?.takeIf { it.isNotEmpty() } ?: sagVoice?.takeIf { it.isNotEmpty() }
        } else {
          voice
        }
      voiceAliases = aliases
      if (!voiceOverrideActive) currentVoiceId = defaultVoiceId
      defaultModelId = model ?: defaultModelIdFallback
      if (!modelOverrideActive) currentModelId = defaultModelId
      defaultOutputFormat = outputFormat ?: defaultOutputFormatFallback
      apiKey = key ?: envKey?.takeIf { it.isNotEmpty() }
      Log.d(tag, "reloadConfig apiKey=${if (apiKey != null) "set" else "null"} voiceId=$defaultVoiceId")
      if (interrupt != null) interruptOnSpeech = interrupt
      activeProviderIsElevenLabs = activeProvider == defaultTalkProvider
      if (!activeProviderIsElevenLabs) {
        // Clear ElevenLabs credentials so playAssistant won't attempt ElevenLabs calls
        apiKey = null
        defaultVoiceId = null
        if (!voiceOverrideActive) currentVoiceId = null
        Log.w(tag, "talk provider $activeProvider unsupported; using system voice fallback")
      } else if (selection?.normalizedPayload == true) {
        Log.d(tag, "talk config provider=elevenlabs")
      }
      configLoaded = true
    } catch (_: Throwable) {
      defaultVoiceId = envVoice?.takeIf { it.isNotEmpty() } ?: sagVoice?.takeIf { it.isNotEmpty() }
      defaultModelId = defaultModelIdFallback
      if (!modelOverrideActive) currentModelId = defaultModelId
      apiKey = envKey?.takeIf { it.isNotEmpty() }
      voiceAliases = emptyMap()
      defaultOutputFormat = defaultOutputFormatFallback
      // Keep config load retryable after transient fetch failures.
      configLoaded = false
    }
  }

  private fun parseRunId(jsonString: String): String? {
    val obj = json.parseToJsonElement(jsonString).asObjectOrNull() ?: return null
    return obj["runId"].asStringOrNull()
  }

  private suspend fun streamTts(
    voiceId: String,
    apiKey: String,
    request: ElevenLabsRequest,
    sink: StreamingMediaDataSource,
    playbackToken: Long,
  ) {
    withContext(Dispatchers.IO) {
      ensurePlaybackActive(playbackToken)
      val conn = openTtsConnection(voiceId = voiceId, apiKey = apiKey, request = request)
      try {
        val payload = buildRequestPayload(request)
        conn.outputStream.use { it.write(payload.toByteArray()) }

        val code = conn.responseCode
        Log.d(tag, "elevenlabs http code=$code voiceId=$voiceId format=${request.outputFormat} keyLen=${apiKey.length}")
        if (code >= 400) {
          val message = conn.errorStream?.readBytes()?.toString(Charsets.UTF_8) ?: ""
          Log.w(tag, "elevenlabs error code=$code voiceId=$voiceId body=$message")
          sink.fail()
          throw IllegalStateException("ElevenLabs failed: $code $message")
        }

        val buffer = ByteArray(8 * 1024)
        conn.inputStream.use { input ->
          while (true) {
            ensurePlaybackActive(playbackToken)
            val read = input.read(buffer)
            if (read <= 0) break
            ensurePlaybackActive(playbackToken)
            sink.append(buffer.copyOf(read))
          }
        }
        sink.finish()
      } finally {
        conn.disconnect()
      }
    }
  }

  private suspend fun streamPcm(
    voiceId: String,
    apiKey: String,
    request: ElevenLabsRequest,
    track: AudioTrack,
    playbackToken: Long,
  ) {
    withContext(Dispatchers.IO) {
      ensurePlaybackActive(playbackToken)
      val conn = openTtsConnection(voiceId = voiceId, apiKey = apiKey, request = request)
      try {
        val payload = buildRequestPayload(request)
        conn.outputStream.use { it.write(payload.toByteArray()) }

        val code = conn.responseCode
        if (code >= 400) {
          val message = conn.errorStream?.readBytes()?.toString(Charsets.UTF_8) ?: ""
          throw IllegalStateException("ElevenLabs failed: $code $message")
        }

        var totalBytesWritten = 0L
        var trackStarted = false
        val buffer = ByteArray(8 * 1024)
        conn.inputStream.use { input ->
          while (true) {
            if (pcmStopRequested || isPlaybackCancelled(null, playbackToken)) return@withContext
            val read = input.read(buffer)
            if (read <= 0) break
            // Start the AudioTrack only when the first chunk is ready — avoids
            // the ~1.4s underrun window while ElevenLabs prepares audio.
            // OxygenOS kills a track that underruns for >1s (write() returns 0).
            if (!trackStarted) {
              track.play()
              trackStarted = true
            }
            var offset = 0
            while (offset < read) {
              if (pcmStopRequested || isPlaybackCancelled(null, playbackToken)) return@withContext
              val wrote =
                try {
                  track.write(buffer, offset, read - offset)
                } catch (err: Throwable) {
                  if (pcmStopRequested || isPlaybackCancelled(err, playbackToken)) return@withContext
                  throw err
                }
              if (wrote <= 0) {
                if (pcmStopRequested || isPlaybackCancelled(null, playbackToken)) return@withContext
                throw IllegalStateException("AudioTrack write failed: $wrote")
              }
              offset += wrote
            }
          }
        }
      } finally {
        conn.disconnect()
      }
    }
  }

  private suspend fun waitForPcmDrain(track: AudioTrack, totalFrames: Long, sampleRate: Int) {
    if (totalFrames <= 0) return
    withContext(Dispatchers.IO) {
      val drainDeadline = SystemClock.elapsedRealtime() + 15_000
      while (!pcmStopRequested && SystemClock.elapsedRealtime() < drainDeadline) {
        val played = track.playbackHeadPosition.toLong().and(0xFFFFFFFFL)
        if (played >= totalFrames) break
        val remainingFrames = totalFrames - played
        val sleepMs = ((remainingFrames * 1000L) / sampleRate.toLong()).coerceIn(12L, 120L)
        delay(sleepMs)
      }
    }
  }

  private fun openTtsConnection(
    voiceId: String,
    apiKey: String,
    request: ElevenLabsRequest,
  ): HttpURLConnection {
    val baseUrl = "https://api.elevenlabs.io/v1/text-to-speech/$voiceId/stream"
    val latencyTier = request.latencyTier
    val url =
      if (latencyTier != null) {
        URL("$baseUrl?optimize_streaming_latency=$latencyTier")
      } else {
        URL(baseUrl)
      }
    val conn = url.openConnection() as HttpURLConnection
    conn.requestMethod = "POST"
    conn.connectTimeout = 30_000
    conn.readTimeout = 30_000
    conn.setRequestProperty("Content-Type", "application/json")
    conn.setRequestProperty("Accept", resolveAcceptHeader(request.outputFormat))
    conn.setRequestProperty("xi-api-key", apiKey)
    conn.doOutput = true
    return conn
  }

  private fun resolveAcceptHeader(outputFormat: String?): String {
    val normalized = outputFormat?.trim()?.lowercase().orEmpty()
    return if (normalized.startsWith("pcm_")) "audio/pcm" else "audio/mpeg"
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
    val latencyTier: Int?,
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

    fun validatedOutputFormat(value: String?): String? {
      val trimmed = value?.trim()?.lowercase() ?: return null
      if (trimmed.isEmpty()) return null
      if (trimmed.startsWith("mp3_")) return trimmed
      return if (parsePcmSampleRate(trimmed) != null) trimmed else null
    }

    fun validatedLatencyTier(value: Int?): Int? {
      if (value == null) return null
      if (value < 0 || value > 4) return null
      return value
    }

    fun parsePcmSampleRate(value: String?): Int? {
      val trimmed = value?.trim()?.lowercase() ?: return null
      if (!trimmed.startsWith("pcm_")) return null
      val suffix = trimmed.removePrefix("pcm_")
      val digits = suffix.takeWhile { it.isDigit() }
      val rate = digits.toIntOrNull() ?: return null
      return if (rate in setOf(16000, 22050, 24000, 44100)) rate else null
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

  private fun resolveVoiceAlias(value: String?): String? {
    val trimmed = value?.trim().orEmpty()
    if (trimmed.isEmpty()) return null
    val normalized = normalizeAliasKey(trimmed)
    voiceAliases[normalized]?.let { return it }
    if (voiceAliases.values.any { it.equals(trimmed, ignoreCase = true) }) return trimmed
    return if (isLikelyVoiceId(trimmed)) trimmed else null
  }

  private suspend fun resolveVoiceId(preferred: String?, apiKey: String): String? {
    val trimmed = preferred?.trim().orEmpty()
    if (trimmed.isNotEmpty()) {
      val resolved = resolveVoiceAlias(trimmed)
      // If it resolves as an alias, use the alias target.
      // Otherwise treat it as a direct voice ID (e.g. "21m00Tcm4TlvDq8ikWAM").
      return resolved ?: trimmed
    }
    fallbackVoiceId?.let { return it }

    return try {
      val voices = listVoices(apiKey)
      val first = voices.firstOrNull() ?: return null
      fallbackVoiceId = first.voiceId
      if (defaultVoiceId.isNullOrBlank()) {
        defaultVoiceId = first.voiceId
      }
      if (!voiceOverrideActive) {
        currentVoiceId = first.voiceId
      }
      val name = first.name ?: "unknown"
      Log.d(tag, "default voice selected $name (${first.voiceId})")
      first.voiceId
    } catch (err: Throwable) {
      Log.w(tag, "list voices failed: ${err.message ?: err::class.simpleName}")
      null
    }
  }

  private suspend fun listVoices(apiKey: String): List<ElevenLabsVoice> {
    return withContext(Dispatchers.IO) {
      val url = URL("https://api.elevenlabs.io/v1/voices")
      val conn = url.openConnection() as HttpURLConnection
      conn.requestMethod = "GET"
      conn.connectTimeout = 15_000
      conn.readTimeout = 15_000
      conn.setRequestProperty("xi-api-key", apiKey)

      val code = conn.responseCode
      val stream = if (code >= 400) conn.errorStream else conn.inputStream
      val data = stream.readBytes()
      if (code >= 400) {
        val message = data.toString(Charsets.UTF_8)
        throw IllegalStateException("ElevenLabs voices failed: $code $message")
      }

      val root = json.parseToJsonElement(data.toString(Charsets.UTF_8)).asObjectOrNull()
      val voices = (root?.get("voices") as? JsonArray) ?: JsonArray(emptyList())
      voices.mapNotNull { entry ->
        val obj = entry.asObjectOrNull() ?: return@mapNotNull null
        val voiceId = obj["voice_id"].asStringOrNull() ?: return@mapNotNull null
        val name = obj["name"].asStringOrNull()
        ElevenLabsVoice(voiceId, name)
      }
    }
  }

  private fun isLikelyVoiceId(value: String): Boolean {
    if (value.length < 10) return false
    return value.all { it.isLetterOrDigit() || it == '-' || it == '_' }
  }

  private fun normalizeAliasKey(value: String): String =
    value.trim().lowercase()

  private data class ElevenLabsVoice(val voiceId: String, val name: String?)

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
