package ai.openclaw.app.ui

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class GatewayPairingRetryLogicTest {
  @Test
  fun allowsSingleRetryWhenPairingStarts() {
    assertTrue(shouldTriggerPairingRetry(previousPairingRequired = false, pairingRequired = true))
  }

  @Test
  fun blocksRepeatedRetryWhilePairingStateIsUnchanged() {
    assertFalse(shouldTriggerPairingRetry(previousPairingRequired = true, pairingRequired = true))
  }

  @Test
  fun blocksRetryWhenPairingIsNotRequired() {
    assertFalse(shouldTriggerPairingRetry(previousPairingRequired = false, pairingRequired = false))
  }

  @Test
  fun preservesPendingRetryWhenPairingStartsWhileStopped() {
    val shouldRetryWhileStopped = shouldTriggerPairingRetry(previousPairingRequired = false, pairingRequired = true)
    assertTrue(shouldRetryWhileStopped)
    val shouldRetryAfterResume = shouldTriggerPairingRetry(previousPairingRequired = false, pairingRequired = true)
    assertTrue(shouldRetryAfterResume)
  }
}
