package ai.openclaw.app.voice

import ai.openclaw.app.i18n.NativeText
import ai.openclaw.app.i18n.nativeText
import ai.openclaw.app.i18n.resolveNativeText
import android.Manifest
import android.annotation.SuppressLint
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.ParcelFileDescriptor
import android.os.SystemClock
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import android.util.Log
import androidx.annotation.RequiresApi
import androidx.core.content.ContextCompat
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import java.io.IOException
import java.util.Locale
import java.util.concurrent.CountDownLatch
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong
import java.util.concurrent.atomic.AtomicReference

internal sealed interface VoiceWakeRecognitionEvent {
  data object Ready : VoiceWakeRecognitionEvent

  data class Transcript(
    val text: String,
    val isFinal: Boolean,
    /** True when the recognizer keeps listening after this final transcript (segmented session). */
    val sessionContinues: Boolean = false,
  ) : VoiceWakeRecognitionEvent

  data class Error(
    val code: Int,
  ) : VoiceWakeRecognitionEvent
}

internal interface VoiceWakeRecognizer {
  val isAvailable: Boolean

  fun start(
    operationId: Long,
    onEvent: (VoiceWakeRecognitionEvent) -> Unit,
  )

  fun stop(operationId: Long)

  fun destroy(operationId: Long)
}

internal class VoiceWakeRecognitionSession(
  private val onEvent: (VoiceWakeRecognitionEvent) -> Unit,
) {
  private val active = AtomicBoolean(true)

  fun emit(event: VoiceWakeRecognitionEvent) {
    if (active.get()) onEvent(event)
  }

  fun retire() {
    active.set(false)
  }
}

