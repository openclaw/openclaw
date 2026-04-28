package ai.openclaw.app.node

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class NodePresenceAliveBeaconTest {
  @Test
  fun normalizeTrigger_acceptsKnownWireValues() {
    assertEquals(NodePresenceAliveBeacon.Trigger.Connect, NodePresenceAliveBeacon.normalizeTrigger(" CONNECT "))
    assertEquals(
      NodePresenceAliveBeacon.Trigger.BackgroundAppRefresh,
      NodePresenceAliveBeacon.normalizeTrigger("bg_app_refresh"),
    )
    assertEquals(
      NodePresenceAliveBeacon.Trigger.SignificantLocation,
      NodePresenceAliveBeacon.normalizeTrigger("significant_location"),
    )
  }

  @Test
  fun normalizeTrigger_mapsUnknownValuesToBackground() {
    assertEquals(NodePresenceAliveBeacon.Trigger.Background, NodePresenceAliveBeacon.normalizeTrigger("watch_prompt_action"))
    assertEquals(NodePresenceAliveBeacon.Trigger.Background, NodePresenceAliveBeacon.normalizeTrigger(""))
  }

  @Test
  fun shouldSkipRecentSuccess_requiresConnectedGatewayAndFreshSuccess() {
    assertTrue(
      NodePresenceAliveBeacon.shouldSkipRecentSuccess(
        isGatewayConnected = true,
        nowMs = 2_000,
        lastSuccessAtMs = 1_500,
        minIntervalMs = 1_000,
      ),
    )
    assertFalse(
      NodePresenceAliveBeacon.shouldSkipRecentSuccess(
        isGatewayConnected = false,
        nowMs = 2_000,
        lastSuccessAtMs = 1_500,
        minIntervalMs = 1_000,
      ),
    )
    assertFalse(
      NodePresenceAliveBeacon.shouldSkipRecentSuccess(
        isGatewayConnected = true,
        nowMs = 3_000,
        lastSuccessAtMs = 1_500,
        minIntervalMs = 1_000,
      ),
    )
  }

  @Test
  fun makePayloadJson_includesAndroidPresenceMetadata() {
    val payload =
      Json.parseToJsonElement(
        NodePresenceAliveBeacon.makePayloadJson(
          trigger = NodePresenceAliveBeacon.Trigger.Connect,
          sentAtMs = 123,
          displayName = "Pixel Node",
          version = "2026.4.28",
          platform = "Android 15 (SDK 35)",
          deviceFamily = "Android",
          modelIdentifier = "Google Pixel 9",
        ),
      ).jsonObject

    assertEquals("connect", payload["trigger"]?.jsonPrimitive?.content)
    assertEquals("123", payload["sentAtMs"]?.jsonPrimitive?.content)
    assertEquals("Pixel Node", payload["displayName"]?.jsonPrimitive?.content)
    assertEquals("2026.4.28", payload["version"]?.jsonPrimitive?.content)
    assertEquals("Android 15 (SDK 35)", payload["platform"]?.jsonPrimitive?.content)
    assertEquals("Android", payload["deviceFamily"]?.jsonPrimitive?.content)
    assertEquals("Google Pixel 9", payload["modelIdentifier"]?.jsonPrimitive?.content)
    assertNull(payload["pushTransport"])
  }

  @Test
  fun decodeResponse_leavesOldGatewayAckUnhandled() {
    val response = NodePresenceAliveBeacon.decodeResponse("""{"ok":true}""")

    assertEquals(true, response?.ok)
    assertNull(response?.handled)
  }

  @Test
  fun decodeResponse_readsHandledPresenceResult() {
    val response =
      NodePresenceAliveBeacon.decodeResponse(
        """{"ok":true,"event":"node.presence.alive","handled":true,"reason":"persisted"}""",
      )

    assertEquals(true, response?.ok)
    assertEquals("node.presence.alive", response?.event)
    assertEquals(true, response?.handled)
    assertEquals("persisted", response?.reason)
  }
}
