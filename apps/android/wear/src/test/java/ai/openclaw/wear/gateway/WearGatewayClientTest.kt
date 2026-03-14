package ai.openclaw.wear.gateway

import ai.openclaw.android.gateway.GatewayClientProfiles
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class WearGatewayClientTest {
  @Test
  fun `wear connect client info uses schema valid id and mode`() {
    val clientInfo = buildWearGatewayClientInfoJson(
      deviceId = "watch-device-123",
      versionName = "2026.3.14-dev",
    )

    assertEquals(GatewayClientProfiles.AndroidClientId, clientInfo["id"]?.jsonPrimitive?.content)
    assertEquals(GatewayClientProfiles.UiMode, clientInfo["mode"]?.jsonPrimitive?.content)
    assertEquals(GatewayClientProfiles.WearOsPlatform, clientInfo["platform"]?.jsonPrimitive?.content)
    assertEquals(GatewayClientProfiles.WatchDeviceFamily, clientInfo["deviceFamily"]?.jsonPrimitive?.content)
    assertEquals("watch-device-123", clientInfo["instanceId"]?.jsonPrimitive?.content)
    assertEquals("2026.3.14-dev", clientInfo["version"]?.jsonPrimitive?.content)
    assertTrue(clientInfo["displayName"]?.jsonPrimitive?.content?.isNotBlank() == true)
  }
}