internal class AndroidOnDeviceVoiceWakeRecognizer(
  context: Context,
) : VoiceWakeRecognizer {
  private val appContext = context.applicationContext
  private val mainHandler = Handler(Looper.getMainLooper())
  override val isAvailable: Boolean =
    runCatching { SpeechRecognizer.isOnDeviceRecognitionAvailable(appContext) }.getOrDefault(false)
  private val latestOperationId = AtomicLong(0)
  private val platformOwnerOperationId = AtomicLong(0)
  private var recognizer: SpeechRecognizer? = null
  private var recognitionSession: VoiceWakeRecognitionSession? = null

  private enum class SessionMode {
    /** The app records the microphone itself and streams PCM to the service: no per-session tones, no silence timeout. */
    RawAudio,

    /** One service-owned session that stays open across silences. */
    SilenceSegmented,

    /** Plain session; the service ends it after a few seconds of silence. */
    Single,
  }

  // Start with the richest mode Android offers and demote for good when the service closes a
  // session before it delivered anything (a sign the mode is unsupported here).
  private var sessionMode = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) SessionMode.RawAudio else SessionMode.Single
  private var sessionStartedAtMs = 0L
  private var sessionDeliveredResults = false
  private var audioSource: WakeAudioSource? = null

  override fun start(
    operationId: Long,
    onEvent: (VoiceWakeRecognitionEvent) -> Unit,
  ) {
    if (!claimOperation(operationId)) return
    platformOwnerOperationId.set(operationId)
    if (operationId != latestOperationId.get()) {
      platformOwnerOperationId.compareAndSet(operationId, 0)
      return
    }
    runOnMain {
      if (operationId != latestOperationId.get()) {
        platformOwnerOperationId.compareAndSet(operationId, 0)
        return@runOnMain
      }
      retireRecognizer()
      platformOwnerOperationId.set(operationId)
      if (!isAvailable) {
        platformOwnerOperationId.compareAndSet(operationId, 0)
        onEvent(VoiceWakeRecognitionEvent.Error(SpeechRecognizer.ERROR_SERVER_DISCONNECTED))
        return@runOnMain
      }
      val session = VoiceWakeRecognitionSession(onEvent)
      try {
        val mode = sessionMode
        val active = createRecognizer(session, mode)
        recognitionSession = session
        recognizer = active
        startListening(active, session, operationId, mode)
      } catch (_: Throwable) {
        session.retire()
        retireRecognizer()
        if (operationId == latestOperationId.get()) {
          onEvent(VoiceWakeRecognitionEvent.Error(SpeechRecognizer.ERROR_CLIENT))
        }
      }
    }
  }

  override fun stop(operationId: Long) {
    if (!claimOperation(operationId)) return
    if (platformOwnerOperationId.get() == 0L) return
    runOnMainSync {
      if (operationId == latestOperationId.get()) retireRecognizer()
    }
  }

  override fun destroy(operationId: Long) {
    if (!claimOperation(operationId)) return
    if (platformOwnerOperationId.get() == 0L) return
    runOnMainSync {
      if (operationId == latestOperationId.get()) retireRecognizer()
    }
  }

  private fun claimOperation(operationId: Long): Boolean {
    while (true) {
      val current = latestOperationId.get()
      if (operationId <= current) return false
      if (latestOperationId.compareAndSet(current, operationId)) return true
    }
  }

  private fun createRecognizer(
    session: VoiceWakeRecognitionSession,
    mode: SessionMode,
  ): SpeechRecognizer =
    SpeechRecognizer.createOnDeviceSpeechRecognizer(appContext).also { active ->
      active.setRecognitionListener(
        object : RecognitionListener {
          override fun onReadyForSpeech(params: Bundle?) {
            session.emit(VoiceWakeRecognitionEvent.Ready)
          }

          override fun onResults(results: Bundle?) {
            sessionDeliveredResults = true
            Log.d(TAG, "results: ${bestTranscript(results)}")
            bestTranscript(results)?.let { session.emit(VoiceWakeRecognitionEvent.Transcript(it, isFinal = true)) }
              ?: session.emit(VoiceWakeRecognitionEvent.Error(SpeechRecognizer.ERROR_NO_MATCH))
          }

          override fun onPartialResults(partialResults: Bundle?) {
            bestTranscript(partialResults)?.let {
              session.emit(VoiceWakeRecognitionEvent.Transcript(it, isFinal = false))
            }
          }

          override fun onSegmentResults(segmentResults: Bundle) {
            sessionDeliveredResults = true
            Log.d(TAG, "segment: ${bestTranscript(segmentResults)}")
            // The service keeps listening; a non-matching segment must not restart the session.
            bestTranscript(segmentResults)?.let {
              session.emit(VoiceWakeRecognitionEvent.Transcript(it, isFinal = true, sessionContinues = true))
            }
          }

          override fun onEndOfSegmentedSession() {
            Log.d(TAG, "end of segmented session")
            noteSessionClosed(mode)
            // The manager restarts on this error code after its normal delay.
            session.emit(VoiceWakeRecognitionEvent.Error(SpeechRecognizer.ERROR_SPEECH_TIMEOUT))
          }

          override fun onError(error: Int) {
            Log.d(TAG, "error code=$error")
            noteSessionClosed(mode, error)
            session.emit(VoiceWakeRecognitionEvent.Error(error))
          }

          override fun onBeginningOfSpeech() = Unit

          override fun onRmsChanged(rmsdB: Float) = Unit

          override fun onBufferReceived(buffer: ByteArray?) = Unit

          override fun onEndOfSpeech() = Unit

          override fun onEvent(
            eventType: Int,
            params: Bundle?,
          ) = Unit
        },
      )
    }

  private fun retireRecognizer() {
    // Retire callback ownership before cancel/destroy. Some recognizers emit a
    // late result or error after cancellation; it must not enter a new session.
    recognitionSession?.retire()
    recognitionSession = null
    platformOwnerOperationId.set(0)
    val active = recognizer
    recognizer = null
    runCatching { active?.cancel() }
    runCatching { active?.destroy() }
    audioSource?.close()
    audioSource = null
  }

  private fun runOnMain(action: () -> Unit) {
    if (Looper.myLooper() == Looper.getMainLooper()) action() else mainHandler.post(action)
  }

  private fun runOnMainSync(action: () -> Unit) {
    if (Looper.myLooper() == Looper.getMainLooper()) {
      action()
      return
    }
    val completed = CountDownLatch(1)
    val failure = AtomicReference<Throwable?>()
    check(
      mainHandler.post {
        try {
          action()
        } catch (err: Throwable) {
          failure.set(err)
        } finally {
          completed.countDown()
        }
      },
    ) { "main looper unavailable" }
    completed.await()
    failure.get()?.let { throw it }
  }

  private fun startListening(
    active: SpeechRecognizer,
    session: VoiceWakeRecognitionSession,
    operationId: Long,
    mode: SessionMode,
  ) {
    if (operationId != latestOperationId.get() || recognizer !== active) return
    sessionStartedAtMs = SystemClock.elapsedRealtime()
    sessionDeliveredResults = false
    val intent = recognizerIntent(mode)
    Log.d(TAG, "start mode=$mode")
    active.startListening(intent)
    // With app-supplied audio the service does not report readiness for speech; we own the mic.
    if (mode == SessionMode.RawAudio) session.emit(VoiceWakeRecognitionEvent.Ready)
  }

  private fun noteSessionClosed(
    mode: SessionMode,
    errorCode: Int? = null,
  ) {
    // A missing language or permission says nothing about session-mode support.
    if (errorCode == SpeechRecognizer.ERROR_LANGUAGE_UNAVAILABLE ||
      errorCode == SpeechRecognizer.ERROR_LANGUAGE_NOT_SUPPORTED ||
      errorCode == SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS
    ) {
      return
    }
    if (mode == SessionMode.Single || sessionDeliveredResults || sessionMode != mode) return
    if (SystemClock.elapsedRealtime() - sessionStartedAtMs < SESSION_MIN_LIFETIME_MS) {
      sessionMode = if (mode == SessionMode.RawAudio) SessionMode.SilenceSegmented else SessionMode.Single
      Log.d(TAG, "session mode $mode unsupported here; using $sessionMode")
    }
  }

  private fun recognizerIntent(mode: SessionMode): Intent =
    Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
      putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
      putExtra(RecognizerIntent.EXTRA_LANGUAGE, Locale.getDefault().toLanguageTag())
      putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true)
      putExtra(RecognizerIntent.EXTRA_PREFER_OFFLINE, true)
      putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 3)
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
        when (mode) {
          SessionMode.RawAudio -> applyRawAudioSessionExtras(this)
          SessionMode.SilenceSegmented -> applySegmentedSessionExtras(this)
          SessionMode.Single -> Unit
        }
      }
    }

  @RequiresApi(Build.VERSION_CODES.TIRAMISU)
  private fun applySegmentedSessionExtras(intent: Intent) {
    intent.putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_COMPLETE_SILENCE_LENGTH_MILLIS, 2500)
    intent.putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_POSSIBLY_COMPLETE_SILENCE_LENGTH_MILLIS, 1800)
    intent.putExtra(
      RecognizerIntent.EXTRA_SEGMENTED_SESSION,
      RecognizerIntent.EXTRA_SPEECH_INPUT_COMPLETE_SILENCE_LENGTH_MILLIS,
    )
  }

  @RequiresApi(Build.VERSION_CODES.TIRAMISU)
  @SuppressLint("MissingPermission")
  private fun applyRawAudioSessionExtras(intent: Intent) {
    audioSource?.close()
    val source = WakeAudioSource.open(WAKE_AUDIO_SAMPLE_RATE_HZ)
    audioSource = source
    intent.putExtra(RecognizerIntent.EXTRA_AUDIO_SOURCE, source.readDescriptor)
    intent.putExtra(RecognizerIntent.EXTRA_AUDIO_SOURCE_CHANNEL_COUNT, 1)
    intent.putExtra(RecognizerIntent.EXTRA_AUDIO_SOURCE_ENCODING, AudioFormat.ENCODING_PCM_16BIT)
    intent.putExtra(RecognizerIntent.EXTRA_AUDIO_SOURCE_SAMPLING_RATE, WAKE_AUDIO_SAMPLE_RATE_HZ)
    intent.putExtra(RecognizerIntent.EXTRA_SEGMENTED_SESSION, RecognizerIntent.EXTRA_AUDIO_SOURCE)
  }

  private fun bestTranscript(bundle: Bundle?): String? =
    bundle
      ?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)
      ?.firstOrNull()
      ?.trim()
      ?.takeIf(String::isNotEmpty)

  private companion object {
    const val TAG = "VoiceWake"
    const val SESSION_MIN_LIFETIME_MS = 1_500L
    const val WAKE_AUDIO_SAMPLE_RATE_HZ = 16_000
  }
}

