package ai.openclaw.app.ui

import ai.openclaw.app.GatewayConnectionDisplay
import ai.openclaw.app.MainViewModel
import ai.openclaw.app.NodeApp
import ai.openclaw.app.NodeRuntime
import ai.openclaw.app.NodeRuntimeMode
import ai.openclaw.app.SecurePrefs
import ai.openclaw.app.bindNodeRuntimeTestFixture
import ai.openclaw.app.closeNodeRuntimeTestFixture
import ai.openclaw.app.i18n.NativeStringResources
import ai.openclaw.app.i18n.nativeString
import ai.openclaw.app.ui.design.ClawDesignTheme
import ai.openclaw.app.ui.design.ClawTheme
import android.content.Context
import android.graphics.Bitmap
import android.provider.Settings
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.DeviceConfigurationOverride
import androidx.compose.ui.test.FontScale
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.assert
import androidx.compose.ui.test.assertHasClickAction
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.captureToImage
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.printToString
import androidx.compose.ui.unit.dp
import androidx.core.os.LocaleListCompat
import androidx.lifecycle.SavedStateHandle
import androidx.lifecycle.ViewModelStore
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import java.io.File
import java.util.UUID

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [36], qualifiers = "fr-rFR-w320dp-h800dp-mdpi")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class SidebarCollapsibleHeaderTest {
  @get:Rule
  val composeRule = createComposeRule()

  @Test
  fun realSidebarAnnouncesRecentExpansionAtLargeFont() {
    val app = RuntimeEnvironment.getApplication() as NodeApp
    val previousRuntime = app.peekRuntime()
    val previousScale = Settings.Global.getString(app.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE)
    val prefs = SecurePrefs(app, app.getSharedPreferences("sidebar-accessibility-${UUID.randomUUID()}", Context.MODE_PRIVATE))
    val runtime = NodeRuntime(app, prefs, NodeRuntimeMode.ScreenshotFixture)
    val models = ViewModelStore()
    val mounted = mutableStateOf(true)
    NativeStringResources.install(app)
    NativeStringResources.setApplicationLocales(LocaleListCompat.forLanguageTags("fr"))
    val evidence = File("build/outputs/sidebar-accessibility", UUID.randomUUID().toString())
    check(evidence.mkdirs())
    try {
      Settings.Global.putFloat(app.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 0f)
      bindNodeRuntimeTestFixture(app, runtime)
      val model = MainViewModel(app, prefs, SavedStateHandle()).also { models.put("sidebar", it) }
      composeRule.setContent {
        if (mounted.value) {
          DeviceConfigurationOverride(DeviceConfigurationOverride.FontScale(2f)) {
            ClawDesignTheme {
              OpenClawSidebar(
                viewModel = model,
                agents = emptyList(),
                selectedAgentId = "main",
                sessions = emptyList(),
                activeSessionKey = "agent:main:test",
                activeDestination = null,
                connection = GatewayConnectionDisplay(false, "Offline", null),
                visible = true,
                showCloseButton = false,
                onClose = {},
                onDragActiveChange = {},
                onNewSession = {},
                onSelectAgent = {},
                onSelectSession = {},
                onSelectCatalogSession = {},
                onCreateCatalogSession = {},
                onSelectDestination = {},
              )
            }
          }
        }
      }
      val header = composeRule.onNodeWithText(nativeString("Recent")).performScrollTo()

      fun capture(name: String) {
        File(evidence, "$name.png").outputStream().use {
          check(
            composeRule
              .onRoot()
              .captureToImage()
              .asAndroidBitmap()
              .compress(Bitmap.CompressFormat.PNG, 100, it),
          )
        }
        File(evidence, "$name-semantics.txt").writeText(composeRule.onRoot().printToString())
      }
      capture("sidebar-collapsed")
      val collapsedState = header.fetchSemanticsNode().config.getOrElse(SemanticsProperties.StateDescription) { "" }
      header.assertHasClickAction().performClick()
      composeRule.onNodeWithText(nativeString("No recent sessions")).performScrollTo().assertIsDisplayed()
      capture("sidebar-expanded")
      val expandedState = header.fetchSemanticsNode().config.getOrElse(SemanticsProperties.StateDescription) { "" }
      header.performScrollTo().performClick()
      composeRule.onNodeWithText(nativeString("No recent sessions")).assertDoesNotExist()
      assertEquals(nativeString("Collapsed"), collapsedState)
      assertEquals(nativeString("Expanded"), expandedState)
    } finally {
      composeRule.runOnIdle { mounted.value = false }
      models.clear()
      try {
        closeNodeRuntimeTestFixture(runtime)
      } finally {
        bindNodeRuntimeTestFixture(app, previousRuntime)
        Settings.Global.putString(app.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, previousScale)
        NativeStringResources.setApplicationLocales(LocaleListCompat.getEmptyLocaleList())
      }
    }
  }

  @Test
  fun headerAnnouncesLocalizedStateWithoutStealingAttentionClick() {
    NativeStringResources.install(RuntimeEnvironment.getApplication())
    NativeStringResources.setApplicationLocales(LocaleListCompat.forLanguageTags("fr"))
    val expanded = mutableStateOf(false)
    var toggleCount = 0
    val attention =
      SidebarAttention(
        requests = listOf(SidebarAttentionRequest(SidebarAttentionKind.Question, "question", "agent:main:test", "Choose a test device", 1, 1L)),
        gatewayStableId = "synthetic-gateway",
      )
    try {
      composeRule.setContent {
        ClawDesignTheme {
          Column(Modifier.width(280.dp).verticalScroll(rememberScrollState())) {
            SidebarCollapsibleHeader(
              label = nativeString("Recent"),
              expanded = expanded.value,
              palette = sidebarPalette(ClawTheme.colors),
              attention = if (expanded.value) null else attention,
              onClick = {
                toggleCount++
                expanded.value = !expanded.value
              },
            )
          }
        }
      }
      val header = composeRule.onNodeWithText(nativeString("Recent"))
      val collapsed = nativeString("Collapsed")
      val open = nativeString("Expanded")
      assertEquals("Réduit", collapsed)
      assertEquals("Développé", open)
      header.assertHasClickAction().assert(SemanticsMatcher.expectValue(SemanticsProperties.StateDescription, collapsed))
      val attentionControl = composeRule.onNodeWithContentDescription(attention.label).assertHasClickAction()
      val touchBounds = attentionControl.fetchSemanticsNode().touchBoundsInRoot
      assertTrue("Compact attention target retains 48dp width", touchBounds.width >= 48f)
      assertTrue("Compact attention target retains 48dp height", touchBounds.height >= 48f)
      attentionControl.performClick()
      composeRule.onNodeWithText(attention.first.preview).assertIsDisplayed()
      composeRule.runOnIdle {
        assertFalse("Attention disclosure must not expand the group", expanded.value)
        assertEquals(0, toggleCount)
      }
      composeRule.onNodeWithContentDescription(attention.label).performClick()
      header.performClick().assert(SemanticsMatcher.expectValue(SemanticsProperties.StateDescription, open))
      header.performClick().assert(SemanticsMatcher.expectValue(SemanticsProperties.StateDescription, collapsed))
      composeRule.runOnIdle { assertEquals(2, toggleCount) }
    } finally {
      NativeStringResources.setApplicationLocales(LocaleListCompat.getEmptyLocaleList())
    }
  }
}
