package ai.openclaw.app

import ai.openclaw.app.calls.IncomingCallController
import ai.openclaw.app.calls.IncomingCallForegroundService
import ai.openclaw.app.calls.IncomingCallStatus
import ai.openclaw.app.calls.IncomingCallTelecomShadow
import ai.openclaw.app.gateway.GatewayRegistryEntry
import ai.openclaw.app.gateway.GatewayRegistryEntryKind
import ai.openclaw.app.gateway.GatewaySession
import ai.openclaw.app.i18n.verbatimText
import ai.openclaw.app.node.InvokeDispatcher
import ai.openclaw.app.voice.TalkModeManager
import android.Manifest
import android.content.Context
import androidx.core.content.edit
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.util.ReflectionHelpers
import java.util.UUID

@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], shadows = [IncomingCallTelecomShadow::class])
class IncomingCallOptInRuntimeTest {
  private val app = RuntimeEnvironment.getApplication()
  private val incomingCommands = setOf("talk.incoming", "talk.callStatus", "talk.endCall")
  private var runtimeUnderTest: NodeRuntime? = null

  @After
  fun closeRuntime() {
    runtimeUnderTest?.let(::closeNodeRuntimeTestFixture)
  }

  @Test
  fun freshInstallLeavesIncomingCallsAndOrdinaryTalkOff() {
    val prefs = createPrefs()
    val runtime = createRuntime(prefs)

    assertFalse(prefs.incomingCallsEnabled.value)
    assertFalse(prefs.voiceMicEnabled.value)
    assertFalse(runtime.talkModeEnabled.value)
    assertEquals(VoiceCaptureMode.Off, runtime.voiceCaptureMode.value)
    assertTrue(dispatcher(runtime).buildInvokeCommands().none { it in incomingCommands })
  }

  @Test
  fun upgradingExistingPreferencesWithoutAnIncomingOptInStaysOffAfterRecreation() {
    val plain = app.getSharedPreferences("openclaw.node", Context.MODE_PRIVATE)
    plain.edit(commit = true) {
      putString("node.displayName", "Existing node")
      putBoolean("voice.micEnabled", false)
    }
    assertFalse(plain.contains("voice.incomingCallsEnabled"))

    repeat(2) {
      val prefs = createPrefs()
      assertFalse(prefs.incomingCallsEnabled.value)
      assertFalse(prefs.voiceMicEnabled.value)
      assertFalse(plain.contains("voice.incomingCallsEnabled"))
    }
  }

  @Test
  fun switchingGatewaysDoesNotTransferIncomingCallConsent() =
    runTest {
      val prefs = createPrefs()
      selectGateway(prefs, "gateway-a")
      val runtime = createRuntime(prefs)
      val commands = dispatcher(runtime)
      runtime.setIncomingCallsEnabled(true)
      assertTrue(commands.buildInvokeCommands().containsAll(incomingCommands))

      selectGateway(prefs, "gateway-b")
      assertFalse(prefs.incomingCallsEnabled.value)
      assertFalse(createPrefs().incomingCallsEnabled.value)
      assertTrue(commands.buildInvokeCommands().none { it in incomingCommands })
      incomingCommands.forEach { command ->
        assertEquals("CALL_DISABLED", commands.handleInvoke(command, null).error?.code)
      }

      // An Android permission result may arrive after the user has switched Gateways.
      runtime.setIncomingCallsEnabled(true, "gateway-a")
      assertFalse(prefs.incomingCallsEnabled.value)

      selectGateway(prefs, "gateway-a")
      assertTrue(prefs.incomingCallsEnabled.value)
      assertTrue(createPrefs().incomingCallsEnabled.value)
      assertTrue(commands.buildInvokeCommands().containsAll(incomingCommands))
    }

  @Test
  fun unscopedPreviewConsentDoesNotAuthorizeTheSelectedGateway() {
    app.getSharedPreferences("openclaw.node", Context.MODE_PRIVATE).edit(commit = true) {
      putBoolean("voice.incomingCallsEnabled", true)
    }
    val prefs = createPrefs()
    selectGateway(prefs, "gateway-a")
    assertFalse(prefs.incomingCallsEnabled.value)
    assertTrue(dispatcher(createRuntime(prefs)).buildInvokeCommands().none { it in incomingCommands })
  }

