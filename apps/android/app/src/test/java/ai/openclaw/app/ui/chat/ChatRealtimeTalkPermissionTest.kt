package ai.openclaw.app.ui.chat

import ai.openclaw.app.GatewayTalkProvider
import ai.openclaw.app.GatewayTalkSetupIssue
import ai.openclaw.app.GatewayTalkSetupReadiness
import ai.openclaw.app.GatewayTalkSetupState
import ai.openclaw.app.GatewayTalkSetupTarget
import ai.openclaw.app.MainViewModel
import ai.openclaw.app.NodeApp
import ai.openclaw.app.NodeRuntime
import ai.openclaw.app.SecurePrefs
import ai.openclaw.app.chat.ChatController
import ai.openclaw.app.closeNodeRuntimeTestFixture
import ai.openclaw.app.gatewayTalkSetupDescription
import ai.openclaw.app.node.InvokeDispatcher
import ai.openclaw.app.ui.UnifiedChatShellScreen
import ai.openclaw.app.ui.design.ClawDesignTheme
import android.Manifest
import android.content.ComponentName
import android.content.Context
import android.content.IntentFilter
import android.os.Looper
import android.provider.Settings
import android.speech.RecognitionService
import androidx.activity.compose.LocalActivityResultRegistryOwner
import androidx.activity.result.ActivityResultRegistry
import androidx.activity.result.ActivityResultRegistryOwner
import androidx.activity.result.contract.ActivityResultContract
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.material3.Button
import androidx.compose.material3.Text
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.unit.dp
import androidx.core.app.ActivityOptionsCompat
import androidx.lifecycle.SavedStateHandle
import androidx.lifecycle.ViewModelStore
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.launch
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.shadows.ShadowToast
import org.robolectric.util.ReflectionHelpers
import java.util.UUID

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class ChatRealtimeTalkPermissionTest {
  @get:Rule val compose = createComposeRule()

  @Test
  fun permissionResultCannotStartTalkAfterChatChangesAndReturns() =
    withLauncher { runtime, result ->
      compose.onNodeWithText("Talk").performClick()
      compose.runOnIdle {
        runtime.switchChatSession("agent:main:other")
        runtime.switchChatSession("agent:main:selected")
        result(true)
        assertFalse("A permission result cannot acquire a later selection", runtime.talkModeEnabled.value)
      }
    }

  @Test
  fun permissionResultForCurrentChatStartsTalk() =
    withLauncher { runtime, result ->
      compose.onNodeWithText("Talk").performClick()
      compose.runOnIdle {
        result(true)
        assertTrue("The existing Talk gesture must consume the captured start", runtime.talkModeEnabled.value)
        runtime.setTalkModeEnabled(false)
      }
    }

  @Test
  fun readyProviderWithUnavailableOwnerShowsActionableFailure() = assertReadyOwnerUnavailable(unverified = false)

  @Test
  fun readyProviderWithUnverifiedOwnerShowsActionableFailure() = assertReadyOwnerUnavailable(unverified = true)

  private fun assertReadyOwnerUnavailable(unverified: Boolean) =
    withLauncher { runtime, _ ->
      compose.runOnIdle {
        shadowOf(RuntimeEnvironment.getApplication()).grantPermissions(Manifest.permission.RECORD_AUDIO)
        if (unverified) {
          ReflectionHelpers.getField<ChatController>(runtime, "chat").prepareAndSelectMainSessionKey("main")
        } else {
          runtime.setForeground(false)
        }
        ReflectionHelpers.getField<MutableStateFlow<GatewayTalkSetupReadiness>>(runtime, "_talkSetupReadiness").value =
          GatewayTalkSetupReadiness(
            GatewayTalkSetupState.Ready(GatewayTalkProvider("fixture", "Fixture")),
            GatewayTalkSetupState.Ready(GatewayTalkProvider("fixture", "Fixture")),
          )
        ShadowToast.reset()
      }
      compose.onNodeWithText("Talk").performClick()
      compose.runOnIdle {
        assertEquals("Talk is unavailable for this conversation. Reopen the chat and try again.", ShadowToast.getTextOfLatestToast())
        assertFalse(runtime.talkModeEnabled.value)
      }
    }

  @Test
  fun missingProviderKeepsItsSetupGuidance() =
    withLauncher { runtime, _ ->
      val state = GatewayTalkSetupState.NeedsSetup(GatewayTalkSetupIssue.ConfigureProvider(GatewayTalkSetupTarget.REALTIME_TALK))
      compose.runOnIdle {
        shadowOf(RuntimeEnvironment.getApplication()).grantPermissions(Manifest.permission.RECORD_AUDIO)
        runtime.setForeground(false)
        ReflectionHelpers.getField<MutableStateFlow<GatewayTalkSetupReadiness>>(runtime, "_talkSetupReadiness").value = GatewayTalkSetupReadiness(state, state)
        ShadowToast.reset()
      }
      compose.onNodeWithText("Talk").performClick()
      compose.runOnIdle { assertEquals(gatewayTalkSetupDescription(state), ShadowToast.getTextOfLatestToast()) }
    }

  @Test
  fun globalEndTalkStillStopsAfterPushToTalkPreparation() =
    withLauncher(fullShell = true) { runtime, _ ->
      val app = RuntimeEnvironment.getApplication()
      val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
      try {
        compose.runOnIdle {
          shadowOf(app).grantPermissions(Manifest.permission.RECORD_AUDIO)
          val service = ComponentName(app, "TestSpeechRecognitionService")
          shadowOf(app.packageManager).apply {
            addServiceIfNotPresent(service)
            addIntentFilterForService(service, IntentFilter(RecognitionService.SERVICE_INTERFACE))
          }
          runtime.setTalkModeEnabled(true)
        }
        try {
          compose.waitUntil(5_000) {
            shadowOf(Looper.getMainLooper()).idle()
            runtime.talkModeListening.value
          }
        } catch (failure: Exception) {
          throw AssertionError("Native Talk did not start: ${runtime.talkModeStatusText.value}; enabled=${runtime.talkModeEnabled.value}", failure)
        }
        compose.waitForIdle()
        val epoch = ReflectionHelpers.getField<java.util.concurrent.atomic.AtomicLong>(runtime, "voiceCaptureOwnershipEpoch")
        val before = epoch.get()
        var prepared = false
        compose.runOnIdle {
          scope.launch {
            val dispatcher = ReflectionHelpers.getField<InvokeDispatcher>(runtime, "invokeDispatcher")
            val result = dispatcher.handleInvoke("talk.ptt.start", null)
            check(result.ok) { result.toString() }
            prepared = true
          }
        }
        compose.waitUntil(5_000) {
          shadowOf(Looper.getMainLooper()).idle()
          prepared
        }
        compose.runOnIdle {
          assertTrue(epoch.get() > before)
          assertTrue(runtime.talkModeEnabled.value)
        }
        compose.onNodeWithContentDescription("End Talk").performClick()
        compose.runOnIdle { assertFalse("The current global End Talk must stop after PTT preparation", runtime.talkModeEnabled.value) }
      } finally {
        scope.cancel()
      }
    }

  private fun withLauncher(
    fullShell: Boolean = false,
    block: (NodeRuntime, (Boolean) -> Unit) -> Unit,
  ) {
    val app = RuntimeEnvironment.getApplication() as NodeApp
    val previous = app.peekRuntime()
    val gateway = FullMessageGateway(if (fullShell) """{"config":{"talk":{"realtime":{"model":"gpt-live"}}}}""" else null)
    val originalScale = Settings.Global.getString(app.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE)
    Settings.Global.putFloat(app.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 0f)
    val prefs = SecurePrefs(app, app.getSharedPreferences("talk-permission-${UUID.randomUUID()}", Context.MODE_PRIVATE))
    prefs.setManualTls(false)
    prefs.saveGatewayCredentials(gateway.endpoint.stableId, token = "synthetic-talk-permission")
    val runtime = NodeRuntime(app, prefs)
    val field = NodeApp::class.java.getDeclaredField("runtimeInstance").apply { isAccessible = true }
    field.set(app, runtime)
    val model = MainViewModel(app, prefs, SavedStateHandle())
    val models = ViewModelStore().also { it.put("talk", model) }
    var pendingRequestCode: Int? = null
    val registry =
      object : ActivityResultRegistry() {
        override fun <I, O> onLaunch(
          requestCode: Int,
          contract: ActivityResultContract<I, O>,
          input: I,
          options: ActivityOptionsCompat?,
        ) {
          pendingRequestCode = requestCode
        }
      }
    val registryOwner =
      object : ActivityResultRegistryOwner {
        override val activityResultRegistry = registry
      }
    try {
      shadowOf(app).denyPermissions(Manifest.permission.RECORD_AUDIO)
      model.setForeground(true)
      compose.setContent {
        CompositionLocalProvider(LocalActivityResultRegistryOwner provides registryOwner) {
          if (fullShell) {
            ClawDesignTheme {
              Box(Modifier.size(360.dp, 800.dp)) {
                UnifiedChatShellScreen(model, false, {}, {}, {}, {})
              }
            }
          } else {
            val launch = rememberChatRealtimeTalkLauncher(model)
            Button(onClick = launch) { Text("Talk") }
          }
        }
      }
      compose.runOnIdle { model.connect(gateway.endpoint) }
      compose.waitUntil(10_000) { runtime.gatewayConnectionDisplay.value.isConnected }
      compose.runOnIdle {
        runtime.setForeground(true)
        runtime.switchChatSession("agent:main:selected")
      }
      compose.waitForIdle()
      block(runtime) { granted ->
        if (granted) shadowOf(app).grantPermissions(Manifest.permission.RECORD_AUDIO)
        registry.dispatchResult(checkNotNull(pendingRequestCode), granted)
      }
    } finally {
      compose.runOnIdle { runtime.setTalkModeEnabled(false) }
      models.clear()
      closeNodeRuntimeTestFixture(runtime)
      field.set(app, previous)
      gateway.close()
      Settings.Global.putString(app.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, originalScale)
    }
  }
}
