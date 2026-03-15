package ai.openclaw.android.gateway

import org.junit.Assert.assertEquals
import org.junit.Test

class GatewayClientProfilesTest {
  @Test
  fun buildGatewayUrlBracketsIpv6Hosts() {
    assertEquals(
      "wss://[fd7a:115c:a1e0::1234]:18789",
      GatewayClientProfiles.buildGatewayUrl(
        scheme = "wss",
        host = "fd7a:115c:a1e0::1234",
        port = 18789,
      ),
    )
  }

  @Test
  fun buildGatewayUrlKeepsBracketedIpv6HostsStable() {
    assertEquals(
      "https://[fd7a:115c:a1e0::1234]:443",
      GatewayClientProfiles.buildGatewayUrl(
        scheme = "https",
        host = "[fd7a:115c:a1e0::1234]",
        port = 443,
      ),
    )
  }
}
