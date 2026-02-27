package ai.openclaw.android.gateway

import org.junit.Assert.assertEquals
import org.junit.Test

class GatewaySessionInvokeTimeoutTest {
  @Test
  fun resolveInvokeResultAckTimeoutMs_usesFloorWhenMissingOrTooSmall() {
    assertEquals(15_000L, resolveInvokeResultAckTimeoutMs(null))
    assertEquals(15_000L, resolveInvokeResultAckTimeoutMs(0L))
    assertEquals(15_000L, resolveInvokeResultAckTimeoutMs(5_000L))
  }

  @Test
  fun resolveInvokeResultAckTimeoutMs_usesInvokeBudgetWithinBounds() {
    assertEquals(30_000L, resolveInvokeResultAckTimeoutMs(30_000L))
    assertEquals(90_000L, resolveInvokeResultAckTimeoutMs(90_000L))
  }

  @Test
  fun resolveInvokeResultAckTimeoutMs_capsAtUpperBound() {
    assertEquals(120_000L, resolveInvokeResultAckTimeoutMs(121_000L))
    assertEquals(120_000L, resolveInvokeResultAckTimeoutMs(Long.MAX_VALUE))
  }
}
