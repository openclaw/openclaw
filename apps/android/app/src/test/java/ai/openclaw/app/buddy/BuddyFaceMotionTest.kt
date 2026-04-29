package ai.openclaw.app.buddy

import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class BuddyFaceMotionTest {
  @Test
  fun listeningMotionShiftsGazeAndBreathesOverTime() {
    val start = BuddyFaceMotion.forState(BuddyState.Listening, elapsedMillis = 0L)
    val later = BuddyFaceMotion.forState(BuddyState.Listening, elapsedMillis = 850L)

    assertNotEquals(start.pupilShift, later.pupilShift)
    assertNotEquals(start.verticalBob, later.verticalBob)
  }

  @Test
  fun listeningMotionBlinksDuringIdleLoop() {
    val blink = BuddyFaceMotion.forState(BuddyState.Listening, elapsedMillis = 4_050L)

    assertTrue(blink.eyeOpen < 0.25f)
  }

  @Test
  fun disconnectedMotionKeepsEyesSleepy() {
    val motion = BuddyFaceMotion.forState(BuddyState.Disconnected, elapsedMillis = 850L)

    assertTrue(motion.eyeOpen < 0.5f)
  }
}
