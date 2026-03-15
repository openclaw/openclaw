package ai.openclaw.wear.gateway

import org.junit.Assert.assertEquals
import org.junit.Test

class WearGatewayConfigTest {
  @Test
  fun wsUrlBracketsIpv6Hosts() {
    val config = WearGatewayConfig(host = "fd7a:115c:a1e0::1234", port = 18789, useTls = true)

    assertEquals("wss://[fd7a:115c:a1e0::1234]:18789", config.wsUrl())
  }
}
