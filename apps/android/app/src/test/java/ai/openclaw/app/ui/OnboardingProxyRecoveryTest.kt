package ai.openclaw.app.ui

import ai.openclaw.app.AndroidScreenshotFixture
import ai.openclaw.app.AndroidScreenshotScene
import ai.openclaw.app.GatewayConnectionDisplay
import ai.openclaw.app.GatewayConnectionProblem
import ai.openclaw.app.GatewayCredentials
import ai.openclaw.app.MainViewModel
import ai.openclaw.app.NodeApp
import ai.openclaw.app.NodeRuntime
import ai.openclaw.app.NodeRuntimeMode
import ai.openclaw.app.SecurePrefs
import ai.openclaw.app.bindNodeRuntimeTestFixture
import ai.openclaw.app.closeNodeRuntimeTestFixture
import ai.openclaw.app.drainWithMainLooper
import ai.openclaw.app.gateway.DeviceAuthStore
import ai.openclaw.app.gateway.DeviceIdentityStore
import ai.openclaw.app.gateway.GatewayEndpoint
import ai.openclaw.app.gateway.GatewayProxyCredentials
import ai.openclaw.app.gateway.GatewayProxySaveResult
import ai.openclaw.app.gateway.GatewayTlsProbeFailure
import ai.openclaw.app.gateway.GatewayTlsProbeResult
import ai.openclaw.app.ui.design.ClawDesignTheme
import android.content.Context
import android.content.SharedPreferences
import android.graphics.Bitmap
import android.provider.Settings
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.captureToImage
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
import org.robolectric.annotation.GraphicsMode
import org.robolectric.util.ReflectionHelpers
import java.io.File
import java.util.Base64
import java.util.UUID

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "en-rUS-w360dp-h720dp-420dpi")
class OnboardingProxyRecoveryTest {
  @get:Rule val composeRule = createComposeRule()

  @Test
  @GraphicsMode(GraphicsMode.Mode.NATIVE)
  fun failedProxyCommitShowsActionableRecoveryWithoutReplacingSavedSecrets() = verifyRejectedProxySave(headerConflict = false)

  @Test
  @GraphicsMode(GraphicsMode.Mode.NATIVE)
  fun conflictingProxyHeaderShowsActionableRecoveryWithoutReplacingSavedSecrets() = verifyRejectedProxySave(headerConflict = true)

