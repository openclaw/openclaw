package ai.openclaw.app.ui

import ai.openclaw.app.AndroidScreenshotFixture
import ai.openclaw.app.AndroidScreenshotScene
import ai.openclaw.app.AppearanceThemeMode
import ai.openclaw.app.GatewayNodeCapabilityApproval
import ai.openclaw.app.GatewayNodesDevicesSummary
import ai.openclaw.app.MainViewModel
import ai.openclaw.app.NodeApp
import ai.openclaw.app.NodeRuntime
import ai.openclaw.app.NodeRuntimeMode
import ai.openclaw.app.SecurePrefs
import ai.openclaw.app.bindNodeRuntimeTestFixture
import ai.openclaw.app.closeNodeRuntimeTestFixture
import ai.openclaw.app.ui.design.clawColorsForTheme
import ai.openclaw.app.ui.design.renderedLabelContrast
import android.content.Context
import android.graphics.Bitmap
import android.provider.Settings
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.graphics.toPixelMap
import androidx.compose.ui.test.assertHasClickAction
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.captureToImage
import androidx.compose.ui.test.hasAnyDescendant
import androidx.compose.ui.test.hasClickAction
import androidx.compose.ui.test.hasContentDescription
import androidx.compose.ui.test.hasScrollToIndexAction
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performScrollToNode
import androidx.lifecycle.SavedStateHandle
import androidx.lifecycle.ViewModelStore
import kotlinx.coroutines.flow.MutableStateFlow
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.ExternalResource
import org.junit.rules.RuleChain
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import org.robolectric.util.ReflectionHelpers
import java.io.File
import java.util.UUID