/** Microphone capture streamed to the recognition service over a pipe for one wake session. */
private class WakeAudioSource private constructor(
  val readDescriptor: ParcelFileDescriptor,
  private val writeStream: ParcelFileDescriptor.AutoCloseOutputStream,
  private val recorder: AudioRecord,
  bufferSize: Int,
) {
  @Volatile private var closed = false
  private val pump =
    Thread({
      val buffer = ByteArray(bufferSize)
      try {
        while (!closed) {
          val read = recorder.read(buffer, 0, buffer.size)
          if (read <= 0) break
          writeStream.write(buffer, 0, read)
        }
      } catch (_: IOException) {
        // The service closed its end; the session is over.
      } finally {
        release()
      }
    }, "voice-wake-audio")

  private fun start() {
    pump.isDaemon = true
    pump.start()
  }

  @Synchronized
  fun close() {
    closed = true
    runCatching { recorder.stop() }
    release()
  }

  @Synchronized
  private fun release() {
    runCatching { recorder.stop() }
    runCatching { recorder.release() }
    runCatching { writeStream.close() }
    runCatching { readDescriptor.close() }
  }

  companion object {
    @SuppressLint("MissingPermission")
    fun open(sampleRateHz: Int): WakeAudioSource {
      val minBufferSize = AudioRecord.getMinBufferSize(sampleRateHz, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT)
      check(minBufferSize > 0) { "AudioRecord buffer unavailable" }
      val pipe = ParcelFileDescriptor.createPipe()
      var recorder: AudioRecord? = null
      try {
        recorder =
          AudioRecord(
            MediaRecorder.AudioSource.VOICE_RECOGNITION,
            sampleRateHz,
            AudioFormat.CHANNEL_IN_MONO,
            AudioFormat.ENCODING_PCM_16BIT,
            minBufferSize * 2,
          )
        check(recorder.state == AudioRecord.STATE_INITIALIZED) { "AudioRecord initialization failed" }
        recorder.startRecording()
        check(recorder.recordingState == AudioRecord.RECORDSTATE_RECORDING) { "AudioRecord did not start" }
        return WakeAudioSource(
          readDescriptor = pipe[0],
          writeStream = ParcelFileDescriptor.AutoCloseOutputStream(pipe[1]),
          recorder = recorder,
          bufferSize = minBufferSize.coerceAtLeast(4_096),
        ).also { it.start() }
      } catch (err: Throwable) {
        runCatching { recorder?.stop() }
        runCatching { recorder?.release() }
        runCatching { pipe[1].close() }
        runCatching { pipe[0].close() }
        throw err
      }
    }
  }
}

