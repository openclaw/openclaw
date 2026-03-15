package ai.openclaw.wear.gateway

import ai.openclaw.android.gateway.GatewayClientProfiles
import ai.openclaw.android.gateway.GatewayConnectProfiles
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import okhttp3.Request
import okhttp3.WebSocket

class WearGatewayClientTest {
  @Test
  fun `wear connect client info uses schema valid id and mode`() {
    val clientInfo = buildWearGatewayClientInfo(
      deviceId = "watch-device-123",
      versionName = "2026.3.14-dev",
    )

    assertEquals(GatewayClientProfiles.AndroidClientId, clientInfo.id)
    assertEquals(GatewayClientProfiles.UiMode, clientInfo.mode)
    assertEquals(GatewayClientProfiles.WearOsPlatform, clientInfo.platform)
    assertEquals(GatewayClientProfiles.WatchDeviceFamily, clientInfo.deviceFamily)
    assertEquals("watch-device-123", clientInfo.instanceId)
    assertEquals("2026.3.14-dev", clientInfo.version)
    assertTrue(clientInfo.displayName?.isNotBlank() == true)
  }

  @Test
  fun `wear connect params include shared operator scopes`() {
    val connectParams =
      buildWearConnectParams(
        config = WearGatewayConfig(token = "secret-token"),
        deviceId = "watch-device-123",
        versionName = "2026.3.14-dev",
      )

    assertEquals("operator", connectParams["role"]?.jsonPrimitive?.content)
    assertEquals(
      GatewayConnectProfiles.OperatorScopes,
      connectParams["scopes"]?.jsonArray?.map { it.jsonPrimitive.content },
    )
    assertEquals("secret-token", connectParams["auth"]?.jsonObject?.get("token")?.jsonPrimitive?.content)
  }

  @Test
  fun `current socket frame gate rejects stale epoch or socket`() {
    val activeSocket = TestWebSocket()

    assertTrue(
      isCurrentSocketFrame(
        frameEpoch = 5L,
        currentEpoch = 5L,
        activeSocket = activeSocket,
        sourceSocket = activeSocket,
      ),
    )
    assertFalse(
      isCurrentSocketFrame(
        frameEpoch = 4L,
        currentEpoch = 5L,
        activeSocket = activeSocket,
        sourceSocket = activeSocket,
      ),
    )
    assertFalse(
      isCurrentSocketFrame(
        frameEpoch = 5L,
        currentEpoch = 5L,
        activeSocket = activeSocket,
        sourceSocket = TestWebSocket(),
      ),
    )
  }
}

private class TestWebSocket : WebSocket {
  override fun queueSize(): Long = 0L

  override fun request(): Request = Request.Builder().url("ws://localhost").build()

  override fun send(text: String): Boolean = true

  override fun send(bytes: okio.ByteString): Boolean = true

  override fun close(code: Int, reason: String?): Boolean = true

  override fun cancel() = Unit
}
