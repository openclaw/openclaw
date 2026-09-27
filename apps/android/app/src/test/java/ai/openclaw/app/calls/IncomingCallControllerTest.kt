package ai.openclaw.app.calls

import ai.openclaw.app.SecurePrefs
import ai.openclaw.app.gateway.GatewayRegistryEntry
import ai.openclaw.app.gateway.GatewayRegistryEntryKind
import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import android.telecom.PhoneAccountHandle
import android.telecom.TelecomManager
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.delay
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.annotation.Implementation
import org.robolectric.annotation.Implements
import org.robolectric.shadows.ShadowTelecomManager
import java.util.UUID

@Implements(TelecomManager::class)
class IncomingCallTelecomShadow : ShadowTelecomManager() {
  @Implementation
  @Suppress("UNUSED_PARAMETER")
  protected fun isIncomingCallPermitted(handle: PhoneAccountHandle): Boolean = true
}

@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], shadows = [IncomingCallTelecomShadow::class])
class IncomingCallControllerTest {
  private class Fixture(
    scope: TestScope,
    start: suspend () -> Unit = {},
  ) {
    val app = RuntimeEnvironment.getApplication()
    val prefs = SecurePrefs(app, app.getSharedPreferences("secure-calls-test", Context.MODE_PRIVATE))
    var authority = true
    var gateway: String? = "synthetic-gateway"
    var starts = 0
    var stops = 0
    val id = UUID.randomUUID().toString()
    val expiresAtMs = System.currentTimeMillis() + 60_000
    val payload =
      buildJsonObject {
        put("callId", id)
        put("sessionKey", "agent:assistant:test-call")
        put("callerName", "Assistant")
        put("topic", "Synthetic fixture")
        put("expiresAtMs", expiresAtMs)
      }.toString()
    val controller: IncomingCallController

    init {
      shadowOf(app).grantPermissions(Manifest.permission.RECORD_AUDIO, Manifest.permission.POST_NOTIFICATIONS, Manifest.permission.MANAGE_OWN_CALLS)
      prefs.gatewayRegistry.upsert(GatewayRegistryEntry("synthetic-gateway", GatewayRegistryEntryKind.MANUAL, "Synthetic Gateway"))
      prefs.gatewayRegistry.setActive("synthetic-gateway")
      prefs.setIncomingCallsEnabled(true)
      controller =
        IncomingCallController(
          context = app,
          scope = scope.backgroundScope,
          prefs = prefs,
          gatewayId = { gateway },
          captureAuthority = { { authority } },
          isBusy = { false },
          startAudio = { _, _ ->
            starts++
            start()
          },
          stopAudio = { stops++ },
          setMuted = {},
        )
    }
  }

  private suspend fun response(
    fixture: Fixture,
    command: String = "talk.callStatus",
    params: String? = buildJsonObject { put("callId", fixture.id) }.toString(),
  ): JsonObject {
    val result = fixture.controller.invoke(command, params)
    assertTrue(result.ok)
    return Json.parseToJsonElement(requireNotNull(result.payloadJson)).jsonObject
  }

  private fun expectedCall(
    fixture: Fixture,
    status: String,
    detail: String? = null,
  ): JsonObject =
    buildJsonObject {
      put("callId", fixture.id)
      put("sessionKey", "agent:assistant:test-call")
      put("status", status)
      put("expiresAtMs", fixture.expiresAtMs)
      if (detail != null) put("detail", detail)
    }

  @Test
  fun `ringing repeats system alert until answer and ongoing call never repeats it`() =
    runTest {
      Dispatchers.setMain(UnconfinedTestDispatcher(testScheduler))
      try {
        val f = Fixture(this)
        val notifications = shadowOf(f.app.getSystemService(NotificationManager::class.java))
        assertTrue(f.controller.invoke("talk.incoming", f.payload).ok)
        f.controller.showIncomingUi(f.id)
        val ringing = requireNotNull(notifications.getNotification(IncomingCallController.NOTIFICATION_ID))
        assertTrue(ringing.flags and Notification.FLAG_INSISTENT != 0)
        assertEquals(0, f.starts)

        f.controller.answer(f.id)
        assertNull(notifications.getNotification(IncomingCallController.NOTIFICATION_ID))
        assertEquals(0, f.starts)
        val service = Robolectric.buildService(IncomingCallForegroundService::class.java).create().get()
        assertTrue(f.controller.foregroundServiceReady(f.id, service))
        val active = requireNotNull(shadowOf(service).lastForegroundNotification)
        assertEquals(0, active.flags and Notification.FLAG_INSISTENT)
        f.controller.end(f.id)
        assertNull(notifications.getNotification(IncomingCallController.NOTIFICATION_ID))
      } finally {
        Dispatchers.resetMain()
      }
    }