  @Test
  fun explicitIncomingOptInPersistsIndependentlyOfOrdinaryTalk() =
    runTest {
      val prefs = createPrefs()
      selectGateway(prefs, "synthetic-gateway")
      val runtime = createRuntime(prefs)
      val commands = dispatcher(runtime)
      runtime.setIncomingCallsEnabled(true)

      assertTrue(prefs.incomingCallsEnabled.value)
      assertFalse(prefs.voiceMicEnabled.value)
      assertFalse(runtime.talkModeEnabled.value)
      assertEquals(VoiceCaptureMode.Off, runtime.voiceCaptureMode.value)
      assertTrue(commands.buildInvokeCommands().containsAll(incomingCommands))

      // Seed ordinary Talk's active owner without opening a microphone, then exercise a real stop.
      val talk = ReflectionHelpers.getField<Lazy<TalkModeManager>>(runtime, "talkMode\$delegate").value
      ReflectionHelpers.getField<MutableStateFlow<VoiceCaptureMode>>(runtime, "_voiceCaptureMode").value = VoiceCaptureMode.TalkMode
      ReflectionHelpers.getField<MutableStateFlow<Boolean>>(runtime, "externalAudioCaptureActive").value = true
      ReflectionHelpers.getField<MutableStateFlow<Boolean>>(talk, "_isEnabled").value = true
      assertTrue(runtime.talkModeEnabled.value)
      runtime.setTalkModeEnabled(false)

      assertTrue(prefs.incomingCallsEnabled.value)
      assertTrue(commands.buildInvokeCommands().containsAll(incomingCommands))
      assertTrue(commands.handleInvoke("talk.callStatus", null).ok)
      val restored = createPrefs()
      assertTrue(restored.incomingCallsEnabled.value)
      assertFalse(restored.voiceMicEnabled.value)
      assertFalse(runtime.talkModeEnabled.value)
    }

  @Test
  fun disablingIncomingCallsEndsItsActiveCallAndWithdrawsItsCommandFamily() =
    runTest {
      Dispatchers.setMain(UnconfinedTestDispatcher(testScheduler))
      try {
        shadowOf(app).grantPermissions(Manifest.permission.RECORD_AUDIO, Manifest.permission.POST_NOTIFICATIONS, Manifest.permission.MANAGE_OWN_CALLS)
        val prefs = createPrefs()
        selectGateway(prefs, "synthetic-gateway")
        val runtime = createRuntime(prefs)
        var starts = 0
        var stops = 0
        var connected = true
        // Keep Android admission/controller transitions real; replace only Gateway/audio transport.
        val calls =
          IncomingCallController(
            context = app,
            scope = backgroundScope,
            prefs = prefs,
            gatewayId = { "synthetic-gateway".takeIf { connected } },
            captureAuthority = { if (connected) ({ connected }) else null },
            captureRecoveryAuthority = { { true } },
            isBusy = { false },
            startAudio = { _, _, _ -> starts++ },
            stopAudio = { stops++ },
            setMuted = {},
          )
        ReflectionHelpers.setField(runtime, "incomingCalls\$delegate", lazyOf(calls))
        val commands = dispatcher(runtime)
        runtime.setIncomingCallsEnabled(true)
        val id = UUID.randomUUID().toString()
        val invitation =
          buildJsonObject {
            put("callId", id)
            put("sessionKey", "agent:assistant:synthetic-opt-in-test")
            put("callerName", "Assistant")
            put("topic", "Synthetic opt-in lifecycle test")
            put("expiresAtMs", System.currentTimeMillis() + 60_000)
          }.toString()
        assertTrue(commands.handleInvoke("talk.incoming", invitation).ok)
        assertEquals(0, starts)
        calls.answer(id)
        val service = Robolectric.buildService(IncomingCallForegroundService::class.java).create().get()
        assertTrue(calls.foregroundServiceReady(id, service))
        assertEquals(IncomingCallStatus.Active, calls.state.value?.status)
        assertEquals(1, starts)

        // Exercise the registered role-socket disconnect callbacks, not a controller-only shortcut.
        for (role in listOf("operatorSession", "nodeSession")) {
          connected = false
          val session = ReflectionHelpers.getField<GatewaySession>(runtime, role)
          ReflectionHelpers.getField<(String) -> Unit>(session, "onDisconnected")("network interrupted")
          assertEquals(IncomingCallStatus.Connecting, calls.state.value?.status)
          assertTrue(calls.ownsForegroundService(service))
          connected = true
          calls.transportConnected()
          advanceTimeBy(1_001)
          runCurrent()
          assertEquals(IncomingCallStatus.Active, calls.state.value?.status)
        }
        assertEquals(3, starts)
        connected = false
        calls.transportInterrupted()
        runtime.setIncomingCallsEnabled(false)

        assertEquals(IncomingCallStatus.Ended, calls.state.value?.status)
        connected = true
        calls.transportConnected()
        advanceTimeBy(30_001)
        runCurrent()
        assertEquals(IncomingCallStatus.Ended, calls.state.value?.status)
        assertFalse(prefs.incomingCallsEnabled.value)
        assertFalse(createPrefs().incomingCallsEnabled.value)
        assertTrue(commands.buildInvokeCommands().none { it in incomingCommands })
        incomingCommands.forEach { command ->
          val result = commands.handleInvoke(command, invitation)
          assertFalse(result.ok)
          assertEquals("CALL_DISABLED", result.error?.code)
        }
        assertEquals(3, starts)
      } finally {
        Dispatchers.resetMain()
      }
    }

