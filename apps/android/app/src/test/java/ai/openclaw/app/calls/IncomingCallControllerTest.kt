package ai.openclaw.app.calls

import ai.openclaw.app.SecurePrefs
import ai.openclaw.app.gateway.GatewayRegistryEntry
import ai.openclaw.app.gateway.GatewayRegistryEntryKind
import ai.openclaw.app.gateway.GatewayRequestNotEnqueued
import ai.openclaw.app.gateway.GatewayRequestRejected
import ai.openclaw.app.gateway.GatewaySession.ErrorShape
import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import android.os.ParcelUuid
import android.os.PowerManager
import android.telecom.CallAudioState
import android.telecom.CallEndpoint
import android.telecom.PhoneAccountHandle
import android.telecom.TelecomManager
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.delay
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import kotlinx.coroutines.withContext
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
import org.robolectric.shadows.ShadowPowerManager
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
    proximitySupported: Boolean = true,
    start: suspend () -> Unit = {},
  ) {
    val app = RuntimeEnvironment.getApplication()
    val prefs = SecurePrefs(app, app.getSharedPreferences("secure-calls-test", Context.MODE_PRIVATE))
    var authority = true
    var lifecycleAuthority = true
    var busy = false
    var appliedMute = false
    val resumptions = mutableListOf<Boolean>()
    val targets = mutableListOf<Pair<String, String>>()
    val startMuted = mutableListOf<Boolean>()
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
      shadowOf(app.getSystemService(PowerManager::class.java)).setIsWakeLockLevelSupported(PowerManager.PROXIMITY_SCREEN_OFF_WAKE_LOCK, proximitySupported)
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
          captureRecoveryAuthority = { { lifecycleAuthority } },
          isBusy = { busy },
          startAudio = { callId, sessionKey, resuming ->
            starts++
            resumptions += resuming
            targets += callId to sessionKey
            startMuted += appliedMute
            start()
          },
          stopAudio = { stops++ },
          setMuted = { appliedMute = it },
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

  private fun setEndpoint(
    fixture: Fixture,
    type: Int,
    name: String = "Earpiece",
    id: String = fixture.id,
  ) {
    fixture.controller.currentEndpointChanged(id, CallEndpoint(name, type, ParcelUuid(UUID.randomUUID())))
  }

  private fun proximityHeld(): Boolean = ShadowPowerManager.getLatestWakeLock()?.isHeld == true

  @Test
  fun `proximity begins only after answer and follows native endpoint type not display name`() =
    runTest {
      Dispatchers.setMain(UnconfinedTestDispatcher(testScheduler))
      try {
        val f = Fixture(this)
        assertTrue(f.controller.invoke("talk.incoming", f.payload).ok)
        setEndpoint(f, CallEndpoint.TYPE_EARPIECE, "Auricular")
        assertFalse(proximityHeld())
        assertEquals(0, f.starts)

        f.controller.answer(f.id)
        assertTrue(proximityHeld())
        assertEquals(0, f.starts)
        val service = Robolectric.buildService(IncomingCallForegroundService::class.java).create().get()
        assertTrue(f.controller.foregroundServiceReady(f.id, service))
        assertTrue(proximityHeld())
        assertEquals(1, f.starts)
        setEndpoint(f, CallEndpoint.TYPE_EARPIECE, "Auricular")
        assertEquals(1, shadowOf(requireNotNull(ShadowPowerManager.getLatestWakeLock())).timesHeld)

        for (type in listOf(CallEndpoint.TYPE_SPEAKER, CallEndpoint.TYPE_BLUETOOTH, CallEndpoint.TYPE_WIRED_HEADSET, CallEndpoint.TYPE_STREAMING, CallEndpoint.TYPE_UNKNOWN)) {
          setEndpoint(f, type)
          assertFalse("Non-earpiece endpoint $type must not blank the screen", proximityHeld())
          setEndpoint(f, CallEndpoint.TYPE_EARPIECE, "Auricular")
          assertTrue(proximityHeld())
        }
        f.controller.end(f.id)
        assertFalse(proximityHeld())
        setEndpoint(f, CallEndpoint.TYPE_EARPIECE)
        assertFalse(proximityHeld())
      } finally {
        Dispatchers.resetMain()
      }
    }

  @Test
  @Config(sdk = [33])
  @Suppress("DEPRECATION")
  fun `legacy native earpiece route blanks only answered call and releases for speaker bluetooth and headset`() =
    runTest {
      Dispatchers.setMain(UnconfinedTestDispatcher(testScheduler))
      try {
        val f = Fixture(this)
        val routes = CallAudioState.ROUTE_EARPIECE or CallAudioState.ROUTE_SPEAKER or CallAudioState.ROUTE_BLUETOOTH or CallAudioState.ROUTE_WIRED_HEADSET
        assertTrue(f.controller.invoke("talk.incoming", f.payload).ok)
        f.controller.legacyAudioStateChanged(f.id, CallAudioState(false, CallAudioState.ROUTE_EARPIECE, routes))
        assertFalse(proximityHeld())
        f.controller.answer(f.id)
        assertTrue(proximityHeld())
        assertEquals(0, f.starts)
        for (route in listOf(CallAudioState.ROUTE_SPEAKER, CallAudioState.ROUTE_BLUETOOTH, CallAudioState.ROUTE_WIRED_HEADSET)) {
          f.controller.legacyAudioStateChanged(f.id, CallAudioState(false, route, routes))
          assertFalse(proximityHeld())
          f.controller.legacyAudioStateChanged(f.id, CallAudioState(false, CallAudioState.ROUTE_EARPIECE, routes))
          assertTrue(proximityHeld())
        }
        f.controller.end(f.id)
        assertFalse(proximityHeld())
      } finally {
        Dispatchers.resetMain()
      }
    }

  @Test
  fun `service destruction and Gateway loss release proximity without Activity involvement`() =
    runTest {
      Dispatchers.setMain(UnconfinedTestDispatcher(testScheduler))
      try {
        for (gatewayLost in listOf(false, true)) {
          val f = Fixture(this)
          assertTrue(f.controller.invoke("talk.incoming", f.payload).ok)
          f.controller.answer(f.id)
          assertFalse(proximityHeld())
          val service = Robolectric.buildService(IncomingCallForegroundService::class.java).create().get()
          assertTrue(f.controller.foregroundServiceReady(f.id, service))
          setEndpoint(f, CallEndpoint.TYPE_EARPIECE)
          assertTrue(proximityHeld())
          if (gatewayLost) {
            f.gateway = null
            f.authority = false
            f.controller.invalidate()
          } else {
            f.controller.foregroundServiceDestroyed(service)
          }
          assertFalse(proximityHeld())
          assertEquals(
            IncomingCallStatus.Ended,
            f.controller.state.value
              ?.status,
          )
          assertEquals(1, f.stops)
          setEndpoint(f, CallEndpoint.TYPE_EARPIECE)
          assertFalse(proximityHeld())
        }
      } finally {
        Dispatchers.resetMain()
      }
    }

  @Test
  fun `a completed call cannot supply an earpiece route for a later answered call`() =
    runTest {
      Dispatchers.setMain(UnconfinedTestDispatcher(testScheduler))
      try {
        val f = Fixture(this)
        assertTrue(f.controller.invoke("talk.incoming", f.payload).ok)
        setEndpoint(f, CallEndpoint.TYPE_EARPIECE)
        f.controller.answer(f.id)
        assertTrue(proximityHeld())
        f.controller.end(f.id)
        assertFalse(proximityHeld())
        val nextId = UUID.randomUUID().toString()
        val nextPayload =
          buildJsonObject {
            Json.parseToJsonElement(f.payload).jsonObject.forEach { (key, value) -> put(key, value) }
            put("callId", nextId)
          }.toString()
        assertTrue(f.controller.invoke("talk.incoming", nextPayload).ok)
        setEndpoint(f, CallEndpoint.TYPE_EARPIECE)
        f.controller.answer(nextId)
        assertFalse(proximityHeld())
        setEndpoint(f, CallEndpoint.TYPE_EARPIECE, id = nextId)
        assertTrue(proximityHeld())
        f.controller.end(nextId)
        assertFalse(proximityHeld())
      } finally {
        Dispatchers.resetMain()
      }
    }

  @Test
  fun `device without proximity support still accepts and completes an earpiece call`() =
    runTest {
      Dispatchers.setMain(UnconfinedTestDispatcher(testScheduler))
      try {
        val f = Fixture(this, proximitySupported = false)
        assertTrue(f.controller.invoke("talk.incoming", f.payload).ok)
        setEndpoint(f, CallEndpoint.TYPE_EARPIECE)
        f.controller.answer(f.id)
        val service = Robolectric.buildService(IncomingCallForegroundService::class.java).create().get()
        assertTrue(f.controller.foregroundServiceReady(f.id, service))
        assertEquals(
          IncomingCallStatus.Active,
          f.controller.state.value
            ?.status,
        )
        assertEquals(1, f.starts)
        assertFalse(proximityHeld())
        f.controller.end(f.id)
        assertEquals(1, f.stops)
      } finally {
        Dispatchers.resetMain()
      }
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
        setEndpoint(f, CallEndpoint.TYPE_EARPIECE)
        f.controller.answer(f.id)
        assertTrue(proximityHeld())
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
        assertFalse(proximityHeld())
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
        setEndpoint(f, CallEndpoint.TYPE_EARPIECE)
        f.controller.answer(f.id)
        assertTrue(proximityHeld())
        advanceTimeBy(5_001)
        runCurrent()
        assertEquals(
          IncomingCallStatus.Error,
          f.controller.state.value
            ?.status,
        )
        assertEquals(0, f.starts)
        assertFalse(proximityHeld())
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

  private fun status(f: Fixture) =
    f.controller.state.value
      ?.status

  private suspend fun answered(f: Fixture): IncomingCallForegroundService {
    assertTrue(f.controller.invoke("talk.incoming", f.payload).ok)
    f.controller.answer(f.id)
    val service = Robolectric.buildService(IncomingCallForegroundService::class.java).create().get()
    assertTrue(f.controller.foregroundServiceReady(f.id, service))
    return service
  }

  @Test
  fun `socket loss preserves answered call service mute route and invited session then resumes with fresh authority`() =
    runTest {
      Dispatchers.setMain(UnconfinedTestDispatcher(testScheduler))
      try {
        val f = Fixture(this)
        val service = answered(f)
        f.controller.toggleMute(f.id)
        setEndpoint(f, CallEndpoint.TYPE_SPEAKER, "Speaker")
        f.gateway = null
        f.authority = false
        f.controller.transportInterrupted()
        assertEquals(IncomingCallStatus.Connecting, status(f))
        assertTrue(f.controller.ownsForegroundService(service))
        assertEquals(1, f.stops)
        f.controller.toggleMute(f.id)
        assertFalse(f.controller.muted.value)
        f.controller.toggleMute(f.id)
        advanceTimeBy(1_000)
        runCurrent()
        assertEquals(1, f.starts)
        f.gateway = "synthetic-gateway"
        f.controller.transportConnected()
        advanceTimeBy(2_000)
        runCurrent()
        assertEquals("Stale transport authority cannot restart capture", 1, f.starts)
        f.authority = true
        f.controller.transportConnected()
        advanceTimeBy(4_000)
        runCurrent()
        assertEquals(IncomingCallStatus.Active, status(f))
        assertEquals(listOf(false, true), f.resumptions)
        assertEquals(listOf(f.id to "agent:assistant:test-call", f.id to "agent:assistant:test-call"), f.targets)
        assertEquals(listOf(false, true), f.startMuted)
        assertEquals("Speaker", f.controller.audioOutput.value)
        advanceTimeBy(30_000)
        runCurrent()
        assertEquals(IncomingCallStatus.Active, status(f))
        f.controller.end(f.id)
      } finally {
        Dispatchers.resetMain()
      }
    }

  @Test
  fun `flapping and failed resumes never renew the original thirty second deadline`() =
    runTest {
      Dispatchers.setMain(UnconfinedTestDispatcher(testScheduler))
      try {
        var fail = false
        val f = Fixture(this) { if (fail) throw GatewayRequestNotEnqueued("temporary network error") }
        val service = answered(f)
        fail = true
        f.controller.transportInterrupted()
        advanceTimeBy(1_000)
        runCurrent()
        assertEquals(2, f.starts)
        advanceTimeBy(2_000)
        runCurrent()
        assertEquals(3, f.starts)
        advanceTimeBy(4_000)
        runCurrent()
        assertEquals(4, f.starts)
        advanceTimeBy(22_999)
        runCurrent()
        f.controller.transportInterrupted()
        assertEquals(IncomingCallStatus.Connecting, status(f))
        advanceTimeBy(1)
        runCurrent()
        assertEquals(IncomingCallStatus.Error, status(f))
        assertFalse(f.controller.ownsForegroundService(service))
        val starts = f.starts
        fail = false
        f.controller.transportConnected()
        advanceTimeBy(10_000)
        runCurrent()
        assertEquals(starts, f.starts)
      } finally {
        Dispatchers.resetMain()
      }
    }

  @Test
  fun `ringing cannot recover or start microphone without answer`() =
    runTest {
      Dispatchers.setMain(UnconfinedTestDispatcher(testScheduler))
      try {
        val f = Fixture(this)
        assertTrue(f.controller.invoke("talk.incoming", f.payload).ok)
        f.gateway = null
        f.controller.transportInterrupted()
        f.gateway = "synthetic-gateway"
        f.controller.transportConnected()
        f.controller.answer(f.id)
        advanceTimeBy(35_000)
        runCurrent()
        assertEquals(IncomingCallStatus.Ended, status(f))
        assertEquals(0, f.starts)
      } finally {
        Dispatchers.resetMain()
      }
    }

  @Test
  fun `revocation invalidation and local end during outage prevent resurrection`() =
    runTest {
      Dispatchers.setMain(UnconfinedTestDispatcher(testScheduler))
      try {
        for (reason in listOf("consent", "lifecycle", "invalidate", "end", "microphone")) {
          val f = Fixture(this)
          answered(f)
          f.gateway = null
          f.controller.transportInterrupted()
          when (reason) {
            "consent" -> f.prefs.setIncomingCallsEnabled(false)
            "lifecycle" -> f.lifecycleAuthority = false
            "invalidate" -> f.controller.invalidate()
            "end" -> f.controller.end(f.id)
            "microphone" -> shadowOf(f.app).denyPermissions(Manifest.permission.RECORD_AUDIO)
          }
          f.gateway = "synthetic-gateway"
          f.controller.transportConnected()
          advanceTimeBy(1_000)
          runCurrent()
          assertTrue("$reason must end recovery", status(f)?.isTerminal == true)
          assertEquals(1, f.starts)
        }
      } finally {
        Dispatchers.resetMain()
      }
    }

  @Test
  fun `busy capture blocks resume without stealing the microphone`() =
    runTest {
      Dispatchers.setMain(UnconfinedTestDispatcher(testScheduler))
      try {
        val f = Fixture(this)
        answered(f)
        f.controller.transportInterrupted()
        f.busy = true
        advanceTimeBy(1_000)
        runCurrent()
        assertEquals(1, f.starts)
        assertEquals(1, f.stops)
        f.busy = false
        advanceTimeBy(2_000)
        runCurrent()
        assertEquals(2, f.starts)
        assertEquals(IncomingCallStatus.Active, status(f))
        f.controller.end(f.id)
      } finally {
        Dispatchers.resetMain()
      }
    }

  @Test
  fun `loss between answer and foreground service adoption remains recoverable`() =
    runTest {
      Dispatchers.setMain(UnconfinedTestDispatcher(testScheduler))
      try {
        val f = Fixture(this)
        assertTrue(f.controller.invoke("talk.incoming", f.payload).ok)
        f.controller.answer(f.id)
        f.gateway = null
        f.controller.transportInterrupted()
        val service = Robolectric.buildService(IncomingCallForegroundService::class.java).create().get()
        assertTrue(f.controller.foregroundServiceReady(f.id, service))
        assertEquals(0, f.starts)
        f.gateway = "synthetic-gateway"
        f.controller.transportConnected()
        advanceTimeBy(1_000)
        runCurrent()
        assertEquals(listOf(true), f.resumptions)
        assertEquals(IncomingCallStatus.Active, status(f))
        f.controller.end(f.id)
      } finally {
        Dispatchers.resetMain()
      }
    }

  @Test
  fun `stale cancelled startup completion cannot stop or activate a newer recovery attempt`() =
    runTest {
      Dispatchers.setMain(UnconfinedTestDispatcher(testScheduler))
      try {
        val release = CompletableDeferred<Unit>()
        var attempt = 0
        val f =
          Fixture(this) {
            if (++attempt == 1) withContext(NonCancellable) { release.await() }
          }
        answered(f)
        assertEquals(IncomingCallStatus.Connecting, status(f))
        f.controller.transportInterrupted()
        advanceTimeBy(1_000)
        runCurrent()
        assertEquals(IncomingCallStatus.Active, status(f))
        val stops = f.stops
        release.complete(Unit)
        runCurrent()
        assertEquals(stops, f.stops)
        assertEquals(IncomingCallStatus.Active, status(f))
        f.controller.end(f.id)
      } finally {
        Dispatchers.resetMain()
      }
    }

  @Test
  fun `recovery deadline still closes suspended noncancellable startup without resurrection`() =
    runTest {
      Dispatchers.setMain(UnconfinedTestDispatcher(testScheduler))
      try {
        val release = CompletableDeferred<Unit>()
        var attempt = 0
        val f =
          Fixture(this) {
            if (++attempt > 1) withContext(NonCancellable) { release.await() }
          }
        answered(f)
        f.controller.transportInterrupted()
        advanceTimeBy(30_000)
        runCurrent()
        assertEquals(IncomingCallStatus.Error, status(f))
        val stops = f.stops
        release.complete(Unit)
        runCurrent()
        assertEquals(stops, f.stops)
        assertEquals(IncomingCallStatus.Error, status(f))
      } finally {
        Dispatchers.resetMain()
      }
    }

  @Test
  fun `synchronous transport failure during startup cannot overwrite the recovery job`() =
    runTest {
      Dispatchers.setMain(UnconfinedTestDispatcher(testScheduler))
      try {
        lateinit var f: Fixture
        var attempt = 0
        f =
          Fixture(this) {
            if (++attempt == 1) f.controller.transportInterrupted()
          }
        answered(f)
        f.controller.transportConnected()
        advanceTimeBy(1_000)
        runCurrent()
        assertEquals(2, f.starts)
        assertEquals(1, f.stops)
        assertEquals(IncomingCallStatus.Active, status(f))
        f.controller.end(f.id)
      } finally {
        Dispatchers.resetMain()
      }
    }

  @Test
  fun `initial relay transport failure recovers before asynchronous failure notification arrives`() =
    runTest {
      Dispatchers.setMain(UnconfinedTestDispatcher(testScheduler))
      try {
        var attempt = 0
        val f =
          Fixture(this) {
            if (++attempt == 1) throw GatewayRequestNotEnqueued("socket interrupted")
          }
        val service = answered(f)
        assertEquals(IncomingCallStatus.Connecting, status(f))
        assertTrue(f.controller.ownsForegroundService(service))
        assertEquals(1, f.stops)
        advanceTimeBy(1_000)
        runCurrent()
        assertEquals(IncomingCallStatus.Active, status(f))
        assertEquals(listOf(false, true), f.resumptions)
        f.controller.end(f.id)
      } finally {
        Dispatchers.resetMain()
      }
    }

  @Test
  fun `initial and resumed terminal startup errors preserve bounded reasons and never retry`() =
    runTest {
      Dispatchers.setMain(UnconfinedTestDispatcher(testScheduler))
      try {
        val errors =
          listOf(
            GatewayRequestRejected(ErrorShape("INVALID_REQUEST", "invalid talk.session.create params: unexpected property 'greeting'")),
            GatewayRequestRejected(ErrorShape("UNAVAILABLE", "Realtime provider credential is missing")),
            SecurityException("Microphone permission required"),
            IllegalStateException("Realtime provider rejected the session: " + "details ".repeat(60)),
          )
        for (resuming in listOf(false, true)) {
          for (error in errors) {
            var fail = !resuming
            val f = Fixture(this) { if (fail) throw error }
            val service = answered(f)
            if (resuming) {
              fail = true
              f.controller.transportInterrupted()
              advanceTimeBy(1_000)
              runCurrent()
            }
            assertEquals(expectedCall(f, "error", error.message?.trim()?.take(240)), response(f))
            assertFalse(f.controller.ownsForegroundService(service))
            val starts = f.starts
            f.controller.transportConnected()
            advanceTimeBy(30_001)
            runCurrent()
            assertEquals(starts, f.starts)
            assertEquals(IncomingCallStatus.Error, status(f))
          }
        }
      } finally {
        Dispatchers.resetMain()
      }
    }

  @Test
  fun `late startup error cannot replace a recovered call or deliberate hangup`() =
    runTest {
      Dispatchers.setMain(UnconfinedTestDispatcher(testScheduler))
      try {
        for (hangup in listOf(false, true)) {
          val release = CompletableDeferred<Unit>()
          var attempt = 0
          val f =
            Fixture(this) {
              if (++attempt == 1) {
                withContext(NonCancellable) { release.await() }
                error("Retired startup failure")
              }
            }
          answered(f)
          if (hangup) {
            f.controller.end(f.id)
          } else {
            f.controller.transportInterrupted()
            advanceTimeBy(1_000)
            runCurrent()
          }
          val expected = f.controller.state.value
          val stops = f.stops
          release.complete(Unit)
          runCurrent()
          assertEquals(expected, f.controller.state.value)
          assertEquals(stops, f.stops)
          f.controller.end(f.id)
        }
      } finally {
        Dispatchers.resetMain()
      }
    }
}
