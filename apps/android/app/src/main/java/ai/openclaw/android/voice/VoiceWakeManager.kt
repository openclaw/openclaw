package ai.openclaw.android.voice

import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import android.util.Log
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch

/**
 * Always-on wake word manager using continuous SpeechRecognizer cycling.
 *
 * Previous architecture: VAD → start recognizer → user must repeat themselves
 * because the recognizer wasn't ready for the first utterance.
 *
 * New architecture: SpeechRecognizer is always actively listening. Each session:
 *   startListening → partials/results checked for wake word → restart immediately.
 * No VAD gate — zero latency between first sound and recognition start.
 *
 * Trade-off: slightly more battery vs VAD approach. Acceptable for a foreground
 * voice assistant. The proper long-term solution is Porcupine or similar on-device
 * wake word engine (processes audio frames locally, no cloud calls until triggered).
 */
class VoiceWakeManager(
    private val context: Context,
    private val scope: CoroutineScope,
    private val onCommand: suspend (String) -> Unit,
) {
    companion object {
        private const val tag = "VoiceWake"
        // How long to wait before restarting the listen cycle after a normal session end.
        private const val RESTART_DELAY_MS = 100L
        // How long to wait after a recognizer error before restarting.
        private const val ERROR_RESTART_DELAY_MS = 500L
        // Silence duration before the recognizer returns (faster cycling = lower latency).
        private const val SILENCE_TIMEOUT_MS = 1800L
        // Cool-down after wake word dispatch — avoids re-triggering while TalkMode runs.
        private const val WAKE_COOLDOWN_MS = 10_000L
    }

    private val mainHandler = Handler(Looper.getMainLooper())

    private val _isListening = MutableStateFlow(false)
    val isListening: StateFlow<Boolean> = _isListening

    private val _statusText = MutableStateFlow("Off")
    val statusText: StateFlow<String> = _statusText

    var triggerWords: List<String> = emptyList()
        private set

    private var recognizer: SpeechRecognizer? = null
    private var stopRequested = false
    private var suppressedByTalk = false
    private var wakeCooldownJob: Job? = null
    private var restartJob: Job? = null
    // Guard: ignore recognizer callbacks after intentional destroy
    private var ignoreCallbacks = false
    // Wake word detected in partial results — hold the best command seen so far,
    // wait for the FINAL result so we dispatch the full sentence not just the first word.
    private var pendingWakeCommand: String? = null

    fun setTriggerWords(words: List<String>) {
        triggerWords = words
    }

    fun start() {
        mainHandler.post {
            if (_isListening.value) return@post
            stopRequested = false
            if (!SpeechRecognizer.isRecognitionAvailable(context)) {
                _statusText.value = "Speech recognizer unavailable"
                return@post
            }
            Log.d(tag, "start")
            _isListening.value = true
            _statusText.value = "Listening"
            startCycle()
        }
    }

    fun stop(statusText: String = "Off") {
        stopRequested = true
        pendingWakeCommand = null
        wakeCooldownJob?.cancel()
        restartJob?.cancel()
        mainHandler.post {
            ignoreCallbacks = true
            destroyRecognizer()
            _isListening.value = false
            _statusText.value = statusText
        }
    }

    fun setSuppressedByTalk(suppressed: Boolean) {
        if (suppressedByTalk == suppressed) return
        suppressedByTalk = suppressed
        if (suppressed) {
            Log.d(tag, "suppressed by talk")
            restartJob?.cancel()
            mainHandler.post {
                ignoreCallbacks = true
                recognizer?.cancel()
                _statusText.value = "Paused"
            }
        } else {
            Log.d(tag, "resumed from talk suppression")
            scheduleRestart(delayMs = 1500L)
        }
    }

    // ── Core cycling ──────────────────────────────────────────────────────────

    private fun startCycle() {
        if (stopRequested || suppressedByTalk) return
        mainHandler.post {
            if (stopRequested || suppressedByTalk) return@post

            // Recreate recognizer if needed (first start or after RECOGNIZER_BUSY destroy).
            if (recognizer == null) {
                recognizer = createRecognizer()
            }
            ignoreCallbacks = false

            val intent = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
                putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
                putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true)
                putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 3)
                putExtra(RecognizerIntent.EXTRA_CALLING_PACKAGE, context.packageName)
                // Short silence window → faster cycling when nobody is talking.
                // Cloud recognition (no PREFER_OFFLINE) gives better partial results
                // and more accurate short-phrase detection for wake words.
                putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_COMPLETE_SILENCE_LENGTH_MILLIS, SILENCE_TIMEOUT_MS)
                putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_POSSIBLY_COMPLETE_SILENCE_LENGTH_MILLIS, 1200L)
            }
            try {
                recognizer?.startListening(intent)
                Log.d(tag, "cycle started")
            } catch (e: Exception) {
                Log.w(tag, "startListening failed: ${e.message}")
                scheduleRestart(ERROR_RESTART_DELAY_MS)
            }
        }
    }

    private fun scheduleRestart(delayMs: Long = RESTART_DELAY_MS) {
        if (stopRequested) return
        restartJob?.cancel()
        restartJob = scope.launch {
            delay(delayMs)
            if (!stopRequested && !suppressedByTalk) {
                startCycle()
            }
        }
    }

    /**
     * Returns true if a wake command was dispatched (caller should NOT scheduleRestart).
     */
    private fun handleText(text: String, isFinal: Boolean): Boolean {
        if (text.isBlank()) return false
        _statusText.value = "Heard: ${text.take(40)}"
        val command = VoiceWakeCommandExtractor.extractCommand(text, triggerWords)
        if (command == null) {
            // If we had a pending wake from an earlier partial but the latest
            // longer partial lost it (shouldn't happen, but be safe), clear it.
            if (isFinal) pendingWakeCommand = null
            return false
        }
        if (!isFinal) {
            // Wake word detected in partial — save the command but wait for the
            // final result to capture the full sentence (not just the first word).
            Log.d(tag, "wake detected in partial, waiting for final: '$command'")
            pendingWakeCommand = command
            _statusText.value = "Wake detected..."
            return false
        }
        // Final result with wake word — dispatch the full command.
        Log.d(tag, "wake word matched (final) command='$command'")
        pendingWakeCommand = null
        dispatch(command)
        return true  // dispatch() owns the cooldown + restart; caller must not scheduleRestart
    }

    private fun dispatch(command: String) {
        wakeCooldownJob?.cancel()
        restartJob?.cancel()
        // Stop the current recognizer cycle silently while TalkMode handles things.
        mainHandler.post {
            ignoreCallbacks = true
            recognizer?.cancel()
            _statusText.value = "Triggered!"
        }
        scope.launch { onCommand(command) }
        // Re-arm after cooldown (TalkMode will also call setSuppressedByTalk).
        wakeCooldownJob = scope.launch {
            delay(WAKE_COOLDOWN_MS)
            if (!stopRequested && !suppressedByTalk) {
                scheduleRestart(0)
            }
        }
    }

    // ── Helpers ───────────────────────────────────────────────────────────────

    private fun createRecognizer(): SpeechRecognizer {
        val r = SpeechRecognizer.createSpeechRecognizer(context)
        r.setRecognitionListener(listener)
        return r
    }

    private fun destroyRecognizer() {
        recognizer?.cancel()
        recognizer?.setRecognitionListener(null)
        recognizer?.destroy()
        recognizer = null
    }

    // ── RecognitionListener ───────────────────────────────────────────────────

    private val listener = object : RecognitionListener {
        override fun onReadyForSpeech(params: Bundle?) {
            if (ignoreCallbacks) return
            _statusText.value = "Listening"
        }

        override fun onBeginningOfSpeech() {}
        override fun onRmsChanged(rmsdB: Float) {}
        override fun onBufferReceived(buffer: ByteArray?) {}
        override fun onEndOfSpeech() {}
        override fun onEvent(eventType: Int, params: Bundle?) {}

        override fun onPartialResults(partialResults: Bundle?) {
            if (ignoreCallbacks) return
            val text = partialResults
                ?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)
                ?.firstOrNull() ?: return
            handleText(text, isFinal = false)
        }

        override fun onResults(results: Bundle?) {
            if (ignoreCallbacks) return
            val text = results
                ?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)
                ?.firstOrNull() ?: ""
            if (text.isNotBlank()) {
                // If handleText dispatched, it owns the cooldown + restart — bail now.
                if (handleText(text, isFinal = true)) return
            }
            // If handleText didn't dispatch (final had no wake match) but we had
            // a pending wake from a partial — dispatch that fallback now.
            val pending = pendingWakeCommand
            if (pending != null) {
                Log.d(tag, "final lost wake word; dispatching from partial: '$pending'")
                pendingWakeCommand = null
                dispatch(pending)
                return
            }
            // No wake match at all — keep cycling.
            scheduleRestart(RESTART_DELAY_MS)
        }

        override fun onError(error: Int) {
            if (ignoreCallbacks) return
            val msg = when (error) {
                SpeechRecognizer.ERROR_SPEECH_TIMEOUT -> "timeout"
                SpeechRecognizer.ERROR_NO_MATCH -> "no match"
                SpeechRecognizer.ERROR_RECOGNIZER_BUSY -> "busy"
                SpeechRecognizer.ERROR_AUDIO -> "audio"
                SpeechRecognizer.ERROR_NETWORK -> "network"
                SpeechRecognizer.ERROR_SERVER -> "server"
                SpeechRecognizer.ERROR_CLIENT -> "client"
                SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS -> "permissions"
                else -> "error($error)"
            }
            Log.d(tag, "onError: $msg")

            if (error == SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS) {
                stop("Microphone permission required")
                return
            }

            // If we detected a wake word in a partial but the session errored
            // before producing a final result, dispatch the partial command anyway.
            val pending = pendingWakeCommand
            if (pending != null) {
                Log.d(tag, "error during pending wake; dispatching partial: '$pending'")
                pendingWakeCommand = null
                dispatch(pending)
                return
            }

            if (error == SpeechRecognizer.ERROR_RECOGNIZER_BUSY) {
                // Full destroy+recreate required on busy.
                mainHandler.post {
                    destroyRecognizer()
                    recognizer = createRecognizer()
                }
                scheduleRestart(ERROR_RESTART_DELAY_MS)
                return
            }

            // SPEECH_TIMEOUT and NO_MATCH are normal — nobody was talking.
            // Restart quickly. Other errors get a longer back-off.
            val delay = when (error) {
                SpeechRecognizer.ERROR_SPEECH_TIMEOUT,
                SpeechRecognizer.ERROR_NO_MATCH -> RESTART_DELAY_MS
                else -> ERROR_RESTART_DELAY_MS
            }
            scheduleRestart(delay)
        }
    }
}
