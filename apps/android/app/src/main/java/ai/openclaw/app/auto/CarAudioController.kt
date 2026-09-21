package ai.openclaw.app.auto

import android.content.Context
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.os.Build

class CarAudioController(context: Context) {
  private val audioManager = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager
  private var focusRequest: AudioFocusRequest? = null

  fun requestCarFocus(onFocusLost: () -> Unit): Boolean {
    val attributes = AudioAttributes.Builder()
      .setUsage(AudioAttributes.USAGE_ASSISTANCE_NAVIGATION_GUIDANCE)
      .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
      .build()

    return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      val request = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_EXCLUSIVE)
        .setAudioAttributes(attributes)
        .setAcceptsDelayedFocusGain(false)
        .setOnAudioFocusChangeListener { focusChange ->
          if (focusChange == AudioManager.AUDIOFOCUS_LOSS ||
              focusChange == AudioManager.AUDIOFOCUS_LOSS_TRANSIENT) {
            onFocusLost()
          }
        }
        .build()
      focusRequest = request
      audioManager.requestAudioFocus(request) == AudioManager.AUDIOFOCUS_REQUEST_GRANTED
    } else {
      @Suppress("DEPRECATION")
      audioManager.requestAudioFocus(
        { focusChange ->
          if (focusChange == AudioManager.AUDIOFOCUS_LOSS ||
              focusChange == AudioManager.AUDIOFOCUS_LOSS_TRANSIENT) {
            onFocusLost()
          }
        },
        AudioManager.STREAM_VOICE_CALL,
        AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_EXCLUSIVE,
      ) == AudioManager.AUDIOFOCUS_REQUEST_GRANTED
    }
  }

  fun abandonCarFocus() {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      focusRequest?.let { audioManager.abandonAudioFocusRequest(it) }
      focusRequest = null
    } else {
      @Suppress("DEPRECATION")
      audioManager.abandonAudioFocus(null)
    }
  }
}