  @Test
  fun terminalRelayCallbackPreservesTheActualFailureBeforeCaptureCleanupClearsIt() =
    runTest {
      Dispatchers.setMain(UnconfinedTestDispatcher(testScheduler))
      try {
        val f = createRelayFixture(this)
        for (
        detail in
        listOf(
          "Start failed: INVALID_REQUEST: invalid talk.session.create params: unexpected property 'greeting'",
          "Microphone permission required",
          "Talk failed: Realtime provider closed unexpectedly. " + "details ".repeat(60),
        )
        ) {
          val id = answerRelayCall(f)
          val stopped = relayStopNotification(f.talk)
          f.talk.stopAllCapture(failure = verbatimText(detail))
          // Force the registered runtime callback to queue, then clear the producer's status.
          Dispatchers.setMain(StandardTestDispatcher(testScheduler))
          stopped { true }
          f.talk.stopAllCapture()
          runCurrent()
          assertEquals(
            IncomingCallStatus.Error,
            f.calls.state.value
              ?.status,
          )
          assertEquals(
            detail.trim().take(240),
            f.calls.state.value
              ?.detail,
          )
          assertEquals(null, f.talk.failureNotice.value)
          assertEquals(null, ReflectionHelpers.getField<String?>(f.runtime, "incomingCallCaptureId"))
          Dispatchers.setMain(UnconfinedTestDispatcher(testScheduler))
          val status = f.commands.handleInvoke("talk.callStatus", buildJsonObject { put("callId", id) }.toString())
          assertTrue(status.ok)
          assertTrue(status.payloadJson.orEmpty().contains("\"status\":\"error\""))
        }
      } finally {
        Dispatchers.resetMain()
      }
    }