  private fun verifyRejectedProxySave(headerConflict: Boolean) {
    val app = ApplicationProvider.getApplicationContext<NodeApp>()
    MlKitContext.initializeIfNeeded(app)
    val animatorScale = Settings.Global.getString(app.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE)
    Settings.Global.putFloat(app.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 0f)
    val backing = ProxyCommitFailingPreferences(app.getSharedPreferences("rejected-onboarding-proxy-${UUID.randomUUID()}", Context.MODE_PRIVATE))
    val prefs = SecurePrefs(app, securePrefsOverride = backing)
    prefs.setOnboardingCompleted(false)
    AndroidScreenshotFixture.configure(AndroidScreenshotScene.Chat)
    val runtime = NodeRuntime(app, prefs, NodeRuntimeMode.ScreenshotFixture)
    runtime.prepareForGatewaySetup()
    val previousRuntime = app.peekRuntime()
    val models = ViewModelStore()
    val mounted = mutableStateOf(true)
    bindNodeRuntimeTestFixture(app, runtime)
    val model = MainViewModel(app, prefs, SavedStateHandle())
    models.put("rejected-onboarding-proxy", model)
    val modelJob = model.viewModelScope.coroutineContext.job
    try {
      val endpoint = GatewayEndpoint.manual("gateway.invalid", 443, tlsEnabled = true)
      val savedAuth = GatewayCredentials(token = "saved-token", bootstrapToken = "saved-setup", password = "saved-password")
      prefs.saveGatewayCredentials(endpoint.stableId, savedAuth)
      val deviceId = DeviceIdentityStore.withPrefs(app, prefs).loadOrCreate().deviceId
      val tokens = DeviceAuthStore(prefs)
      for (role in listOf("operator", "node")) {
        assertTrue(tokens.saveToken(endpoint.stableId, deviceId, role, "saved-$role"))
      }
      if (headerConflict) {
        prefs.saveGatewayCustomHeaders(endpoint.stableId, mapOf("Authorization" to "Bearer saved-header"))
      } else {
        assertEquals(GatewayProxySaveResult.SAVED, prefs.saveGatewayProxyCredentials(endpoint, GatewayProxyCredentials("saved-user", "saved-proxy")))
        backing.failProxyCommits = true
      }
      val savedGateways = prefs.gatewayRegistry.entries.value
      composeRule.setContent {
        ClawDesignTheme(dark = true) {
          if (mounted.value) Box(Modifier.fillMaxSize().testTag("rejected-proxy-proof")) { RootScreen(model) }
        }
      }
      composeRule.onNodeWithText("Continue").performClick()
      composeRule.onNodeWithText("Scan QR or setup code").performClick()
      composeRule.onNodeWithText("Enter setup code").performClick()
      val setup = Base64.getUrlEncoder().withoutPadding().encodeToString("""{"url":"wss://gateway.invalid","bootstrapToken":"replacement-setup"}""".toByteArray())
      composeRule.onNode(hasSetTextAction() and hasText("Paste setup code")).performTextReplacement(setup)
      composeRule.onNodeWithText("Use setup code").performClick()
      composeRule.onNodeWithText("Connect to this Gateway?").assertIsDisplayed()
      composeRule.onNodeWithText("HTTP Basic").performClick()
      // An existing paired account locks the username; only replace its password.
      if (headerConflict) composeRule.onNodeWithTag("proxy-username").performTextReplacement("replacement-user")
      composeRule.onNodeWithTag("proxy-password").performTextReplacement("replacement-proxy")
      composeRule.onNodeWithTag("proxy-save").performScrollTo().performClick()
      composeRule.onNodeWithText("Connect").performClick()
      val message = "Could not save proxy login. Check secure storage and existing proxy headers, then try again."
      drainWithMainLooper { withTimeout(5_000) { model.gatewayConnectionDisplay.first { it.statusText == message } } }
      composeRule.waitForIdle()
      // Keep the wrong baseline screen too: a Connecting state is this regression, not a harness failure.
      System.getenv("OPENCLAW_QR_PROOF_DIR")?.let { directory ->
        val target = File(directory, if (headerConflict) "proxy-header-rejection.png" else "proxy-commit-rejection.png")
        target.parentFile!!.mkdirs()
        target.outputStream().use { output ->
          assertTrue(
            composeRule
              .onNodeWithTag("rejected-proxy-proof")
              .captureToImage()
              .asAndroidBitmap()
              .compress(Bitmap.CompressFormat.PNG, 100, output),
          )
        }
      }
      composeRule.onNodeWithText(message).assertIsDisplayed()
      composeRule.onNodeWithText("Go back").assertIsDisplayed()
      composeRule.onNodeWithText("Connecting Gateway").assertDoesNotExist()
      composeRule.onNodeWithText("View details").performScrollTo().performClick()
      composeRule.onNodeWithText("Error code: PROXY_AUTH_SAVE_FAILED", substring = true).assertIsDisplayed()
      composeRule.onNodeWithText("Close").performClick()
      composeRule.runOnIdle {
        assertFalse(model.onboardingCompleted.value)
        assertEquals(savedGateways, prefs.gatewayRegistry.entries.value)
        assertEquals(savedAuth, prefs.loadGatewayCredentials(endpoint.stableId))
        for (role in listOf("operator", "node")) assertEquals("saved-$role", tokens.loadToken(endpoint.stableId, deviceId, role))
        assertEquals(if (headerConflict) null else "saved-proxy", prefs.loadGatewayProxyCredentials(endpoint)?.password)
        if (headerConflict) assertEquals(mapOf("Authorization" to "Bearer saved-header"), prefs.loadGatewayCustomHeaders(endpoint.stableId))
      }
      composeRule.onNodeWithText("Go back").performClick()
      composeRule.onNodeWithText("Enter setup code").assertIsDisplayed()
    } finally {
      try {
        composeRule.runOnIdle { mounted.value = false }
        models.clear()
        drainWithMainLooper { withTimeout(5_000) { modelJob.cancelAndJoin() } }
        closeNodeRuntimeTestFixture(runtime)
      } finally {
        bindNodeRuntimeTestFixture(app, previousRuntime)
        Settings.Global.putString(app.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, animatorScale)
        AndroidScreenshotFixture.configure(AndroidScreenshotScene.Home)
      }
    }
  }

  /** Fail the real secure-preferences commit without publishing the attempted replacement. */
  private class ProxyCommitFailingPreferences(
    private val delegate: SharedPreferences,
  ) : SharedPreferences by delegate {
    var failProxyCommits = false

    override fun edit(): SharedPreferences.Editor {
      val editor = delegate.edit()
      var touchesProxy = false
      return object : SharedPreferences.Editor by editor {
        override fun putString(
          key: String?,
          value: String?,
        ): SharedPreferences.Editor {
          touchesProxy = touchesProxy || key.orEmpty().startsWith("gateway.proxy.basic.")
          editor.putString(key, value)
          return this
        }

        override fun remove(key: String?): SharedPreferences.Editor {
          touchesProxy = touchesProxy || key.orEmpty().startsWith("gateway.proxy.basic.")
          editor.remove(key)
          return this
        }

        override fun commit(): Boolean = if (failProxyCommits && touchesProxy) false else editor.commit()
      }
    }
  }

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
