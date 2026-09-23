package ai.openclaw.app.ui

import ai.openclaw.app.MainViewModel
import ai.openclaw.app.NodeApp
import ai.openclaw.app.NodeRuntime
import ai.openclaw.app.NodeRuntimeMode
import ai.openclaw.app.SecurePrefs
import ai.openclaw.app.bindNodeRuntimeTestFixture
import ai.openclaw.app.closeNodeRuntimeTestFixture
import ai.openclaw.app.gateway.GatewayRegistryEntry
import ai.openclaw.app.gateway.GatewayRegistryEntryKind
import ai.openclaw.app.ui.design.ClawDesignTheme
import android.content.Context
import android.graphics.Bitmap
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.assert
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.captureToImage
import androidx.compose.ui.test.getUnclippedBoundsInRoot
import androidx.compose.ui.test.hasClickAction
import androidx.compose.ui.test.hasSetTextAction
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performTextReplacement
import androidx.lifecycle.SavedStateHandle
import androidx.lifecycle.ViewModelStore
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.ExternalResource
import org.junit.rules.RuleChain
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import java.io.File
import java.util.Base64
import java.util.UUID

/** Exercises the actual Settings route, including the retained credential-replacement action. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "en-rUS-w360dp-h800dp-mdpi")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class GatewaySettingsScreenTest {
  private val composeRule = createComposeRule()
  private val models = ViewModelStore()
  private lateinit var app: NodeApp
  private lateinit var prefs: SecurePrefs
  private lateinit var runtime: NodeRuntime
  private lateinit var model: MainViewModel
  private var previousRuntime: NodeRuntime? = null

  // Compose consumers must be disposed before joining runtime cleanup.
  @get:Rule
  val fixtureRules: RuleChain =
    RuleChain
      .outerRule(
        object : ExternalResource() {
          override fun after() {
            try {
              models.clear()
            } finally {
              try {
                if (::runtime.isInitialized) closeNodeRuntimeTestFixture(runtime)
              } finally {
                if (::app.isInitialized) bindNodeRuntimeTestFixture(app, previousRuntime)
              }
            }
          }
        },
      ).around(composeRule)

  @Test
  fun connectionActionsAndSavedGatewaysPrecedeCollapsedTechnicalDetails() {
    showGateway()
    capture("connection-actions")
    composeRule.onNodeWithText("Reconnect").assertIsDisplayed()
    composeRule.onNodeWithText("Disconnect").assertIsDisplayed()
    val actions = composeRule.onNodeWithText("Reconnect").getUnclippedBoundsInRoot()
    val saved = composeRule.onNodeWithText("Local QA Gateway").getUnclippedBoundsInRoot()
    assertTrue("Connection actions precede saved gateways", actions.bottom <= saved.top)
    composeRule.onNodeWithText("Instance ID").assertDoesNotExist()
    composeRule.onNodeWithContentDescription("Host").assertDoesNotExist()
    composeRule.onNode(hasSetTextAction() and hasText("Setup code")).assertDoesNotExist()

    val entries = prefs.gatewayRegistry.entries.value
    composeRule.onNodeWithText("Add Gateway").performScrollTo().performClick()
    composeRule.runOnIdle {
      assertNotNull(model.gatewayAdditionRequest.value)
      assertEquals(entries, prefs.gatewayRegistry.entries.value)
      model.dismissGatewayAddition(requireNotNull(model.gatewayAdditionRequest.value))
    }
    composeRule.onNodeWithText("Diagnostics").performScrollTo().performClick()
    composeRule.onNodeWithText("Instance ID").performScrollTo().assertIsDisplayed()
    composeRule.onNodeWithText("Diagnose").performScrollTo().assertIsDisplayed()
  }

  @Test
  fun invalidSetupCodeShowsErrorBesideItsActionWithoutChangingSavedSettings() {
    showGateway()
    openManualSettings()
    val entries = prefs.gatewayRegistry.entries.value
    val code = composeRule.onNode(hasSetTextAction() and hasText("Setup code"))
    code.performScrollTo().performTextReplacement("not a setup code")
    val connect = composeRule.onNodeWithText("Connect").performScrollTo().performClick()
    val message = "Enter a valid setup code or gateway address."
    val error = composeRule.onNodeWithText(message)
    connect.performScrollTo()
    capture("invalid-setup-code")
    error.assertIsDisplayed()
    code.assertIsDisplayed()
    composeRule.onAllNodesWithText(message).assertCountEquals(1)
    assertTrue("Setup validation belongs above its Connect action", error.getUnclippedBoundsInRoot().bottom <= connect.getUnclippedBoundsInRoot().top)
    composeRule.runOnIdle {
      assertEquals(entries, prefs.gatewayRegistry.entries.value)
      assertEquals("127.0.0.1", prefs.manualHost.value)
      assertEquals(18789, prefs.manualPort.value)
    }
    code.performTextReplacement("correcting the code")
    error.assertDoesNotExist()
  }

  @Test
  fun populatedManualFieldsKeepLabelsAndSecretsStayMasked() {
    showGateway()
    openManualSettings()
    val fields =
      listOf(
        Triple("Host", "127.0.0.1", "192.168.0.25"),
        Triple("Port", "18789", "18790"),
        Triple("Token", "Token", "synthetic-token"),
        Triple("Bootstrap", "Bootstrap", "synthetic-bootstrap"),
        Triple("Password", "Password", "synthetic-password"),
      )
    for ((_, initial, value) in fields) {
      composeRule.onNode(hasSetTextAction() and hasText(initial)).performScrollTo().performTextReplacement(value)
    }
    composeRule.onNodeWithText("Save & Connect").performScrollTo()
    capture("populated-manual-fields")
    for ((label, _, _) in fields) {
      val field = composeRule.onNodeWithContentDescription(label)
      field.performScrollTo()
      composeRule.onNodeWithText(label, useUnmergedTree = true).assertIsDisplayed()
      field.assert(
        if (label == "Host" || label == "Port") {
          SemanticsMatcher.keyNotDefined(SemanticsProperties.Password)
        } else {
          SemanticsMatcher.keyIsDefined(SemanticsProperties.Password)
        },
      )
    }
    composeRule.runOnIdle {
      assertEquals("Editing is not persistence", "127.0.0.1", prefs.manualHost.value)
      assertEquals(18789, prefs.manualPort.value)
    }
  }

  @Test
  fun setupReplacementStillRequiresConfirmationAndCancelPreservesSavedGateway() {
    showGateway()
    val entries = prefs.gatewayRegistry.entries.value
    val code =
      Base64.getUrlEncoder().withoutPadding().encodeToString(
        """{"url":"ws://127.0.0.1:18789","bootstrapToken":"synthetic-replacement"}""".toByteArray(),
      )
    openManualSettings()
    composeRule.onNode(hasSetTextAction() and hasText("Setup code")).performScrollTo().performTextReplacement(code)
    composeRule.onNodeWithText("Connect").performScrollTo().performClick()
    composeRule.onNodeWithText("Replace gateway setup?").assertIsDisplayed()
    composeRule.onNodeWithText("Cancel").performClick()
    composeRule.onNodeWithText("Replace gateway setup?").assertDoesNotExist()
    composeRule.runOnIdle { assertEquals(entries, prefs.gatewayRegistry.entries.value) }
  }

  @Test
  fun technicalDisclosuresAnnounceExpansionRatherThanSelection() {
    showGateway()
    for (label in listOf("Discovered", "Diagnostics", "Manual Gateway")) {
      val disclosure = composeRule.onNode(hasText(label) and hasClickAction())
      disclosure.performScrollTo()
      disclosure.assert(SemanticsMatcher.expectValue(SemanticsProperties.StateDescription, "Collapsed"))
      disclosure.assert(SemanticsMatcher.keyNotDefined(SemanticsProperties.Selected))
      disclosure.performClick()
      disclosure.assert(SemanticsMatcher.expectValue(SemanticsProperties.StateDescription, "Expanded"))
      disclosure.performScrollTo().performClick()
      disclosure.assert(SemanticsMatcher.expectValue(SemanticsProperties.StateDescription, "Collapsed"))
    }
  }

  private fun openManualSettings() {
    // Baseline already renders the form; the candidate discloses the same replacement action.
    if (composeRule.onAllNodes(hasSetTextAction() and hasText("Setup code")).fetchSemanticsNodes().isEmpty()) {
      composeRule.onNodeWithText("Manual Gateway").performScrollTo().performClick()
    }
  }

  private fun capture(name: String) {
    val directory = File("build/outputs/gateway-settings-proof", UUID.randomUUID().toString())
    check(directory.mkdirs())
    val image = composeRule.onRoot().captureToImage().asAndroidBitmap()
    assertTrue("Capture must include the full nonzero screen", image.width >= 360 && image.height >= 700)
    val file = File(directory, "$name.png")
    file.outputStream().use { assertTrue(image.compress(Bitmap.CompressFormat.PNG, 100, it)) }
    println("Gateway settings proof: " + file.absolutePath)
  }

  private fun showGateway() {
    app = RuntimeEnvironment.getApplication() as NodeApp
    previousRuntime = app.peekRuntime()
    prefs = SecurePrefs(app, app.getSharedPreferences("gateway-settings-${UUID.randomUUID()}", Context.MODE_PRIVATE))
    prefs.setManualHost("127.0.0.1")
    prefs.setManualPort(18789)
    prefs.gatewayRegistry.upsert(
      GatewayRegistryEntry(
        stableId = "manual|127.0.0.1|18789",
        kind = GatewayRegistryEntryKind.MANUAL,
        name = "Local QA Gateway",
        host = "127.0.0.1",
        port = 18789,
        tls = false,
      ),
    )
    runtime = NodeRuntime(app, prefs, NodeRuntimeMode.ScreenshotFixture)
    runtime.disconnect()
    bindNodeRuntimeTestFixture(app, runtime)
    model = MainViewModel(app, prefs, SavedStateHandle()).also { models.put("gateway", it) }
    composeRule.setContent { ClawDesignTheme { SettingsDetailScreen(model, SettingsRoute.Gateway, onBack = {}) } }
  }
}
