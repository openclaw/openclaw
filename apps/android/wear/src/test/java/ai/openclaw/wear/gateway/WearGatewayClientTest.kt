package ai.openclaw.wear.gateway

import ai.openclaw.android.gateway.GatewayClientProfiles
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.assertFalse
import org.junit.Test
import okhttp3.Request
import okhttp3.WebSocket

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
