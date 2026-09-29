package ai.openclaw.app

import ai.openclaw.app.calls.IncomingCallController
import ai.openclaw.app.calls.IncomingCallForegroundService
import ai.openclaw.app.calls.IncomingCallStatus
import ai.openclaw.app.calls.IncomingCallTelecomShadow
import ai.openclaw.app.gateway.GatewayRegistryEntry
import ai.openclaw.app.gateway.GatewayRegistryEntryKind
import ai.openclaw.app.gateway.GatewaySession
import ai.openclaw.app.node.InvokeDispatcher
import ai.openclaw.app.voice.TalkModeManager
import android.Manifest
import android.content.Context
import androidx.core.content.edit
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.MutableStateFlow
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
