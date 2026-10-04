package ai.openclaw.app.calls

import android.media.AudioManager
import android.media.ToneGenerator
import android.util.Log
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch

/** Local feedback only; the call controller owns recovery, routing and microphone lifetime. */
internal class IncomingCallReconnectTone(
  private val scope: CoroutineScope,
) {
  private var job: Job? = null
  private var tone: ToneGenerator? = null

  fun start() {
    if (job?.isActive == true) return
    job =
      scope.launch(Dispatchers.Main.immediate, start = CoroutineStart.LAZY) {
        var player: ToneGenerator? = null
        try {
          // Follow Telecom's current call route and volume without taking new audio focus.
          player = ToneGenerator(AudioManager.STREAM_VOICE_CALL, 25)
          tone = player
          while (isActive) {
            // Android's double beep is 35 ms on, 200 ms off, 35 ms on.
            if (!player.startTone(ToneGenerator.TONE_PROP_BEEP2, 300)) break
            delay(3_000)
          }
        } catch (error: CancellationException) {
          throw error
        } catch (error: RuntimeException) {
          // Optional feedback must never prevent the call from recovering or ending.
          Log.w("IncomingCallReconnectTone", "Reconnect cue unavailable", error)
        } finally {
          // A canceled loop must not release a replacement loop's output.
          if (player != null && tone === player) {
            tone = null
            release(player)
          }
        }
      }
    job?.start()
  }

  fun stop() {
    val previous = job
    job = null
    val player = tone
    tone = null
    // Silence and release synchronously before the controller can resume microphone capture.
    if (player != null) release(player)
    previous?.cancel()
  }

  private fun release(player: ToneGenerator) {
    runCatching { player.stopTone() }
    runCatching { player.release() }
  }
}
