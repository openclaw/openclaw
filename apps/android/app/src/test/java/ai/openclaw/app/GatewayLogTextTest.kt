package ai.openclaw.app

import org.junit.Assert.assertEquals
import org.junit.Test

class GatewayLogTextTest {
  @Test
  fun sanitizeGatewayLogTextRemovesAnsiSgrSequences() {
    assertEquals(
      "hindsight: Skipping retain",
      sanitizeGatewayLogText("\u001B[38;5;103mhindsight:\u001B[0m Skipping retain"),
    )
  }

  @Test
  fun sanitizeGatewayLogTextRemovesVisibleSgrFragments() {
    assertEquals(
      "hindsight: Skipping retain",
      sanitizeGatewayLogText("[38;5;103mhindsight:[0m Skipping retain"),
    )
  }

  @Test
  fun sanitizeGatewayLogTextKeepsPlainBracketedText() {
    assertEquals(
      "cache ttl [5m] expired",
      sanitizeGatewayLogText("cache ttl [5m] expired"),
    )
  }
}