  @Test
  fun terminalRelayCallbackDistinguishesCleanCompletionAndRejectsLateCallOwners() =
    runTest {
      Dispatchers.setMain(UnconfinedTestDispatcher(testScheduler))
      try {
        val f = createRelayFixture(this)
        answerRelayCall(f)
        val completed = relayStopNotification(f.talk)
        completed { true }
        assertEquals(
          IncomingCallStatus.Ended,
          f.calls.state.value
            ?.status,
        )
        assertEquals(
          null,
          f.calls.state.value
            ?.detail,
        )

        val nextId = answerRelayCall(f)
        f.talk.stopAllCapture(failure = verbatimText("Late provider failure"))
        completed { true }
        assertEquals(
          IncomingCallStatus.Active,
          f.calls.state.value
            ?.status,
        )
        assertEquals(
          nextId,
          f.calls.state.value
            ?.invite
            ?.callId,
        )
        val stopped = relayStopNotification(f.talk)
        stopped { false }
        assertEquals(
          IncomingCallStatus.Active,
          f.calls.state.value
            ?.status,
        )

        f.calls.end(nextId)
        f.talk.stopAllCapture(failure = verbatimText("Late failure after hangup"))
        stopped { true }
        assertEquals(
          IncomingCallStatus.Ended,
          f.calls.state.value
            ?.status,
        )
        assertEquals(
          null,
          f.calls.state.value
            ?.detail,
        )
      } finally {
        Dispatchers.resetMain()
      }
    }

  private data class RelayFixture(
    val runtime: NodeRuntime,
    val talk: TalkModeManager,
    val calls: IncomingCallController,
    val commands: InvokeDispatcher,
  )

  private fun createRelayFixture(scope: TestScope): RelayFixture {
    shadowOf(app).grantPermissions(Manifest.permission.RECORD_AUDIO, Manifest.permission.POST_NOTIFICATIONS, Manifest.permission.MANAGE_OWN_CALLS)
    val prefs = createPrefs()
    selectGateway(prefs, "synthetic-gateway")
    val runtime = createRuntime(prefs)
    val talk = ReflectionHelpers.getField<Lazy<TalkModeManager>>(runtime, "talkMode\$delegate").value
    val calls =
      IncomingCallController(
        context = app,
        scope = scope.backgroundScope,
        prefs = prefs,
        gatewayId = { "synthetic-gateway" },
        captureAuthority = { { true } },
        isBusy = { false },
        startAudio = { id, _, _ -> ReflectionHelpers.setField(runtime, "incomingCallCaptureId", id) },
        stopAudio = {
          ReflectionHelpers.setField(runtime, "incomingCallCaptureId", null)
          talk.stopAllCapture()
        },
        setMuted = {},
      )
    ReflectionHelpers.setField(runtime, "incomingCalls\$delegate", lazyOf(calls))
    runtime.setIncomingCallsEnabled(true)
    return RelayFixture(runtime, talk, calls, dispatcher(runtime))
  }

  private suspend fun answerRelayCall(fixture: RelayFixture): String {
    val id = UUID.randomUUID().toString()
    val invitation =
      buildJsonObject {
        put("callId", id)
        put("sessionKey", "agent:assistant:synthetic-relay-test")
        put("callerName", "Assistant")
        put("topic", "Synthetic relay lifecycle test")
        put("expiresAtMs", System.currentTimeMillis() + 60_000)
      }.toString()
    assertTrue(fixture.commands.handleInvoke("talk.incoming", invitation).ok)
    fixture.calls.answer(id)
    val service = Robolectric.buildService(IncomingCallForegroundService::class.java).create().get()
    assertTrue(fixture.calls.foregroundServiceReady(id, service))
    assertEquals(
      IncomingCallStatus.Active,
      fixture.calls.state.value
        ?.status,
    )
    return id
  }

  private fun relayStopNotification(talk: TalkModeManager): (() -> Boolean) -> Unit = ReflectionHelpers.getField<() -> ((() -> Boolean) -> Unit)>(talk, "captureRelayStopNotification").invoke()

  private fun createPrefs(): SecurePrefs = SecurePrefs(app, app.getSharedPreferences("incoming-opt-in-secure", Context.MODE_PRIVATE))

  private fun selectGateway(
    prefs: SecurePrefs,
    id: String,
  ) {
    prefs.gatewayRegistry.upsert(GatewayRegistryEntry(id, GatewayRegistryEntryKind.MANUAL, id))
    prefs.gatewayRegistry.setActive(id)
  }

  private fun createRuntime(prefs: SecurePrefs): NodeRuntime = NodeRuntime(app, prefs).also { runtimeUnderTest = it }

  private fun dispatcher(runtime: NodeRuntime): InvokeDispatcher = ReflectionHelpers.getField(runtime, "invokeDispatcher")
}
