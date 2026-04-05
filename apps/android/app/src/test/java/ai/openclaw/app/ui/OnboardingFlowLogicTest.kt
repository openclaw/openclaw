package ai.openclaw.app.ui

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class OnboardingFlowLogicTest {
  @Test
  fun blocksFinishWhenNodeIsDisconnected() {
    assertFalse(canFinishOnboarding(isNodeConnected = false))
  }

  @Test
  fun allowsFinishWhenNodeIsConnected() {
    assertTrue(canFinishOnboarding(isNodeConnected = true))
  }
}