  @Test
  fun `invoke reports known call states without detail and starts audio only after answer`() =
    runTest {
      Dispatchers.setMain(UnconfinedTestDispatcher(testScheduler))
      try {
        val f = Fixture(this)
        assertEquals(expectedCall(f, "ringing"), response(f, "talk.incoming", f.payload))
        assertEquals(expectedCall(f, "ringing"), response(f, "talk.incoming", f.payload))
        assertEquals(expectedCall(f, "ringing"), response(f))
        assertEquals(expectedCall(f, "ringing"), response(f, params = null))
        assertEquals(0, f.starts)
        f.controller.answer(f.id)
        assertEquals(expectedCall(f, "connecting"), response(f))
        assertEquals(0, f.starts)
        val service = Robolectric.buildService(IncomingCallForegroundService::class.java).create().get()
        assertTrue(f.controller.foregroundServiceReady(f.id, service))
        assertEquals(expectedCall(f, "active"), response(f))
        assertEquals(1, f.starts)
        assertEquals(expectedCall(f, "ended"), response(f, "talk.endCall"))
        assertEquals(expectedCall(f, "ended"), response(f))
        assertEquals(1, f.stops)
      } finally {
        Dispatchers.resetMain()
      }
    }

  @Test
  fun `invoke preserves declined and missed statuses without detail including duplicate invites`() =
    runTest {
      Dispatchers.setMain(UnconfinedTestDispatcher(testScheduler))
      try {
        val declined = Fixture(this)
        assertTrue(declined.controller.invoke("talk.incoming", declined.payload).ok)
        declined.controller.decline(declined.id)
        assertEquals(expectedCall(declined, "declined"), response(declined))
        assertEquals(expectedCall(declined, "declined"), response(declined, "talk.incoming", declined.payload))
        val missed = Fixture(this)
        assertTrue(missed.controller.invoke("talk.incoming", missed.payload).ok)
        advanceTimeBy(60_001)
        runCurrent()
        assertEquals(expectedCall(missed, "missed"), response(missed))
        assertEquals(expectedCall(missed, "missed"), response(missed, "talk.incoming", missed.payload))
        assertEquals(0, declined.starts + missed.starts)
      } finally {
        Dispatchers.resetMain()
      }
    }

  @Test
  fun `invoke preserves error detail and retained completed call after another invitation`() =
    runTest {
      Dispatchers.setMain(UnconfinedTestDispatcher(testScheduler))
      try {
        val f = Fixture(this)
        assertTrue(f.controller.invoke("talk.incoming", f.payload).ok)
        f.controller.connectionFailed(f.id)
        val error = expectedCall(f, "error", "Android rejected the incoming call")
        assertEquals(error, response(f))
        val nextPayload =
          buildJsonObject {
            Json.parseToJsonElement(f.payload).jsonObject.forEach { (key, value) -> put(key, value) }
            put("callId", UUID.randomUUID().toString())
          }.toString()
        assertTrue(f.controller.invoke("talk.incoming", nextPayload).ok)
        assertEquals(error, response(f))
        assertEquals(error, response(f, "talk.incoming", f.payload))
        assertEquals(0, f.starts)
      } finally {
        Dispatchers.resetMain()
      }
    }

  @Test
  fun `invoke idle and unknown results never expose a call from another Gateway`() =
    runTest {
      Dispatchers.setMain(UnconfinedTestDispatcher(testScheduler))
      try {
        val f = Fixture(this)
        val idle = buildJsonObject { put("status", "idle") }
        val unknown =
          buildJsonObject {
            put("callId", f.id)
            put("status", "unknown")
          }
        assertEquals(idle, response(f, params = null))
        assertEquals(unknown, response(f))
        assertTrue(f.controller.invoke("talk.incoming", f.payload).ok)
        val unknownId = UUID.randomUUID().toString()
        assertEquals(
          buildJsonObject {
            put("callId", unknownId)
            put("status", "unknown")
          },
          response(f, params = buildJsonObject { put("callId", unknownId) }.toString()),
        )
        f.gateway = "another-gateway"
        assertEquals(idle, response(f, params = null))
        assertEquals(unknown, response(f))
        assertFalse(f.controller.invoke("talk.incoming", f.payload).ok)
        assertFalse(f.controller.invoke("talk.endCall", buildJsonObject { put("callId", f.id) }.toString()).ok)
        f.gateway = null
        assertEquals(idle, response(f, params = null))
        assertEquals(unknown, response(f))
        assertEquals(0, f.starts)
      } finally {
        Dispatchers.resetMain()
      }
    }

