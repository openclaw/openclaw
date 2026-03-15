package ai.openclaw.android.gateway

import org.junit.Assert.assertEquals
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonPrimitive
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

  @Test
  fun buildOperatorConnectOptionsUsesSharedOperatorScopes() {
    val options =
      GatewayConnectProfiles.buildOperatorConnectOptions(
        client =
          GatewayClientInfo(
            id = GatewayClientProfiles.AndroidClientId,
            displayName = "Watch",
            version = "2026.3.14-dev",
            platform = GatewayClientProfiles.WearOsPlatform,
            mode = GatewayClientProfiles.UiMode,
            instanceId = "watch-1",
            deviceFamily = GatewayClientProfiles.WatchDeviceFamily,
            modelIdentifier = "Pixel Watch 2",
          ),
      )

    assertEquals(GatewayConnectProfiles.OperatorScopes, options.scopes)
  }

  @Test
  fun buildConnectParamsJsonIncludesOperatorScopes() {
    val options =
      GatewayConnectProfiles.buildOperatorConnectOptions(
        client =
          GatewayClientInfo(
            id = GatewayClientProfiles.AndroidClientId,
            displayName = "Watch",
            version = "2026.3.14-dev",
            platform = GatewayClientProfiles.WearOsPlatform,
            mode = GatewayClientProfiles.UiMode,
            instanceId = "watch-1",
            deviceFamily = GatewayClientProfiles.WatchDeviceFamily,
            modelIdentifier = "Pixel Watch 2",
          ),
      )

    val params = GatewayConnectProfiles.buildConnectParamsJson(options = options, locale = "en-US")

    assertEquals("operator", params["role"]?.jsonPrimitive?.content)
    assertEquals(
      GatewayConnectProfiles.OperatorScopes,
      params["scopes"]?.jsonArray?.map { it.jsonPrimitive.content },
    )
  }
}
