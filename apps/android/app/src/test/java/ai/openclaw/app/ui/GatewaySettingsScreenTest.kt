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
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.captureToImage
import androidx.compose.ui.test.getUnclippedBoundsInRoot
import androidx.compose.ui.test.hasClickAction
import androidx.compose.ui.test.hasContentDescription
import androidx.compose.ui.test.hasSetTextAction
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.isDialog
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
import org.junit.Assert.assertNull
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
  fun gatewayMetricUsesLocalOverrideAndRestoresConnectedServerName() {
    showGateway(connected = true)
    capture("default-gateway-metric")
    composeRule.onNodeWithText("OpenClaw Gateway").assertIsDisplayed()
    composeRule.runOnIdle {
      assertTrue(prefs.gatewayRegistry.rename("manual|127.0.0.1|18789", "My gateway"))
    }
    composeRule.onAllNodesWithText("My gateway").assertCountEquals(2)
    composeRule.onNodeWithText("OpenClaw Gateway").assertDoesNotExist()
    composeRule.runOnIdle {
      assertTrue(prefs.gatewayRegistry.rename("manual|127.0.0.1|18789", ""))
    }
    composeRule.onNodeWithText("OpenClaw Gateway").assertIsDisplayed()
  }

  @Test
  fun unchangedRenameSaveStillFollowsAutomaticNameUpdates() {
    showGateway()
    val original =
      prefs.gatewayRegistry.entries.value
        .single()
    composeRule.onNodeWithText("Rename").performScrollTo().performClick()
    capture("unchanged-rename-dialog", dialog = true)
    composeRule.onNodeWithText("Save").performClick()
    composeRule.waitUntil { composeRule.onAllNodesWithText("Rename gateway").fetchSemanticsNodes().isEmpty() }
    composeRule.runOnIdle {
      prefs.gatewayRegistry.upsert(original.copy(name = "Updated discovery name"))
    }
    capture("automatic-name-refresh")
    composeRule.onNodeWithText("Updated discovery name").assertIsDisplayed()
    composeRule.runOnIdle {
      assertNull(
        prefs.gatewayRegistry.entries.value
          .single()
          .localName,
      )
    }
  }

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
  fun secureManualGatewayMergesMaskedProxyHeadersWhenConnecting() {
    showGateway()
    val stableId = "manual|gateway.example|443"
    val saved = mapOf("CF-Access-Client-Id" to "saved-id", "CF-Access-Client-Secret" to "expired-secret")
    prefs.saveGatewayCustomHeaders(stableId, saved)
    openManualSettings()
    composeRule.onNodeWithText("Unencrypted").performScrollTo().performClick()
    composeRule.onNodeWithContentDescription("Header name").assertDoesNotExist()
    composeRule.onNode(hasSetTextAction() and hasText("127.0.0.1")).performScrollTo().performTextReplacement("gateway.example")
    composeRule.onNode(hasSetTextAction() and hasText("18789")).performScrollTo().performTextReplacement("443")

    val name = composeRule.onNodeWithContentDescription("Header name")
    val value = composeRule.onNodeWithContentDescription("Header value")
    val add = composeRule.onNodeWithText("Add header")
    composeRule.waitUntil(timeoutMillis = 10_000) { composeRule.onAllNodesWithText("Saved headers for https://gateway.example").fetchSemanticsNodes().isNotEmpty() }
    composeRule.onNodeWithText("CF-Access-Client-Secret").performScrollTo().assertIsDisplayed()
    assertNoText("saved-id", "expired-secret")
    // The saved Client ID header points the next name at the secret.
    composeRule.onNode(hasSetTextAction() and hasText("e.g. CF-Access-Client-Secret")).assertExists()
    name.performScrollTo().performTextReplacement("Host")
    value.performScrollTo().performTextReplacement("smuggled.example")
    composeRule.onNodeWithText("This header is set by the connection itself.").performScrollTo().assertIsDisplayed()
    add.performScrollTo().assertIsNotEnabled()

    name.performScrollTo().performTextReplacement("cf-access-client-secret")
    value.performScrollTo().performTextReplacement("rotated-secret")
    value.assert(SemanticsMatcher.keyIsDefined(SemanticsProperties.Password))
    add.performScrollTo().performClick()
    composeRule.onNodeWithText("cf-access-client-secret").assertIsDisplayed()
    // A complete header that was typed but never added still belongs to this connect.
    name.performScrollTo().performTextReplacement("X-Proxy-Tenant")
    value.performScrollTo().performTextReplacement("synthetic-tenant")
    capture("manual-gateway-custom-headers")
    composeRule.runOnIdle { assertEquals("Editing is not persistence", saved, prefs.loadGatewayCustomHeaders(stableId)) }

    composeRule.onNodeWithText("Save & Connect").performScrollTo().performClick()
    val expected = mapOf("CF-Access-Client-Id" to "saved-id", "cf-access-client-secret" to "rotated-secret", "X-Proxy-Tenant" to "synthetic-tenant")
    composeRule.waitUntil(timeoutMillis = 10_000) { prefs.loadGatewayCustomHeaders(stableId) == expected }
  }

  @Test
  fun secureManualGatewayKeepsTypedHeadersWhenThePortIsCorrected() {
    showGateway()
    openManualSettings()
    val expected = mapOf("CF-Access-Client-Id" to "synthetic-client-id", "CF-Access-Client-Secret" to "synthetic-client-secret")
    composeRule.onNode(hasSetTextAction() and hasText("127.0.0.1")).performScrollTo().performTextReplacement("gateway.example")
    val name = composeRule.onNodeWithContentDescription("Header name")
    val value = composeRule.onNodeWithContentDescription("Header value")
    name.performScrollTo().performTextReplacement("CF-Access-Client-Id")
    value.performScrollTo().performTextReplacement("synthetic-client-id")
    composeRule.onNodeWithText("Add header").performScrollTo().performClick()
    name.performScrollTo().performTextReplacement("CF-Access-Client-Secret")
    value.performScrollTo().performTextReplacement("synthetic-client-secret")
    // The default port is wrong for a Cloudflare hostname; this attempt saves the address and headers under it.
    composeRule.onNodeWithText("Save & Connect").performScrollTo().performClick()
    composeRule.waitUntil(timeoutMillis = 10_000) { prefs.loadGatewayCustomHeaders("manual|gateway.example|18789") == expected }

    composeRule.onNode(hasSetTextAction() and hasText("18789")).performScrollTo().performTextReplacement("443")
    composeRule.onNodeWithText("Save & Connect").performScrollTo().performClick()
    composeRule.waitUntil(timeoutMillis = 10_000) { prefs.loadGatewayCustomHeaders("manual|gateway.example|443") == expected }

    // An address saved from elsewhere, such as a setup code, must not inherit these rows.
    composeRule.runOnIdle { prefs.setManualHost("other.example") }
    composeRule.onNode(hasSetTextAction() and hasText("other.example")).performScrollTo()
    composeRule.onAllNodes(hasContentDescription("Remove header CF-Access-Client-Secret")).assertCountEquals(0)
  }

  @Test
  fun savedProxyHeadersListNamesOnlyAndRemoveOneAfterConfirmation() {
    showGateway()
    val stableId = "manual|gateway.example|443"
    val misplacedClientId = "0123456789abcdef0123456789abcdef.access"
    prefs.saveGatewayCustomHeaders(
      stableId,
      mapOf("CF-Access-Client-Id" to "synthetic-client-id", misplacedClientId to "synthetic-secret", "X-Proxy-Tenant" to "synthetic-tenant"),
    )
    openManualSettings()
    composeRule.onNode(hasSetTextAction() and hasText("127.0.0.1")).performScrollTo().performTextReplacement("gateway.example")
    composeRule.onNode(hasSetTextAction() and hasText("18789")).performScrollTo().performTextReplacement("443")
    composeRule.waitUntil(timeoutMillis = 10_000) { composeRule.onAllNodesWithText("Client ID saved as a header name").fetchSemanticsNodes().isNotEmpty() }
    composeRule.onNodeWithText("X-Proxy-Tenant").performScrollTo().assertIsDisplayed()
    // A credential saved as a name is described, never printed or announced.
    assertNoText("synthetic-client-id", "synthetic-secret", "synthetic-tenant", "0123456789abcdef")
    capture("manual-gateway-saved-headers")

    composeRule.onNodeWithContentDescription("Remove saved header X-Proxy-Tenant").performScrollTo().performClick()
    composeRule.onNodeWithText("Remove saved header?").assertIsDisplayed()
    composeRule.onNodeWithText("Cancel").performClick()
    composeRule.onNodeWithText("Remove saved header?").assertDoesNotExist()

    composeRule.onNodeWithContentDescription("Remove saved header Client ID saved as a header name").performScrollTo().performClick()
    assertNoText("0123456789abcdef")
    composeRule.onNodeWithText("Remove").performClick()
    val expected = mapOf("CF-Access-Client-Id" to "synthetic-client-id", "X-Proxy-Tenant" to "synthetic-tenant")
    composeRule.waitUntil(timeoutMillis = 10_000) { prefs.loadGatewayCustomHeaders(stableId) == expected }
    composeRule.waitUntil(timeoutMillis = 10_000) { composeRule.onAllNodesWithText("Client ID saved as a header name").fetchSemanticsNodes().isEmpty() }
    composeRule.runOnIdle { assertEquals("Removing a header is not a connect", "127.0.0.1", prefs.manualHost.value) }
  }

  @Test
  fun credentialTypedAsHeaderNameBlocksAddAndConnect() {
    showGateway()
    openManualSettings()
    composeRule.onNode(hasSetTextAction() and hasText("127.0.0.1")).performScrollTo().performTextReplacement("gateway.example")
    composeRule.onNode(hasSetTextAction() and hasText("18789")).performScrollTo().performTextReplacement("443")
    composeRule.onNode(hasSetTextAction() and hasText("e.g. CF-Access-Client-Id")).assertExists()
    val name = composeRule.onNodeWithContentDescription("Header name")
    composeRule.onNodeWithContentDescription("Header value").performScrollTo().performTextReplacement("synthetic-secret")
    val warnings =
      listOf(
        "0123456789abcdef0123456789abcdef.access" to "This looks like a Cloudflare Access Client ID. Put it in Header value and enter CF-Access-Client-Id as Header name.",
        "0123456789abcdef".repeat(4) to "This looks like a secret. Put it in Header value, not Header name.",
        "cfast_${"a1".repeat(24)}" to "This looks like a secret. Put it in Header value, not Header name.",
      )
    for ((typed, warning) in warnings) {
      name.performScrollTo().performTextReplacement(typed)
      composeRule.onNodeWithText(warning).performScrollTo().assertIsDisplayed()
      composeRule.onNodeWithText("Add header").performScrollTo().assertIsNotEnabled()
    }
    capture("manual-gateway-client-id-warning")

    composeRule.onNodeWithText("Save & Connect").performScrollTo().performClick()
    composeRule.onNodeWithText("Fix the custom header above before connecting.").performScrollTo().assertIsDisplayed()
    composeRule.runOnIdle {
      assertEquals("A blocked connect keeps the form", "127.0.0.1", prefs.manualHost.value)
      assertTrue(prefs.loadGatewayCustomHeaders("manual|gateway.example|443").isEmpty())
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

  private fun assertNoText(vararg fragments: String) {
    for (fragment in fragments) {
      composeRule.onAllNodes(hasText(fragment, substring = true), useUnmergedTree = true).assertCountEquals(0)
      composeRule.onAllNodes(hasContentDescription(fragment, substring = true), useUnmergedTree = true).assertCountEquals(0)
    }
  }

  private fun openManualSettings() {
    // Baseline already renders the form; the candidate discloses the same replacement action.
    if (composeRule.onAllNodes(hasSetTextAction() and hasText("Setup code")).fetchSemanticsNodes().isEmpty()) {
      composeRule.onNodeWithText("Manual Gateway").performScrollTo().performClick()
    }
  }

  private fun capture(
    name: String,
    dialog: Boolean = false,
  ) {
    val directory = File("build/outputs/gateway-settings-proof", UUID.randomUUID().toString())
    check(directory.mkdirs())
    val image = (if (dialog) composeRule.onNode(isDialog()) else composeRule.onRoot()).captureToImage().asAndroidBitmap()
    assertTrue("Capture must include the full nonzero screen", image.width >= 360 && image.height >= 700)
    val file = File(directory, "$name.png")
    file.outputStream().use { assertTrue(image.compress(Bitmap.CompressFormat.PNG, 100, it)) }
    println("Gateway settings proof: " + file.absolutePath)
  }

  private fun showGateway(connected: Boolean = false) {
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
    if (connected) {
      prefs.gatewayRegistry.setActive("manual|127.0.0.1|18789")
    } else {
      runtime.disconnect()
    }
    bindNodeRuntimeTestFixture(app, runtime)
    model = MainViewModel(app, prefs, SavedStateHandle()).also { models.put("gateway", it) }
    composeRule.setContent { ClawDesignTheme { SettingsDetailScreen(model, SettingsRoute.Gateway, onBack = {}) } }
  }
}
