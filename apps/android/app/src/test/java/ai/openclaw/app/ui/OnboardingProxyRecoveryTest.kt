package ai.openclaw.app.ui

import ai.openclaw.app.GatewayConnectionDisplay
import ai.openclaw.app.GatewayConnectionProblem
import ai.openclaw.app.MainViewModel
import ai.openclaw.app.NodeApp
import ai.openclaw.app.NodeRuntime
import ai.openclaw.app.SecurePrefs
import ai.openclaw.app.bindNodeRuntimeTestFixture
import ai.openclaw.app.closeNodeRuntimeTestFixture
import ai.openclaw.app.drainWithMainLooper
import ai.openclaw.app.gateway.DeviceAuthStore
import ai.openclaw.app.gateway.DeviceIdentityStore
import ai.openclaw.app.gateway.GatewayEndpoint
import ai.openclaw.app.gateway.GatewayTlsProbeFailure
import ai.openclaw.app.gateway.GatewayTlsProbeResult
import ai.openclaw.app.ui.design.ClawDesignTheme
import android.content.Context
import android.provider.Settings
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.hasSetTextAction
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.StateRestorationTester
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performTextReplacement
import androidx.lifecycle.SavedStateHandle
import androidx.lifecycle.ViewModelStore
import androidx.lifecycle.viewModelScope
import androidx.test.core.app.ApplicationProvider
import com.google.mlkit.common.sdkinternal.MlKitContext
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.job
import kotlinx.coroutines.withTimeout
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.util.ReflectionHelpers
import java.util.UUID

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "en-rUS-w360dp-h720dp-420dpi")
class OnboardingProxyRecoveryTest {
  @get:Rule val composeRule = createComposeRule()

