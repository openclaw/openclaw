package ai.openclaw.android.voice

import android.Manifest
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import androidx.core.content.ContextCompat
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

class MicCaptureManager(
  private val context: Context,
  private val scope: CoroutineScope,
  private val sendToGateway: suspend (String) -> String?,
) {
  companion object {
    private const val speechMinSessionMs = 30_000L
    private const val speechCompleteSilenceMs = 1_500L
    private const val speechPossibleSilenceMs = 900L
  }

  private val mainHandler = Handler(Looper.getMainLooper())
  private val json = Json { ignoreUnknownKeys = true }

  private val _micEnabled = MutableStateFlow(false)
  val micEnabled: StateFlow<Boolean> = _micEnabled

  private val _isListening = MutableStateFlow(false)
  val isListening: StateFlow<Boolean> = _isListening

  private val _statusText = MutableStateFlow("Mic off")
  val statusText: StateFlow<String> = _statusText

  private val _liveTranscript = MutableStateFlow<String?>(null)
  val liveTranscript: StateFlow<String?> = _liveTranscript

  private val _queuedMessages = MutableStateFlow<List<String>>(emptyList())
  val queuedMessages: StateFlow<List<String>> = _queuedMessages

  private val _inputLevel = MutableStateFlow(0f)
  val inputLevel: StateFlow<Float> = _inputLevel

  private val _isSending = MutableStateFlow(false)
  val isSending: StateFlow<Boolean> = _isSending

  private val messageQueue = ArrayDeque<String>()
  private val sessionSegments = mutableListOf<String>()
  private var lastFinalSegment: String? = null
  private var pendingRunId: String? = null
  private var gatewayConnected = false

  private var recognizer: SpeechRecognizer? = null
  private var restartJob: Job? = null
  private var stopRequested = false

  fun setMicEnabled(enabled: Boolean) {
    if (_micEnabled.value == enabled) return
    _micEnabled.value = enabled
    if (enabled) {
      start()
    } else {
      stop()
      flushSessionToQueue()
      sendQueuedIfIdle()
    }
  }

  fun onGatewayConnectionChanged(connected: Boolean) {
    gatewayConnected = connected
    if (connected) {
      if (!_micEnabled.value) {
        sendQueuedIfIdle()
      }
      return
    }
    if (!_micEnabled.value && messageQueue.isNotEmpty()) {
      _statusText.value = "Queued ${messageQueue.size} message(s) · waiting for gateway"
    }
  }

  fun handleGatewayEvent(event: String, payloadJson: String?) {
    if (event != "chat") return
    val runId = pendingRunId ?: return
    if (payloadJson.isNullOrBlank()) return
    val obj =
      try {
        json.parseToJsonElement(payloadJson).asObjectOrNull()
      } catch (_: Throwable) {
        null
      } ?: return
    val eventRunId = obj["runId"].asStringOrNull() ?: return
    if (eventRunId != runId) return
    val state = obj["state"].asStringOrNull() ?: return
    if (state != "final") return

    if (messageQueue.isNotEmpty()) {
      messageQueue.removeFirst()
      publishQueue()
    }
    pendingRunId = null
    _isSending.value = false
    sendQueuedIfIdle()
  }

  private fun start() {
    stopRequested = false
    if (!SpeechRecognizer.isRecognitionAvailable(context)) {
      _statusText.value = "Speech recognizer unavailable"
      _micEnabled.value = false
      return
    }
    if (!hasMicPermission()) {
      _statusText.value = "Microphone permission required"
      _micEnabled.value = false
      return
    }

    mainHandler.post {
      try {
        if (recognizer == null) {
          recognizer = SpeechRecognizer.createSpeechRecognizer(context).also { it.setRecognitionListener(listener) }
        }
        startListeningSession()
      } catch (err: Throwable) {
        _statusText.value = "Start failed: ${err.message ?: err::class.simpleName}"
        _micEnabled.value = false
      }
    }
  }

  private fun stop() {
    stopRequested = true
    restartJob?.cancel()
    restartJob = null
    _isListening.value = false
    _statusText.value = if (_isSending.value) "Mic off · sending queued messages…" else "Mic off"
    _inputLevel.value = 0f
    mainHandler.post {
      recognizer?.cancel()
      recognizer?.destroy()
      recognizer = null
    }
  }

  private fun startListeningSession() {
    val r = recognizer ?: return
    val intent =
      Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
        putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
        putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true)
        putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 3)
        putExtra(RecognizerIntent.EXTRA_CALLING_PACKAGE, context.packageName)
        putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_MINIMUM_LENGTH_MILLIS, speechMinSessionMs)
        putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_COMPLETE_SILENCE_LENGTH_MILLIS, speechCompleteSilenceMs)
        putExtra(
          RecognizerIntent.EXTRA_SPEECH_INPUT_POSSIBLY_COMPLETE_SILENCE_LENGTH_MILLIS,
          speechPossibleSilenceMs,
        )
      }
    _statusText.value = if (_isSending.value) "Listening · queueing while gateway replies" else "Listening"
    _isListening.value = true
    r.startListening(intent)
  }

  private fun scheduleRestart(delayMs: Long = 350L) {
    if (stopRequested) return
    if (!_micEnabled.value) return
    restartJob?.cancel()
    restartJob =
      scope.launch {
        delay(delayMs)
        mainHandler.post {
          if (stopRequested || !_micEnabled.value) return@post
          try {
            startListeningSession()
          } catch (_: Throwable) {
            // onError will retry
          }
        }
      }
  }

  private fun publishQueue() {
    _queuedMessages.value = messageQueue.toList()
  }

  private fun flushSessionToQueue() {
    val message = sessionSegments.joinToString("\n").trim()
    sessionSegments.clear()
    _liveTranscript.value = null
    lastFinalSegment = null
    if (message.isEmpty()) return
    messageQueue.addLast(message)
    publishQueue()
  }

  private fun sendQueuedIfIdle() {
    if (_micEnabled.value) return
    if (_isSending.value) return
    if (messageQueue.isEmpty()) {
      _statusText.value = "Mic off"
      return
    }
    if (!gatewayConnected) {
      _statusText.value = "Queued ${messageQueue.size} message(s) · waiting for gateway"
      return
    }
    val next = messageQueue.first()
    _isSending.value = true
    _statusText.value = "Sending ${messageQueue.size} queued message(s)…"
    scope.launch {
      try {
        val runId = sendToGateway(next)
        pendingRunId = runId
        if (runId == null) {
          if (messageQueue.isNotEmpty()) {
            messageQueue.removeFirst()
            publishQueue()
          }
          _isSending.value = false
          sendQueuedIfIdle()
        }
      } catch (err: Throwable) {
        _isSending.value = false
        _statusText.value =
          if (!gatewayConnected) {
            "Queued ${messageQueue.size} message(s) · waiting for gateway"
          } else {
            "Send failed: ${err.message ?: err::class.simpleName}"
          }
      }
    }
  }

  private fun disableMic(status: String) {
    stopRequested = true
    restartJob?.cancel()
    restartJob = null
    _micEnabled.value = false
    _isListening.value = false
    _inputLevel.value = 0f
    _statusText.value = status
    mainHandler.post {
      recognizer?.cancel()
      recognizer?.destroy()
      recognizer = null
    }
  }

  private fun onFinalTranscript(text: String) {
    val trimmed = text.trim()
    if (trimmed.isEmpty()) return
    _liveTranscript.value = trimmed
    if (lastFinalSegment == trimmed) return
    lastFinalSegment = trimmed
    sessionSegments.add(trimmed)
  }

  private fun hasMicPermission(): Boolean {
    return (
      ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) ==
        PackageManager.PERMISSION_GRANTED
      )
  }

  private val listener =
    object : RecognitionListener {
      override fun onReadyForSpeech(params: Bundle?) {
        _isListening.value = true
      }

      override fun onBeginningOfSpeech() {}

      override fun onRmsChanged(rmsdB: Float) {
        val level = ((rmsdB + 2f) / 12f).coerceIn(0f, 1f)
        _inputLevel.value = level
      }

      override fun onBufferReceived(buffer: ByteArray?) {}

      override fun onEndOfSpeech() {
        _inputLevel.value = 0f
        scheduleRestart()
      }

      override fun onError(error: Int) {
        if (stopRequested) return
        _isListening.value = false
        _inputLevel.value = 0f
        val status =
          when (error) {
            SpeechRecognizer.ERROR_AUDIO -> "Audio error"
            SpeechRecognizer.ERROR_CLIENT -> "Client error"
            SpeechRecognizer.ERROR_NETWORK -> "Network error"
            SpeechRecognizer.ERROR_NETWORK_TIMEOUT -> "Network timeout"
            SpeechRecognizer.ERROR_NO_MATCH -> "Listening"
            SpeechRecognizer.ERROR_RECOGNIZER_BUSY -> "Recognizer busy"
            SpeechRecognizer.ERROR_SERVER -> "Server error"
            SpeechRecognizer.ERROR_SPEECH_TIMEOUT -> "Listening"
            SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS -> "Microphone permission required"
            SpeechRecognizer.ERROR_LANGUAGE_NOT_SUPPORTED -> "Language not supported on this device"
            SpeechRecognizer.ERROR_LANGUAGE_UNAVAILABLE -> "Language unavailable on this device"
            SpeechRecognizer.ERROR_SERVER_DISCONNECTED -> "Speech service disconnected"
            SpeechRecognizer.ERROR_TOO_MANY_REQUESTS -> "Speech requests limited; retrying"
            else -> "Speech error ($error)"
          }
        _statusText.value = status

        if (
          error == SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS ||
          error == SpeechRecognizer.ERROR_LANGUAGE_NOT_SUPPORTED ||
          error == SpeechRecognizer.ERROR_LANGUAGE_UNAVAILABLE
        ) {
          disableMic(status)
          return
        }
        val restartDelayMs =
          when (error) {
            SpeechRecognizer.ERROR_NO_MATCH,
            SpeechRecognizer.ERROR_SPEECH_TIMEOUT,
            -> 1_500L
            SpeechRecognizer.ERROR_TOO_MANY_REQUESTS -> 2_500L
            else -> 600L
          }
        scheduleRestart(delayMs = restartDelayMs)
      }

      override fun onResults(results: Bundle?) {
        val text = results?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION).orEmpty().firstOrNull()
        if (!text.isNullOrBlank()) onFinalTranscript(text)
        scheduleRestart()
      }

      override fun onPartialResults(partialResults: Bundle?) {
        val text = partialResults?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION).orEmpty().firstOrNull()
        if (!text.isNullOrBlank()) {
          _liveTranscript.value = text.trim()
        }
      }

      override fun onEvent(eventType: Int, params: Bundle?) {}
    }
}

private fun kotlinx.serialization.json.JsonElement?.asObjectOrNull(): JsonObject? =
  this as? JsonObject

private fun kotlinx.serialization.json.JsonElement?.asStringOrNull(): String? =
  (this as? JsonPrimitive)?.takeIf { it.isString }?.content
