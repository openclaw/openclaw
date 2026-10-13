package ai.openclaw.app.voice

import org.junit.Assert.assertEquals
import org.junit.Test

class AudioLevelsTest {
  @Test
  fun midScaleFollowsTheSharedDecibelCurve() {
    // Half amplitude is -6.02 dBFS on the shared 50 dB window.
    assertEquals(0.8796f, TalkAudioLevel.normalized(rms = 0.5), 1e-3f)
  }

  @Test
  fun quietSignalsStayVisibleOnTheDecibelCurve() {
    // -40 dBFS (1% amplitude) still reads at 0.2 instead of vanishing, which is
    // what makes the wave feel alive at conversational distance on iOS/macOS.
    assertEquals(0.2f, TalkAudioLevel.normalized(rms = 0.01), 1e-3f)
    assertEquals(0f, TalkAudioLevel.normalized(rms = 0.0), 0f)
    assertEquals(1f, TalkAudioLevel.normalized(rms = 1.0), 0f)
  }

  @Test
  fun smoothingMatchesIosWeighting() {
    assertEquals(0.2f, TalkAudioLevel.smoothed(previous = 0f, raw = 1f), 1e-6f)
    assertEquals(0.36f, TalkAudioLevel.smoothed(previous = 0.2f, raw = 1f), 1e-6f)
    assertEquals(0.8f, TalkAudioLevel.smoothed(previous = 1f, raw = 0f), 1e-6f)
  }
}
