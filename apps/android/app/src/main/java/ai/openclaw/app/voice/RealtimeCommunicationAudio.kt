package ai.openclaw.app.voice

import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.media.AudioPlaybackConfiguration
import android.media.AudioRecordingConfiguration
import android.media.MediaRecorder
import android.os.Handler
import android.os.Looper
import kotlinx.coroutines.CancellationException
import java.util.concurrent.atomic.AtomicReference

/** One capture's request for Android's process-wide communication mode and audio focus. */
internal class RealtimeCommunicationAudio private constructor(
  private val audioManager: AudioManager,
  private val isCurrent: () -> Boolean,
  private val onFocusLost: () -> Unit,
) : AutoCloseable {
  companion object {
    private val ownershipLock = Any()
    private var current: RealtimeCommunicationAudio? = null
    private val telephonyModes = setOf(AudioManager.MODE_RINGTONE, AudioManager.MODE_IN_CALL, AudioManager.MODE_CALL_SCREENING)

    fun open(
      audioManager: AudioManager,
      isCurrent: () -> Boolean = { true },
      onFocusLost: () -> Unit = {},
    ): RealtimeCommunicationAudio =
      synchronized(ownershipLock) {
        // A cancelled opener must not displace the replacement capture while acquiring SDK state.
        if (!isCurrent()) throw CancellationException("audio capture replaced")
        current?.close()
        RealtimeCommunicationAudio(audioManager, isCurrent, onFocusLost).also { session ->
          current = session
          try {
            session.start()
          } catch (error: RuntimeException) {
            session.close()
            throw error
          }
        }
      }

    fun playbackAttributes(): AudioAttributes =
      AudioAttributes
        .Builder()
        .setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION)
        .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
        .build()
  }

  @Volatile private var closed = false

  private enum class Focus { Requesting, Granted, Lost }

  private val focus = AtomicReference(Focus.Requesting)

  @Volatile private var mode = AudioManager.MODE_NORMAL
  private var listenersRegistered = false
  private var modeRequested = false
  private var focusLossReported = false

  /** Set by the input session once its recorder exists, so Talk's own capture is not taken for a call. */
  @Volatile var ownCaptureSessionId = AudioManager.AUDIO_SESSION_ID_GENERATE

  private val handler = Handler(Looper.getMainLooper())
  private val modeListener =
    AudioManager.OnModeChangedListener { value ->
      if (!closed) {
        mode = value
        endIfCalled()
      }
    }
  private val playbackCallback =
    object : AudioManager.AudioPlaybackCallback() {
      override fun onPlaybackConfigChanged(configs: MutableList<AudioPlaybackConfiguration>) {
        if (!closed) endIfCalled()
      }
    }
  private val recordingCallback =
    object : AudioManager.AudioRecordingCallback() {
      override fun onRecordingConfigChanged(configs: MutableList<AudioRecordingConfiguration>) {
        if (!closed) endIfCalled()
      }
    }
  private val focusRequest =
    AudioFocusRequest
      .Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT)
      .setAudioAttributes(playbackAttributes())
      .setWillPauseWhenDucked(true)
      .setOnAudioFocusChangeListener({ change ->
        if (!closed) {
          focus.set(if (change == AudioManager.AUDIOFOCUS_GAIN) Focus.Granted else Focus.Lost)
          // Navigation prompts and notification sounds take transient focus; Talk only stays
          // [interrupted] until focus returns. Calls take transient focus too and end Talk.
          if (change == AudioManager.AUDIOFOCUS_LOSS) reportFocusLost() else endIfCalled()
        }
      }, handler)
      .build()

  // A call can show up before or after it takes focus: as the telephony mode, a ringtone, or
  // another app's voice-communication capture (VoIP), so every one of those changes checks again.
  private fun endIfCalled() {
    if (focus.get() != Focus.Lost) return
    val call =
      mode in telephonyModes ||
        audioManager.activePlaybackConfigurations.any { it.audioAttributes.usage == AudioAttributes.USAGE_NOTIFICATION_RINGTONE } ||
        audioManager.activeRecordingConfigurations.any {
          it.clientAudioSource == MediaRecorder.AudioSource.VOICE_COMMUNICATION && it.clientAudioSessionId != ownCaptureSessionId
        }
    if (call) reportFocusLost()
  }

  // Several call signals can follow one focus loss; the capture owner ends Talk once.
  private fun reportFocusLost() {
    handler.post {
      if (!closed && !focusLossReported && isCurrent()) {
        focusLossReported = true
        onFocusLost()
      }
    }
  }

  // Mode is the effective platform value, not proof that this app owns every hardware route.
  val eligible: Boolean
    get() = !closed && focus.get() == Focus.Granted && mode == AudioManager.MODE_IN_COMMUNICATION

  /** Another app holds transient focus: Talk stays up, stops sending microphone audio and ducks its speech. */
  val interrupted: Boolean
    get() = !closed && focus.get() == Focus.Lost

  private fun start() {
    // Set first: close() unregisters each listener independently if a later registration throws.
    listenersRegistered = true
    audioManager.addOnModeChangedListener({ command -> handler.post(command) }, modeListener)
    audioManager.registerAudioPlaybackCallback(playbackCallback, handler)
    audioManager.registerAudioRecordingCallback(recordingCallback, handler)
    val granted = audioManager.requestAudioFocus(focusRequest) == AudioManager.AUDIOFOCUS_REQUEST_GRANTED
    // A loss callback delivered during acquisition must not be overwritten by its return value.
    focus.compareAndSet(Focus.Requesting, if (granted) Focus.Granted else Focus.Lost)
    check(granted && focus.get() == Focus.Granted) { "audio focus unavailable" }
    modeRequested = true
    audioManager.mode = AudioManager.MODE_IN_COMMUNICATION
    mode = audioManager.mode
  }

  override fun close() {
    synchronized(ownershipLock) {
      if (closed) return
      closed = true
      focus.set(Focus.Lost)
      if (listenersRegistered) {
        runCatching { audioManager.removeOnModeChangedListener(modeListener) }
        runCatching { audioManager.unregisterAudioPlaybackCallback(playbackCallback) }
        runCatching { audioManager.unregisterAudioRecordingCallback(recordingCallback) }
      }
      runCatching { audioManager.abandonAudioFocusRequest(focusRequest) }
      if (current === this) {
        current = null
        // AOSP tracks mode requests per PID. NORMAL withdraws ours; replaying a saved global
        // mode would assert another app's request as our own after Talk has stopped.
        if (modeRequested) runCatching { audioManager.mode = AudioManager.MODE_NORMAL }
      }
    }
  }
}
