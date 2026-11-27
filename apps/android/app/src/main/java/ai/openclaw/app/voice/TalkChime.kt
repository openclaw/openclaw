package ai.openclaw.app.voice

import ai.openclaw.app.R
import android.content.Context
import android.media.MediaPlayer
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull

internal enum class TalkChime(
  val key: String,
  val sound: Int,
) {
  Listening("talk.chimes.start", R.raw.chime_wake),
  CallEnd("talk.chimes.end", R.raw.chime_bye),
  ReadyForReply("talk.chimes.reply", R.raw.chime_follow),
}

/** Uses the call's audio usage; never changes device routing, volume or audio focus. */
internal class TalkChimePlayer(
  private val context: Context,
) {
  suspend fun play(
    cue: TalkChime,
    communication: Boolean,
  ) {
    withContext(Dispatchers.Main) {
      val attributes = if (communication) RealtimeCommunicationAudio.playbackAttributes() else speechPlaybackAttributes()
      val player = MediaPlayer.create(context, cue.sound, attributes, 0) ?: return@withContext
      try {
        val finished = CompletableDeferred<Unit>()
        player.setOnCompletionListener { finished.complete(Unit) }
        player.setOnErrorListener { _, _, _ ->
          finished.complete(Unit)
          true
        }
        player.start()
        // Even a broken decoder must give the microphone back.
        withTimeoutOrNull(2_000) { finished.await() }
      } finally {
        player.release()
      }
      if (cue != TalkChime.CallEnd) delay(200) // Include the acoustic tail before reopening input.
    }
  }
}
