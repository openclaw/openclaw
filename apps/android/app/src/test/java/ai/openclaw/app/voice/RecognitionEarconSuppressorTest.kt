package ai.openclaw.app.voice

import android.media.AudioManager
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class RecognitionEarconSuppressorTest {
  @Test
  fun suppressTemporarilyMutesConfiguredStreamsAndRestoresThem() {
    val controller = FakeAudioController(
      AudioManager.STREAM_MUSIC to 6,
      AudioManager.STREAM_SYSTEM to 4,
    )
    val suppressor = RecognitionEarconSuppressor(
      controller = controller,
      streams = intArrayOf(AudioManager.STREAM_MUSIC, AudioManager.STREAM_SYSTEM),
    )

    suppressor.suppress()

    assertEquals(0, controller.volume(AudioManager.STREAM_MUSIC))
    assertEquals(0, controller.volume(AudioManager.STREAM_SYSTEM))

    suppressor.restore()

    assertEquals(6, controller.volume(AudioManager.STREAM_MUSIC))
    assertEquals(4, controller.volume(AudioManager.STREAM_SYSTEM))
  }

  @Test
  fun repeatedSuppressKeepsOriginalVolumes() {
    val controller = FakeAudioController(
      AudioManager.STREAM_MUSIC to 6,
    )
    val suppressor = RecognitionEarconSuppressor(
      controller = controller,
      streams = intArrayOf(AudioManager.STREAM_MUSIC),
    )

    suppressor.suppress()
    controller.setStreamVolume(AudioManager.STREAM_MUSIC, 2, 0)
    suppressor.suppress()
    suppressor.restore()

    assertEquals(6, controller.volume(AudioManager.STREAM_MUSIC))
  }

  @Test
  fun restoreIsSafeWhenNothingWasSuppressed() {
    val controller = FakeAudioController(AudioManager.STREAM_MUSIC to 6)
    val suppressor = RecognitionEarconSuppressor(
      controller = controller,
      streams = intArrayOf(AudioManager.STREAM_MUSIC),
    )

    suppressor.restore()

    assertEquals(6, controller.volume(AudioManager.STREAM_MUSIC))
    assertTrue(controller.setCalls.isEmpty())
  }
}

private class FakeAudioController(
  vararg initialVolumes: Pair<Int, Int>,
) : RecognitionEarconSuppressor.AudioController {
  val setCalls = mutableListOf<Pair<Int, Int>>()
  private val volumes = initialVolumes.toMap().toMutableMap()

  override fun getStreamVolume(stream: Int): Int {
    return volumes[stream] ?: 0
  }

  override fun setStreamVolume(stream: Int, volume: Int, flags: Int) {
    setCalls += stream to volume
    volumes[stream] = volume
  }

  fun volume(stream: Int): Int = volumes[stream] ?: 0
}