  @Test
  fun restoredRecoveryReopensProxyLoginWithoutReplacingGatewayAuth() {
    val app = ApplicationProvider.getApplicationContext<NodeApp>()
    MlKitContext.initializeIfNeeded(app)
    Settings.Global.putFloat(app.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 0f)
    val prefs = SecurePrefs(app, app.getSharedPreferences("onboarding-proxy-${UUID.randomUUID()}", Context.MODE_PRIVATE))
    prefs.setOnboardingCompleted(false)
    val endpoint = GatewayEndpoint.manual("127.0.0.1", 443, tlsEnabled = true, contextPath = "/tenant%20one")
    // Exercise real config admission/persistence, but leave network/TLS proof to its owner tests.
    val runtime =
      NodeRuntime(app, prefs, tlsFingerprintProbe = { _, _ ->
        GatewayTlsProbeResult(failure = GatewayTlsProbeFailure.ENDPOINT_UNREACHABLE)
      })
    val previousRuntime = app.peekRuntime()
    val models = ViewModelStore()
    val mounted = mutableStateOf(true)
    val restoration = StateRestorationTester(composeRule)
    bindNodeRuntimeTestFixture(app, runtime)
    val model = MainViewModel(app, prefs, SavedStateHandle())
    models.put("onboarding", model)
    val modelJob = model.viewModelScope.coroutineContext.job
    try {
      restoration.setContent {
        ClawDesignTheme {
          if (mounted.value) RootScreen(model)
        }
      }
      composeRule.onNodeWithText("Continue").performClick()
      composeRule.onNodeWithText("Set up manually").performClick()
      composeRule
        .onNode(hasSetTextAction() and hasText("Host"))
        .performScrollTo()
        .performTextReplacement("https://127.0.0.1:443/tenant%20one")
      composeRule.onNodeWithText("Test connection").performClick()
      composeRule.onNodeWithText("Connect").performClick()
      drainWithMainLooper { withTimeout(10_000) { model.gatewayConnectionDisplay.first { it.problem?.code == "NETWORK_UNREACHABLE" } } }

      val identity = DeviceIdentityStore.withPrefs(app, prefs).loadOrCreate()
      val deviceAuth = DeviceAuthStore(prefs)
      // Pairing may have completed before the proxy begins requiring a replacement login.
      prefs.saveGatewayCredentials(endpoint.stableId, token = "saved-gateway-token", password = "saved-gateway-password")
      assertTrue(deviceAuth.saveToken(endpoint.stableId, identity.deviceId, "operator", "paired-operator"))
      assertTrue(deviceAuth.saveToken(endpoint.stableId, identity.deviceId, "node", "paired-node"))
      val savedAuth = prefs.loadGatewayCredentials(endpoint.stableId)
      val problem =
        GatewayConnectionProblem(
          code = "PROXY_AUTH_REQUIRED",
          message = "This destination requires a proxy username and password.",
          reason = null,
          requestId = null,
          recommendedNextStep = null,
          pauseReconnect = true,
          retryable = false,
        )
      composeRule.runOnIdle {
        ReflectionHelpers.getField<MutableStateFlow<GatewayConnectionDisplay>>(runtime, "_gatewayConnectionDisplay").value =
          GatewayConnectionDisplay(false, "Failed: proxy login required", problem)
      }
      drainWithMainLooper { withTimeout(10_000) { model.gatewayConnectionDisplay.first { it.problem == problem } } }
      composeRule.onNodeWithText("Configure proxy login").assertIsDisplayed()

      restoration.emulateSavedInstanceStateRestore()
      composeRule.onNodeWithText("Configure proxy login").performClick()
      composeRule.onNodeWithText("Connect to this Gateway?").assertIsDisplayed()
      composeRule.onNodeWithText("https://127.0.0.1:443/tenant%20one").assertIsDisplayed()
      composeRule.onNodeWithText("HTTP Basic").performClick()
      composeRule.onNodeWithTag("proxy-username").performTextReplacement("synthetic-user")
      composeRule.onNodeWithTag("proxy-password").performTextReplacement("discarded-draft-password")

      // Unsaved proxy credentials are intentionally lost, but their recovery entry point is not.
      restoration.emulateSavedInstanceStateRestore()
      composeRule.onNodeWithText("Proxy login").assertDoesNotExist()
      composeRule.onNodeWithText("Configure proxy login").performClick()
      composeRule.onNodeWithText("HTTP Basic").performClick()
      composeRule.onNodeWithTag("proxy-username").performTextReplacement("synthetic-user")
      composeRule.onNodeWithTag("proxy-save").assertIsNotEnabled()
      composeRule.onNodeWithTag("proxy-password").performTextReplacement("replacement-proxy-password")
      composeRule.onNodeWithTag("proxy-save").performScrollTo().performClick()
      composeRule.onNodeWithText("Connect").performClick()
      drainWithMainLooper { withTimeout(10_000) { model.gatewayConnectionDisplay.first { it.problem?.code == "NETWORK_UNREACHABLE" } } }
      composeRule.runOnIdle {
        assertFalse(model.onboardingCompleted.value)
        assertEquals(endpoint.stableId, model.activeGatewayStableId.value)
        assertEquals(savedAuth, prefs.loadGatewayCredentials(endpoint.stableId))
        assertEquals("paired-operator", deviceAuth.loadToken(endpoint.stableId, identity.deviceId, "operator"))
        assertEquals("paired-node", deviceAuth.loadToken(endpoint.stableId, identity.deviceId, "node"))
        assertEquals("replacement-proxy-password", prefs.loadGatewayProxyCredentials(endpoint)?.password)
      }

      // A node connection is not verified operator sign-in. Recover without resetting either grant.
      val identityProblem = problem.copy(code = "AUTH_VERIFIED_USER_REQUIRED", message = "Verified identity required")
      composeRule.runOnIdle {
        ReflectionHelpers.getField<MutableStateFlow<Boolean>>(runtime, "_nodeConnected").value = true
        ReflectionHelpers.getField<MutableStateFlow<GatewayConnectionDisplay>>(runtime, "_gatewayConnectionDisplay").value =
          GatewayConnectionDisplay(false, "Connected (operator: sign-in required)", identityProblem)
      }
      drainWithMainLooper { withTimeout(10_000) { model.gatewayConnectionDisplay.first { it.problem == identityProblem } } }
      restoration.emulateSavedInstanceStateRestore()
      composeRule.onNodeWithText("Verified sign-in required").assertIsDisplayed()
      composeRule.onNodeWithText("View details").performScrollTo().performClick()
      composeRule.onNodeWithText("Chat/operator connected: false", substring = true).assertIsDisplayed()
      composeRule.onNodeWithText("Node connected: true", substring = true).assertIsDisplayed()
      composeRule.onNodeWithText("Close").performClick()
      composeRule.onNodeWithText("Use authenticated setup code").performClick()
      composeRule.onNodeWithText("Enter setup code").assertIsDisplayed()
      composeRule.onNodeWithText("Connect to this Gateway?").assertDoesNotExist()
      composeRule.runOnIdle {
        assertFalse(model.onboardingCompleted.value)
        assertEquals(savedAuth, prefs.loadGatewayCredentials(endpoint.stableId))
        assertEquals("paired-operator", deviceAuth.loadToken(endpoint.stableId, identity.deviceId, "operator"))
        assertEquals("paired-node", deviceAuth.loadToken(endpoint.stableId, identity.deviceId, "node"))
        assertEquals("replacement-proxy-password", prefs.loadGatewayProxyCredentials(endpoint)?.password)
      }
    } finally {
      try {
        composeRule.runOnIdle { mounted.value = false }
        models.clear()
        drainWithMainLooper { withTimeout(10_000) { modelJob.cancelAndJoin() } }
      } finally {
        try {
          closeNodeRuntimeTestFixture(runtime)
        } finally {
          bindNodeRuntimeTestFixture(app, previousRuntime)
        }
      }
    }
  }
}