/** Exercises the real shell -> Overview boundary with an isolated, in-memory runtime. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "en-rUS-w360dp-h800dp-mdpi", instrumentedPackages = ["ai.openclaw.app.AndroidScreenshotFixture"])
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class OverviewLayoutTest {
  private val composeRule = createComposeRule()
  private val models = ViewModelStore()
  private lateinit var app: NodeApp
  private lateinit var prefs: SecurePrefs
  private lateinit var runtime: NodeRuntime
  private lateinit var model: MainViewModel
  private var previousRuntime: NodeRuntime? = null
  private var restoreAnimatorScale: (() -> Unit)? = null
  private val evidence by lazy {
    File("build/outputs/overview-layout", UUID.randomUUID().toString()).also { check(it.mkdirs()) }
  }

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
                try {
                  if (::app.isInitialized) bindNodeRuntimeTestFixture(app, previousRuntime)
                } finally {
                  AndroidScreenshotFixture.configure(AndroidScreenshotScene.Home)
                  restoreAnimatorScale?.invoke()
                }
              }
            }
          }
        },
      ).around(composeRule)

  @Before
  fun setUp() {
    app = RuntimeEnvironment.getApplication() as NodeApp
    previousRuntime = app.peekRuntime()
    val resolver = app.contentResolver
    val originalScale = Settings.Global.getString(resolver, Settings.Global.ANIMATOR_DURATION_SCALE)
    restoreAnimatorScale = { Settings.Global.putString(resolver, Settings.Global.ANIMATOR_DURATION_SCALE, originalScale) }
    Settings.Global.putFloat(resolver, Settings.Global.ANIMATOR_DURATION_SCALE, 0f)
    prefs = SecurePrefs(app, app.getSharedPreferences("overview-layout-" + UUID.randomUUID(), Context.MODE_PRIVATE))
    AndroidScreenshotFixture.configure(AndroidScreenshotScene.Home)
    runtime = NodeRuntime(app, prefs, NodeRuntimeMode.ScreenshotFixture)
    bindNodeRuntimeTestFixture(app, runtime)
    model = MainViewModel(app, prefs, SavedStateHandle())
    models.put("overview", model)
    model.enterScreenshotFixtureMode(AndroidScreenshotScene.Home)
  }

  @Test
  fun statusDestinationsUseFullWidthRowsInsteadOfCompetingTiles() {
    composeRule.setContent { ShellScreen(model) }
    composeRule.waitUntil { model.chatSessions.value.isNotEmpty() }
    composeRule.onNode(hasScrollToIndexAction() and hasAnyDescendant(hasText("Overview"))).performScrollToNode(hasContentDescription("Open Gateway"))
    capture("status-list")
    val labels = listOf("Gateway", "Nodes", "Approvals", "Threads", "Files")
    val rows =
      labels.map { label ->
        val node = composeRule.onNodeWithContentDescription("Open $label").assertHasClickAction().fetchSemanticsNode()
        node.positionInRoot to node.size
      }
    composeRule
      .onNodeWithContentDescription("Talk settings")
      .performScrollTo()
      .assertIsDisplayed()
      .assertHasClickAction()
    composeRule.onNodeWithText("Open Talk").assertHasClickAction()
    composeRule
      .onNodeWithText("View all")
      .performScrollTo()
      .assertIsDisplayed()
      .assertHasClickAction()
    composeRule.onNode(hasScrollToIndexAction()).performScrollToNode(hasText(AndroidScreenshotFixture.primarySessionTitle))
    composeRule
      .onNodeWithText(AndroidScreenshotFixture.primarySessionTitle)
      .performScrollTo()
      .assertIsDisplayed()
      .assertHasClickAction()
    capture("recent-threads")
    val first = rows.first()
    for ((index, row) in rows.withIndex()) {
      assertTrue("${labels[index]} must use the phone content width", row.second.width >= 280)
      assertEquals("Status rows must share a leading edge", first.first.x, row.first.x, 1f)
      if (index > 0) {
        val previous = rows[index - 1]
        assertTrue("Status destinations must stack, not form a card grid", row.first.y >= previous.first.y + previous.second.height)
      }
    }
  }

  @Test
  fun chatUsesTheThemePrimaryActionInDarkAndLightModes() {
    composeRule.setContent { ShellScreen(model) }
    val paints = mutableListOf<Pair<Int, Int>>()
    for (dark in listOf(true, false)) {
      composeRule.runOnIdle { prefs.setAppearanceThemeMode(if (dark) AppearanceThemeMode.Dark else AppearanceThemeMode.Light) }
      val chat =
        composeRule
          .onNodeWithText("Chat")
          .performScrollTo()
          .assertIsDisplayed()
          .assertHasClickAction()
      capture(if (dark) "primary-dark" else "primary-light")
      val pixels = chat.captureToImage().toPixelMap()
      paints += clawColorsForTheme(dark = dark, accentArgb = null).primary.toArgb() to pixels[pixels.width / 2, 4].toArgb()
    }
    paints.forEach { (expected, actual) ->
      assertEquals("Chat must paint the shared primary color, not another gray panel", expected, actual)
    }
  }

  @Test
  fun talkSettingsStillOpensVoiceSettingsRatherThanTheTalkRow() {
    composeRule.setContent { ShellScreen(model) }
    composeRule.onNodeWithContentDescription("Talk settings").performScrollTo().performClick()
    composeRule.onNodeWithText("Configure wake words, talk, and playback.").assertIsDisplayed()
    composeRule.onNodeWithContentDescription("Back").performClick()
    composeRule.onNodeWithText("Overview").assertIsDisplayed()
  }

  @Test
  fun overviewStatusKeepsReadableSemanticFillAcrossConnectionStatesAndThemes() {
    composeRule.setContent { ShellScreen(model) }
    val failures = mutableListOf<String>()
    for (label in listOf("Online", "Needs attention", "Offline")) {
      composeRule.runOnIdle {
        when (label) {
          "Needs attention" -> {
            // Publish a synthetic pending-node snapshot through the existing runtime state contract.
            val nodes = ReflectionHelpers.getField<MutableStateFlow<GatewayNodesDevicesSummary>>(runtime, "_nodesDevicesSummary")
            nodes.value = nodes.value.copy(nodes = nodes.value.nodes.map { it.copy(approvalState = GatewayNodeCapabilityApproval.Unapproved) })
          }

          "Offline" -> {
            runtime.disconnect()
          }
        }
      }
      for (dark in listOf(true, false)) {
        composeRule.runOnIdle { prefs.setAppearanceThemeMode(if (dark) AppearanceThemeMode.Dark else AppearanceThemeMode.Light) }
        val status = hasText(label) and hasClickAction() and !hasContentDescription("Open Gateway") and !hasContentDescription("Open Files")
        val control = composeRule.onNode(status).assertIsDisplayed().assertHasClickAction()
        val text = composeRule.onAllNodesWithText(label, useUnmergedTree = true)[0]
        val labelBounds = text.fetchSemanticsNode().boundsInRoot
        val controlBounds = control.fetchSemanticsNode().boundsInRoot
        assertTrue("Contrast must measure the dropdown label", labelBounds.top >= controlBounds.top && labelBounds.bottom <= controlBounds.bottom)
        val contrast = renderedLabelContrast(label = text, container = control)
        assertTrue("Status dropdown must retain its 48dp hit area", control.fetchSemanticsNode().size.height >= 48)
        capture("status-" + label.replace(' ', '-') + if (dark) "-dark" else "-light")
        println("OVERVIEW_STATUS_CONTRAST label=$label dark=$dark ratio=" + contrast.ratio + " background=" + contrast.background.toArgb())
        if (contrast.ratio < 4.5f) failures += "$label dark=$dark: " + contrast.ratio
      }
    }
    composeRule.onNode(hasText("Offline") and hasClickAction() and !hasContentDescription("Open Gateway") and !hasContentDescription("Open Files")).performClick()
    composeRule.onAllNodesWithText("Gateway")[0].assertIsDisplayed()
    composeRule.onNodeWithContentDescription("Back").performClick()
    composeRule.onNodeWithText("Reconnect gateway").assertIsDisplayed().assertHasClickAction()
    assertTrue("Overview status text must retain at least 4.5:1 rendered contrast: " + failures.joinToString(), failures.isEmpty())
  }

  private fun capture(name: String) {
    val image = composeRule.onRoot().captureToImage().asAndroidBitmap()
    assertTrue("Capture must include the full phone root", image.width >= 360 && image.height >= 700)
    File(evidence, "$name.png").outputStream().use { stream ->
      assertTrue(image.compress(Bitmap.CompressFormat.PNG, 100, stream))
    }
    println("OVERVIEW_LAYOUT_PROOF " + File(evidence, "$name.png").absolutePath)
  }
}