internal enum class VoiceWakeSuppressionReason {
  Camera,
  Dictation,
  GatewaySync,
  VoiceCapture,
  VoiceNote,
  VoiceReplySpeech,
  MessageSpeech,
}

internal class VoiceWakeManager(
  private val context: Context,
  private val scope: CoroutineScope,
  private val recognizer: VoiceWakeRecognizer,
  initialTriggerWords: List<String>,
  private val onCommand: suspend (VoiceWakeMatch) -> Boolean,
  private val restartDelayMs: Long = 350L,
  private val hasRecordAudioPermission: () -> Boolean = {
    ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED
  },
) {
  private sealed interface RecognizerAction {
    val operationId: Long

    data class Start(
      override val operationId: Long,
      val sessionGeneration: Long,
    ) : RecognizerAction

    data class Stop(
      override val operationId: Long,
    ) : RecognizerAction

    data class Destroy(
      override val operationId: Long,
    ) : RecognizerAction
  }

  private val lock = Any()
  private var enabled = false
  private var foreground = false
  private var backgroundListeningAllowed = false
  private var sessionGeneration = 0L
  private var sessionActive = false
  private var commandInFlight = false
  private var commandJob: Job? = null
  private var restartJob: Job? = null
  private var recognizerOperationId = 0L
  private val suppressionReasons = mutableSetOf<VoiceWakeSuppressionReason>()
  private val suppressionRevisions = mutableMapOf<VoiceWakeSuppressionReason, Long>()
  private var triggerWords = VoiceWakePreferences.sanitizeTriggerWords(initialTriggerWords)

  private val _isListening = MutableStateFlow(false)
  val isListening: StateFlow<Boolean> = _isListening.asStateFlow()

  private val _statusText = MutableStateFlow<NativeText>(nativeText("Off"))
  val statusText: StateFlow<String> = _statusText.resolveNativeText()

  private val _lastTriggeredCommand = MutableStateFlow<String?>(null)
  val lastTriggeredCommand: StateFlow<String?> = _lastTriggeredCommand.asStateFlow()

  val isAvailable: Boolean
    get() = recognizer.isAvailable

  fun setEnabled(value: Boolean) {
    val action =
      synchronized(lock) {
        enabled = value
        reconcileLocked()
      }
    performRecognizerAction(action)
  }

  fun setForeground(value: Boolean) {
    val action =
      synchronized(lock) {
        foreground = value
        reconcileLocked()
      }
    performRecognizerAction(action)
  }

  /**
   * Allows recognition while no Activity is visible. Only the node foreground service may grant
   * this, after the OS accepted its microphone service type; without it Android denies the mic.
   */
  fun setBackgroundListeningAllowed(value: Boolean) {
    val action =
      synchronized(lock) {
        backgroundListeningAllowed = value
        reconcileLocked()
      }
    performRecognizerAction(action)
  }

  fun setSuppressed(
    reason: VoiceWakeSuppressionReason,
    suppressed: Boolean,
    revision: Long? = null,
  ) {
    val action =
      synchronized(lock) {
        if (revision != null) {
          val currentRevision = suppressionRevisions[reason] ?: 0L
          if (revision <= currentRevision) return
          suppressionRevisions[reason] = revision
        }
        if (suppressed) suppressionReasons += reason else suppressionReasons -= reason
        reconcileLocked()
      }
    performRecognizerAction(action)
  }

  fun updateTriggerWords(words: List<String>) {
    synchronized(lock) {
      triggerWords = VoiceWakePreferences.sanitizeTriggerWords(words)
    }
  }

  fun refreshPermission() {
    val action = synchronized(lock) { reconcileLocked() }
    performRecognizerAction(action)
  }

  fun shutdown() {
    val action =
      synchronized(lock) {
        enabled = false
        foreground = false
        val pendingAction = stopSessionLocked(destroy = true)
        _statusText.value = nativeText("Off")
        pendingAction
      }
    performRecognizerAction(action)
  }

  private fun reconcileLocked(): RecognizerAction? {
    val blockedStatus = blockedStatusLocked()
    if (blockedStatus != null) {
      val action = stopSessionLocked(destroy = !enabled || !canListenLocked())
      _statusText.value = blockedStatus
      return action
    }
    if (!sessionActive && !commandInFlight && restartJob?.isActive != true) {
      return startSessionLocked()
    }
    return null
  }

  private fun blockedStatusLocked(): NativeText? =
    when {
      !enabled -> nativeText("Off")
      !recognizer.isAvailable -> nativeText("On-device speech recognition unavailable")
      !hasRecordAudioPermission() -> nativeText("Microphone permission required")
      !canListenLocked() || suppressionReasons.isNotEmpty() -> nativeText("Paused")
      else -> null
    }

  private fun canListenLocked(): Boolean = foreground || backgroundListeningAllowed

  private fun startSessionLocked(): RecognizerAction {
    sessionGeneration += 1
    val generation = sessionGeneration
    sessionActive = true
    _isListening.value = false
    _statusText.value = nativeText("Starting…")
    return RecognizerAction.Start(nextRecognizerOperationIdLocked(), generation)
  }

  private fun handleRecognitionEvent(
    generation: Long,
    event: VoiceWakeRecognitionEvent,
  ) {
    val action =
      synchronized(lock) {
        if (generation != sessionGeneration || !sessionActive) return
        when (event) {
          VoiceWakeRecognitionEvent.Ready -> {
            _isListening.value = true
            _statusText.value = nativeText("Listening")
            null
          }

          is VoiceWakeRecognitionEvent.Transcript -> {
            // Android partials routinely stop mid-command. Only a final transcript
            // has the recognizer's end-of-utterance boundary and is safe to dispatch.
            if (!event.isFinal) return
            val transcriptAction = handleTranscriptLocked(event.text)
            if (transcriptAction == null && !event.sessionContinues) {
              sessionActive = false
              _isListening.value = false
              scheduleRestartLocked()
            }
            transcriptAction
          }

          is VoiceWakeRecognitionEvent.Error -> {
            sessionActive = false
            _isListening.value = false
            if (event.code == SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS) {
              _statusText.value = nativeText("Microphone permission required")
            } else if (event.code == SpeechRecognizer.ERROR_LANGUAGE_NOT_SUPPORTED) {
              _statusText.value = nativeText("Device language not supported")
            } else if (event.code == SpeechRecognizer.ERROR_LANGUAGE_UNAVAILABLE) {
              _statusText.value = nativeText("On-device language model unavailable")
            } else {
              scheduleRestartLocked(delayMs = retryDelayMs(event.code))
            }
            null
          }
        }
      }
    performRecognizerAction(action)
  }

  private fun handleTranscriptLocked(transcript: String): RecognizerAction? {
    if (commandInFlight) return null
    val match = VoiceWakePhraseMatcher.match(transcript, triggerWords) ?: return null
    sessionGeneration += 1
    val commandGeneration = sessionGeneration
    sessionActive = false
    commandInFlight = true
    _isListening.value = false
    _lastTriggeredCommand.value = match.command
    _statusText.value = nativeText("Triggered")
    val action = RecognizerAction.Stop(nextRecognizerOperationIdLocked())
    commandJob =
      scope.launch {
        var delivered = false
        try {
          delivered = onCommand(match)
        } finally {
          synchronized(lock) {
            if (commandGeneration == sessionGeneration) {
              commandJob = null
              commandInFlight = false
              scheduleRestartLocked()
              if (!delivered) _statusText.value = nativeText("Gateway unavailable")
            }
          }
        }
      }
    return action
  }

  private fun scheduleRestartLocked(delayMs: Long = restartDelayMs) {
    restartJob?.cancel()
    val blockedStatus = blockedStatusLocked()
    if (blockedStatus != null) {
      _statusText.value = blockedStatus
      return
    }
    _statusText.value = nativeText("Starting…")
    restartJob =
      scope.launch {
        delay(delayMs)
        val action =
          synchronized(lock) {
            restartJob = null
            reconcileLocked()
          }
        performRecognizerAction(action)
      }
  }

  private fun retryDelayMs(errorCode: Int): Long =
    when (errorCode) {
      SpeechRecognizer.ERROR_TOO_MANY_REQUESTS -> 15_000L

      SpeechRecognizer.ERROR_RECOGNIZER_BUSY,
      SpeechRecognizer.ERROR_SERVER,
      SpeechRecognizer.ERROR_SERVER_DISCONNECTED,
      SpeechRecognizer.ERROR_AUDIO,
      SpeechRecognizer.ERROR_CLIENT,
      -> 1_500L

      else -> restartDelayMs
    }

  private fun stopSessionLocked(destroy: Boolean): RecognizerAction? {
    restartJob?.cancel()
    restartJob = null
    commandJob?.cancel()
    commandJob = null
    commandInFlight = false
    sessionGeneration += 1
    val wasActive = sessionActive
    sessionActive = false
    _isListening.value = false
    return when {
      destroy -> RecognizerAction.Destroy(nextRecognizerOperationIdLocked())
      wasActive -> RecognizerAction.Stop(nextRecognizerOperationIdLocked())
      else -> null
    }
  }

  private fun nextRecognizerOperationIdLocked(): Long {
    recognizerOperationId += 1
    return recognizerOperationId
  }

  private fun performRecognizerAction(action: RecognizerAction?) {
    when (action) {
      is RecognizerAction.Start -> {
        recognizer.start(action.operationId) { event ->
          handleRecognitionEvent(action.sessionGeneration, event)
        }
      }

      is RecognizerAction.Stop -> {
        recognizer.stop(action.operationId)
      }

      is RecognizerAction.Destroy -> {
        recognizer.destroy(action.operationId)
      }

      null -> {}
    }
  }
}

internal class PreviewVoiceWakeRecognizer : VoiceWakeRecognizer {
  override val isAvailable: Boolean = true

  override fun start(
    operationId: Long,
    onEvent: (VoiceWakeRecognitionEvent) -> Unit,
  ) {
    onEvent(VoiceWakeRecognitionEvent.Ready)
  }

  override fun stop(operationId: Long) = Unit

  override fun destroy(operationId: Long) = Unit
}