  @Test
  fun `ringing and declined duplicate never start microphone`() =
    runTest {
      Dispatchers.setMain(UnconfinedTestDispatcher(testScheduler))
      try {
        val f = Fixture(this)
        assertTrue(f.controller.invoke("talk.incoming", f.payload).ok)
        assertEquals(0, f.starts)
        assertTrue(f.controller.invoke("talk.incoming", f.payload).ok)
        f.controller.decline(f.id)
        assertEquals(
          IncomingCallStatus.Declined,
          f.controller.state.value
            ?.status,
        )
        assertTrue(f.controller.invoke("talk.incoming", f.payload).ok)
        f.controller.answer(f.id)
        assertEquals(0, f.starts)
      } finally {
        Dispatchers.resetMain()
      }
    }

  @Test
  fun `expired connection lease prevents microphone even on same Gateway`() =
    runTest {
      Dispatchers.setMain(UnconfinedTestDispatcher(testScheduler))
      try {
        val f = Fixture(this)
        assertTrue(f.controller.invoke("talk.incoming", f.payload).ok)
        f.authority = false
        f.controller.answer(f.id)
        assertEquals(0, f.starts)
        f.controller.invalidate()
        assertEquals(
          IncomingCallStatus.Ended,
          f.controller.state.value
            ?.status,
        )
      } finally {
        Dispatchers.resetMain()
      }
    }

  @Test
  fun `audio startup timeout closes connecting call and cleans capture`() =
    runTest {
      Dispatchers.setMain(UnconfinedTestDispatcher(testScheduler))
      try {
        val f = Fixture(this) { withTimeout(10) { delay(1000) } }
        assertTrue(f.controller.invoke("talk.incoming", f.payload).ok)
        f.controller.answer(f.id)
        assertEquals(
          IncomingCallStatus.Connecting,
          f.controller.state.value
            ?.status,
        )
        val service = Robolectric.buildService(IncomingCallForegroundService::class.java).create().get()
        assertEquals(0, f.starts)
        assertTrue(f.controller.foregroundServiceReady(f.id, service))
        advanceTimeBy(11)
        runCurrent()
        assertEquals(
          IncomingCallStatus.Error,
          f.controller.state.value
            ?.status,
        )
        assertEquals(1, f.stops)
        f.controller.answer(f.id)
        assertEquals(1, f.starts)
      } finally {
        Dispatchers.resetMain()
      }
    }

  @Test
  fun `end before foreground service adoption cannot start audio`() =
    runTest {
      Dispatchers.setMain(UnconfinedTestDispatcher(testScheduler))
      try {
        val f = Fixture(this)
        assertTrue(f.controller.invoke("talk.incoming", f.payload).ok)
        f.controller.answer(f.id)
        assertEquals(0, f.starts)
        f.controller.end(f.id)
        val service = Robolectric.buildService(IncomingCallForegroundService::class.java).create().get()
        assertFalse(f.controller.foregroundServiceReady(f.id, service))
        assertEquals(0, f.starts)
        assertEquals(
          IncomingCallStatus.Ended,
          f.controller.state.value
            ?.status,
        )
      } finally {
        Dispatchers.resetMain()
      }
    }

  @Test
  fun `foreground service startup timeout ends accepted call without microphone`() =
    runTest {
      Dispatchers.setMain(UnconfinedTestDispatcher(testScheduler))
      try {
        val f = Fixture(this)
        assertTrue(f.controller.invoke("talk.incoming", f.payload).ok)
        f.controller.answer(f.id)
        advanceTimeBy(5_001)
        runCurrent()
        assertEquals(
          IncomingCallStatus.Error,
          f.controller.state.value
            ?.status,
        )
        assertEquals(0, f.starts)
      } finally {
        Dispatchers.resetMain()
      }
    }

  @Test
  fun `blocked call channel rejects invitation instead of silently ringing`() =
    runTest {
      Dispatchers.setMain(UnconfinedTestDispatcher(testScheduler))
      try {
        val f = Fixture(this)
        f.app.getSystemService(NotificationManager::class.java).createNotificationChannel(
          NotificationChannel(IncomingCallController.CHANNEL_ID, "Calls", NotificationManager.IMPORTANCE_NONE),
        )
        assertFalse(f.controller.invoke("talk.incoming", f.payload).ok)
        assertEquals(null, f.controller.state.value)
        assertEquals(0, f.starts)
      } finally {
        Dispatchers.resetMain()
      }
    }
}
