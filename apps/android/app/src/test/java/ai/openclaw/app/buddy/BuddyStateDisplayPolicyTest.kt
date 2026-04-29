package ai.openclaw.app.buddy

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class BuddyStateDisplayPolicyTest {
  @Test
  fun activeAgentStatesHaveMinimumVisibleDurations() {
    assertEquals(1_200L, BuddyStateDisplayPolicy.minVisibleMs(BuddyState.Thinking))
    assertEquals(1_600L, BuddyStateDisplayPolicy.minVisibleMs(BuddyState.Executing))
  }

  @Test
  fun onlyHoldsBeforeReturningToPassiveState() {
    assertTrue(BuddyStateDisplayPolicy.shouldHoldBeforeLeaving(BuddyState.Executing, BuddyState.Listening))
    assertTrue(BuddyStateDisplayPolicy.shouldHoldBeforeLeaving(BuddyState.Thinking, BuddyState.Idle))

    assertFalse(BuddyStateDisplayPolicy.shouldHoldBeforeLeaving(BuddyState.Executing, BuddyState.Disconnected))
    assertFalse(BuddyStateDisplayPolicy.shouldHoldBeforeLeaving(BuddyState.Listening, BuddyState.Idle))
  }
}
