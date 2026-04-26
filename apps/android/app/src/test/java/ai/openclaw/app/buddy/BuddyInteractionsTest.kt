package ai.openclaw.app.buddy

import org.junit.Assert.assertEquals
import org.junit.Test

class BuddyInteractionsTest {
  @Test
  fun eyeAndNoseStartVisionScan() {
    assertEquals(BuddyAction.StartVisionScan, BuddyAction.fromTouchRegion("eye"))
    assertEquals(BuddyAction.StartVisionScan, BuddyAction.fromTouchRegion("nose"))
  }

  @Test
  fun mouthRepeatsLastResponse() {
    assertEquals(BuddyAction.RepeatLastResponse, BuddyAction.fromTouchRegion("mouth"))
    assertEquals(BuddyAction.RepeatLastResponse, BuddyAction.fromTouchRegion("chin"))
  }

  @Test
  fun earsStartShortListening() {
    assertEquals(BuddyAction.StartShortListening, BuddyAction.fromTouchRegion("ear"))
    assertEquals(BuddyAction.StartShortListening, BuddyAction.fromTouchRegion("ears"))
  }

  @Test
  fun foreheadPlaysAndLongPressOpensSettings() {
    assertEquals(BuddyAction.Play, BuddyAction.fromTouchRegion("forehead"))
    assertEquals(BuddyAction.OpenSettings, BuddyAction.fromTouchRegion("long_press"))
  }
}
