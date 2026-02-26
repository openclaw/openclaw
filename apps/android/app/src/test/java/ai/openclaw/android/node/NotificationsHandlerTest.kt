package ai.openclaw.android.node

import android.content.Context
import ai.openclaw.android.gateway.GatewaySession
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment

@RunWith(RobolectricTestRunner::class)
class NotificationsHandlerTest {
  @Test
  fun notificationsListReturnsStatusPayloadWhenDisabled() =
    runTest {
      val provider =
        FakeNotificationsStateProvider(
          DeviceNotificationSnapshot(
            enabled = false,
            connected = false,
            notifications = emptyList(),
          ),
        )
      val handler = NotificationsHandler.forTesting(appContext = appContext(), stateProvider = provider)

      val result = handler.handleNotificationsList(null)

      assertTrue(result.ok)
      assertNull(result.error)
      val payload = parsePayload(result)
      assertFalse(payload.getValue("enabled").jsonPrimitive.boolean)
      assertFalse(payload.getValue("connected").jsonPrimitive.boolean)
      assertEquals(0, payload.getValue("count").jsonPrimitive.int)
      assertEquals(0, payload.getValue("notifications").jsonArray.size)
      assertEquals(0, provider.rebindRequests)
    }

  @Test
  fun notificationsListRequestsRebindWhenEnabledButDisconnected() =
    runTest {
      val provider =
        FakeNotificationsStateProvider(
          DeviceNotificationSnapshot(
            enabled = true,
            connected = false,
            notifications = listOf(sampleEntry("n1")),
          ),
        )
      val handler = NotificationsHandler.forTesting(appContext = appContext(), stateProvider = provider)

      val result = handler.handleNotificationsList(null)

      assertTrue(result.ok)
      assertNull(result.error)
      val payload = parsePayload(result)
      assertTrue(payload.getValue("enabled").jsonPrimitive.boolean)
      assertFalse(payload.getValue("connected").jsonPrimitive.boolean)
      assertEquals(1, payload.getValue("count").jsonPrimitive.int)
      assertEquals(1, payload.getValue("notifications").jsonArray.size)
      assertEquals(1, provider.rebindRequests)
    }

  @Test
  fun notificationsListDoesNotRequestRebindWhenConnected() =
    runTest {
      val provider =
        FakeNotificationsStateProvider(
          DeviceNotificationSnapshot(
            enabled = true,
            connected = true,
            notifications = listOf(sampleEntry("n2")),
          ),
        )
      val handler = NotificationsHandler.forTesting(appContext = appContext(), stateProvider = provider)

      val result = handler.handleNotificationsList(null)

      assertTrue(result.ok)
      assertNull(result.error)
      val payload = parsePayload(result)
      assertTrue(payload.getValue("enabled").jsonPrimitive.boolean)
      assertTrue(payload.getValue("connected").jsonPrimitive.boolean)
      assertEquals(1, payload.getValue("count").jsonPrimitive.int)
      assertEquals(0, provider.rebindRequests)
    }

  @Test
  fun sanitizeNotificationTextReturnsNullForBlankInput() {
    assertNull(sanitizeNotificationText(null))
    assertNull(sanitizeNotificationText("    "))
  }

  @Test
  fun sanitizeNotificationTextTrimsAndTruncates() {
    val value = "  ${"x".repeat(600)}  "
    val sanitized = sanitizeNotificationText(value)

    assertEquals(512, sanitized?.length)
    assertTrue((sanitized ?: "").all { it == 'x' })
  }

  private fun parsePayload(result: GatewaySession.InvokeResult): JsonObject {
    val payloadJson = result.payloadJson ?: error("expected payload")
    return Json.parseToJsonElement(payloadJson).jsonObject
  }

  private fun appContext(): Context = RuntimeEnvironment.getApplication()

  private fun sampleEntry(key: String): DeviceNotificationEntry =
    DeviceNotificationEntry(
      key = key,
      packageName = "com.example.app",
      title = "Title",
      text = "Text",
      subText = null,
      category = null,
      channelId = null,
      postTimeMs = 123L,
      isOngoing = false,
      isClearable = true,
    )
}

private class FakeNotificationsStateProvider(
  private val snapshot: DeviceNotificationSnapshot,
) : NotificationsStateProvider {
  var rebindRequests: Int = 0
    private set

  override fun readSnapshot(context: Context): DeviceNotificationSnapshot = snapshot

  override fun requestServiceRebind(context: Context) {
    rebindRequests += 1
  }
}
