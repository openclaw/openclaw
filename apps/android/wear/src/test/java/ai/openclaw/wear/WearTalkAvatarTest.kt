package ai.openclaw.wear

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class WearTalkAvatarTest {
  @Test
  fun silenceKeepsTheAvatarMouthClosed() {
    val pcm = ByteArray(samplesForFrames(2) * 2)

    assertEquals(listOf(0f, 0f), pcm16LeMouthLevels(pcm))
  }

  @Test
  fun outputPcmProducesOneBoundedMouthLevelPerPlaybackFrame() {
    val pcm = pcm16Le(samplesForFrames(2), sample = 24_000)

    val levels = pcm16LeMouthLevels(pcm)

    assertEquals(2, levels.size)
    assertTrue(levels.all { level -> level in 0f..1f })
    assertTrue(levels.all { level -> level > 0.9f })
  }

  @Test
  fun finalPartialPlaybackFrameStillMovesTheMouth() {
    val pcm = pcm16Le(samplesForFrames(1) + 12, sample = 12_000)

    val levels = pcm16LeMouthLevels(pcm)

    assertEquals(2, levels.size)
    assertTrue(levels.last() > 0f)
  }

  @Test
  fun mouthEnvelopeUsesFastAttackAndSoftReleaseWithoutOvershoot() {
    val attack = smoothAvatarMouth(current = 0f, target = 1f, deltaSeconds = 0.02f)
    val release = smoothAvatarMouth(current = 1f, target = 0f, deltaSeconds = 0.02f)

    assertTrue(attack in 0f..1f)
    assertTrue(release in 0f..1f)
    assertTrue(attack > 0f)
    assertTrue(release > attack)
  }

  @Test
  fun mouthEnvelopeConvergesAcrossDisplayFrames() {
    var level = 0f
    repeat(30) { level = smoothAvatarMouth(level, target = 1f, deltaSeconds = 1f / 60f) }

    assertTrue(level > 0.99f)

    repeat(60) { level = smoothAvatarMouth(level, target = 0f, deltaSeconds = 1f / 60f) }

    assertTrue(level < 0.001f)
  }

  private fun samplesForFrames(frameCount: Int): Int = WEAR_REALTIME_SAMPLE_RATE_HZ * MOUTH_FRAME_MILLIS / 1_000 * frameCount

  private fun pcm16Le(
    sampleCount: Int,
    sample: Int,
  ): ByteArray =
    ByteArray(sampleCount * 2).also { bytes ->
      repeat(sampleCount) { index ->
        bytes[index * 2] = (sample and 0xff).toByte()
        bytes[(index * 2) + 1] = ((sample shr 8) and 0xff).toByte()
      }
    }

  private companion object {
    const val WEAR_REALTIME_SAMPLE_RATE_HZ = 24_000
  }
}
