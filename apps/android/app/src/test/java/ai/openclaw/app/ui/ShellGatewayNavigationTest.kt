package ai.openclaw.app.ui

import ai.openclaw.app.AndroidScreenshotFixture
import ai.openclaw.app.AndroidScreenshotScene
import ai.openclaw.app.HomeDestination
import ai.openclaw.app.MainViewModel
import ai.openclaw.app.NodeApp
import ai.openclaw.app.NodeRuntime
import ai.openclaw.app.NodeRuntimeMode
import ai.openclaw.app.SecurePrefs
import ai.openclaw.app.bindNodeRuntimeTestFixture
import ai.openclaw.app.closeNodeRuntimeTestFixture
import ai.openclaw.app.gateway.GatewayEndpoint
import ai.openclaw.app.gateway.GatewayRegistryEntry
import ai.openclaw.app.gateway.GatewayRegistryEntryKind
import android.content.Context
import androidx.activity.OnBackPressedDispatcher
import androidx.activity.compose.LocalOnBackPressedDispatcherOwner
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.hasAnyAncestor
import androidx.compose.ui.test.hasAnyDescendant
import androidx.compose.ui.test.hasClickAction
import androidx.compose.ui.test.hasScrollAction
import androidx.compose.ui.test.hasSetTextAction
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performTextReplacement
import androidx.lifecycle.SavedStateHandle
import androidx.lifecycle.ViewModelStore
import org.junit.Assert.assertNull
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import java.util.UUID

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w1000dp-h1000dp-mdpi")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class ShellGatewayNavigationTest {
  @get:Rule
  val composeRule = createComposeRule()

  @Test
  fun singleGatewayFooterReturnsToOriginWithSystemBack() {
    verifyGatewayReturn(gatewayCount = 1, systemBack = true)
  }

  @Test
  fun manageGatewaysReturnsToOriginWithHeaderBack() {
    verifyGatewayReturn(gatewayCount = 2, systemBack = false)
  }

  private fun verifyGatewayReturn(
    gatewayCount: Int,
    systemBack: Boolean,
  ) {
    val app = RuntimeEnvironment.getApplication() as NodeApp
    val originalRuntime = app.peekRuntime()
    val storage = app.getSharedPreferences("shell-gateway-navigation-${UUID.randomUUID()}", Context.MODE_PRIVATE)
    val prefs = SecurePrefs(app, storage)
    AndroidScreenshotFixture.configure(AndroidScreenshotScene.Settings)
    val runtime = NodeRuntime(app, prefs, NodeRuntimeMode.ScreenshotFixture)
    bindNodeRuntimeTestFixture(app, runtime)
    val model = MainViewModel(app, prefs, SavedStateHandle())
    val models = ViewModelStore()
    models.put("shell-gateway-navigation", model)
    val mounted = mutableStateOf(true)
    lateinit var backDispatcher: OnBackPressedDispatcher
    try {
      model.enterScreenshotFixtureMode(AndroidScreenshotScene.Settings)
      repeat(gatewayCount) { index ->
        val endpoint = GatewayEndpoint.manual("127.0.0.1", 19000 + index, false)
        prefs.gatewayRegistry.upsert(
          GatewayRegistryEntry(
            stableId = endpoint.stableId,
            kind = GatewayRegistryEntryKind.MANUAL,
            name = "Navigation gateway $index",
            host = endpoint.host,
            port = endpoint.port,
            tls = false,
          ),
        )
      }
      composeRule.setContent {
        backDispatcher = checkNotNull(LocalOnBackPressedDispatcherOwner.current).onBackPressedDispatcher
        if (mounted.value) ShellScreen(viewModel = model)
      }
      composeRule.waitForIdle()
      composeRule.onNodeWithContentDescription("Search settings").performClick()
      composeRule.waitForIdle()
      composeRule.onNode(hasSetTextAction()).performTextReplacement("Providers")
      val searchResults = hasScrollAction() and hasAnyDescendant(hasSetTextAction())
      val providersResult =
        composeRule.onNode(
          hasText("Providers & Models") and hasClickAction() and hasAnyAncestor(searchResults),
        )
      providersResult.performScrollTo()
      providersResult.performClick()
      composeRule.waitForIdle()
      composeRule.onNodeWithText("Review provider readiness\nand configured models.").assertIsDisplayed()

      composeRule.onNodeWithTag("sidebar-gateway-control").performClick()
      composeRule.waitForIdle()
      if (gatewayCount > 1) {
        composeRule.onNodeWithText("Manage Gateways").performClick()
        composeRule.waitForIdle()
      }
      composeRule.onNodeWithText("Connection between this phone and OpenClaw.").assertIsDisplayed()
      composeRule.runOnIdle {
        assertNull(model.requestedHomeDestination.value)
        assertNull(model.requestedSettingsRoute.value)
      }
      if (systemBack) {
        composeRule.runOnIdle { backDispatcher.onBackPressed() }
      } else {
        composeRule.onNodeWithContentDescription("Back").performClick()
      }
      composeRule.waitForIdle()
      composeRule.onNodeWithText("Review provider readiness\nand configured models.").assertIsDisplayed()

      // A plain Settings tab request must still clear the previous detail origin.
      composeRule.runOnIdle { model.requestHomeDestination(HomeDestination.Settings) }
      composeRule.waitForIdle()
      composeRule.onNodeWithContentDescription("Search settings").assertIsDisplayed()
      composeRule.runOnIdle { backDispatcher.onBackPressed() }
      composeRule.waitForIdle()
      composeRule.onNodeWithContentDescription("Search").assertIsDisplayed()
      composeRule.onNodeWithText("Review provider readiness\nand configured models.").assertDoesNotExist()
    } finally {
      composeRule.runOnIdle { mounted.value = false }
      models.clear()
      bindNodeRuntimeTestFixture(app, originalRuntime)
      closeNodeRuntimeTestFixture(runtime)
      AndroidScreenshotFixture.configure(AndroidScreenshotScene.Home)
    }
  }
}
