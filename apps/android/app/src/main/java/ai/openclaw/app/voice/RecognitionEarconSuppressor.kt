package ai.openclaw.app.voice

import android.content.Context
import android.media.AudioManager
import android.util.Log

internal class RecognitionEarconSuppressor(
  private val controller: AudioController,
  private val streams: IntArray = defaultStreams,
) {
  interface AudioController {
    fun getStreamVolume(stream: Int): Int
    fun setStreamVolume(stream: Int, volume: Int, flags: Int)
  }

  private val savedVolumes = linkedMapOf<Int, Int>()

  fun suppress() {
    synchronized(savedVolumes) {
      if (savedVolumes.isNotEmpty()) return
      streams.forEach { stream ->
        runCatching {
          val volume = controller.getStreamVolume(stream)
          savedVolumes[stream] = volume
          if (volume > 0) {
            controller.setStreamVolume(stream, 0, 0)
          }
        }.onFailure { err ->
          Log.d(tag, "unable to suppress recognition stream=$stream: ${err.message}")
          savedVolumes.remove(stream)
        }
      }
      if (savedVolumes.isNotEmpty()) {
        Log.d(tag, "recognition audio cues suppressed streams=${savedVolumes.keys}")
      }
    }
  }

  fun restore() {
    val restoreVolumes =
      synchronized(savedVolumes) {
        if (savedVolumes.isEmpty()) return
        savedVolumes.toList().also { savedVolumes.clear() }
      }
    restoreVolumes.forEach { (stream, volume) ->
      runCatching {
        controller.setStreamVolume(stream, volume, 0)
      }.onFailure { err ->
        Log.d(tag, "unable to restore recognition stream=$stream: ${err.message}")
      }
    }
    Log.d(tag, "recognition audio cues restored streams=${restoreVolumes.map { it.first }}")
  }

  companion object {
    private const val tag = "RecognitionEarcon"

    private val defaultStreams = intArrayOf(
      AudioManager.STREAM_MUSIC,
      AudioManager.STREAM_SYSTEM,
      AudioManager.STREAM_NOTIFICATION,
    )

    fun fromContext(context: Context): RecognitionEarconSuppressor {
      val audioManager = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager
      return RecognitionEarconSuppressor(AndroidAudioController(audioManager))
    }
  }

  private class AndroidAudioController(
    private val audioManager: AudioManager,
  ) : AudioController {
    override fun getStreamVolume(stream: Int): Int {
      return audioManager.getStreamVolume(stream)
    }

    override fun setStreamVolume(stream: Int, volume: Int, flags: Int) {
      audioManager.setStreamVolume(stream, volume, flags)
    }
  }
}
