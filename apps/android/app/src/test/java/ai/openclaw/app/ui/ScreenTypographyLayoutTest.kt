package ai.openclaw.app.ui

import ai.openclaw.app.AndroidScreenshotFixture
import ai.openclaw.app.AndroidScreenshotScene
import ai.openclaw.app.AppearanceTextScale
import ai.openclaw.app.AppearanceThemeMode
import ai.openclaw.app.HomeDestination
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
import ai.openclaw.app.ui.design.ClawTypography
import android.content.Context
import android.graphics.Bitmap
import android.provider.Settings
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.SemanticsNodeInteraction
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsSelected
import androidx.compose.ui.test.captureToImage
import androidx.compose.ui.test.getUnclippedBoundsInRoot
import androidx.compose.ui.test.hasAnyAncestor
import androidx.compose.ui.test.hasAnyDescendant
import androidx.compose.ui.test.hasContentDescription
import androidx.compose.ui.test.hasScrollAction
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performScrollToNode
import androidx.compose.ui.test.performSemanticsAction
import androidx.compose.ui.text.TextLayoutResult
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.sp
import androidx.core.os.LocaleListCompat
import androidx.lifecycle.SavedStateHandle
import androidx.lifecycle.ViewModelStore
import com.google.mlkit.common.sdkinternal.MlKitContext
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import java.io.File
import java.util.UUID

/** Measures text laid out by real screens, not source-token spelling or replacement widgets. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w360dp-h800dp-mdpi")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class ScreenTypographyLayoutTest {
  @get:Rule val composeRule = createComposeRule()
  private val store = ViewModelStore()
  private val mounted = mutableStateOf(true)
  private lateinit var app: NodeApp
  private lateinit var prefs: SecurePrefs
  private lateinit var runtime: NodeRuntime
  private lateinit var model: MainViewModel
  private lateinit var type: ClawTypography
  private var originalRuntime: NodeRuntime? = null
  private var animatorScale: String? = null

  @Before
  fun setUp() {
    app = RuntimeEnvironment.getApplication() as NodeApp
    originalRuntime = app.peekRuntime()
    prefs = SecurePrefs(app, app.getSharedPreferences("screen-type-" + UUID.randomUUID(), Context.MODE_PRIVATE))
    prefs.setOnboardingCompleted(true)
    AndroidScreenshotFixture.configure(AndroidScreenshotScene.Home)
    runtime = NodeRuntime(app, prefs, NodeRuntimeMode.ScreenshotFixture)
    bindNodeRuntimeTestFixture(app, runtime)
    model = MainViewModel(app, prefs, SavedStateHandle()).also { store.put("typography", it) }
    model.enterScreenshotFixtureMode(AndroidScreenshotScene.Home)
    animatorScale = Settings.Global.getString(app.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE)
    Settings.Global.putFloat(app.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 0f)
  }

  @After
  fun tearDown() {
    try {
      composeRule.runOnIdle { mounted.value = false }
    } finally {
      try {
        store.clear()
      } finally {
        bindNodeRuntimeTestFixture(app, originalRuntime)
        try {
          closeNodeRuntimeTestFixture(runtime)
        } finally {
          Settings.Global.putString(app.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, animatorScale)
          AndroidScreenshotFixture.configure(AndroidScreenshotScene.Home)
        }
      }
    }
  }

  @Test
  fun appearanceOffersWebTextSizeChoices() {
    show { SettingsDetailScreen(model, SettingsRoute.Appearance, onBack = {}) }
    composeRule.onNodeWithText("App language").performScrollTo()
    capture("appearance-text-size")
    composeRule.onNodeWithText("Text size").assertIsDisplayed()
    for (percent in listOf(90, 100, 110, 125, 140)) {
      composeRule.onNodeWithText("$percent%").performScrollTo().assertIsDisplayed()
    }
    composeRule.onNodeWithText("100%").assertIsSelected()
  }

  @Test
  fun appearanceInteractionUpdatesShellAndRestoresEveryChoice() {
    model.requestHomeDestination(HomeDestination.Settings)
    showApp { RootScreen(model) }
    composeRule.onNode(SemanticsMatcher.keyIsDefined(SemanticsActions.ScrollToIndex)).performScrollToNode(hasText("Appearance"))
    composeRule.onNodeWithText("Appearance").performClick()
    for (percent in listOf(90, 110, 125, 140, 100)) {
      composeRule
        .onNodeWithText("$percent%")
        .performScrollTo()
        .performClick()
        .assertIsSelected()
      assertEquals(percent, prefs.appearanceTextScale.value.percent)
      val restored = SecurePrefs(app, app.getSharedPreferences("text-size-restored", Context.MODE_PRIVATE))
      assertEquals(percent, restored.appearanceTextScale.value.percent)
    }
    composeRule.onNodeWithText("140%").performScrollTo().performClick()
    composeRule.onNodeWithText("App language").performScrollTo()
    composeRule.onNodeWithText("140%").assertIsDisplayed().assertIsSelected()
    capture("appearance-140")
    composeRule.onNode(SemanticsMatcher.keyIsDefined(SemanticsActions.ScrollToIndex)).performScrollToNode(hasContentDescription("Back"))
    composeRule.onNodeWithContentDescription("Back").performClick()
    composeRule.onNode(SemanticsMatcher.keyIsDefined(SemanticsActions.ScrollToIndex)).performScrollToNode(hasText("Settings"))
    val heading = assertTextStyle("Settings", type.display)
    assertEquals(1.4f, heading.layoutInput.density.fontScale, 0.001f)
    capture("settings-140")
    composeRule.runOnIdle { model.setAppearanceTextScale(AppearanceTextScale.Standard) }
    assertEquals(1f, assertTextStyle("Settings", type.display).layoutInput.density.fontScale, 0.001f)
    capture("settings-100")
  }

  @Test
  @Config(qualifiers = "w320dp-h800dp-mdpi")
  fun textSizeCombinesWithNonlinearSystemScalingOnNarrowScreens() {
    model.setAppearanceTextScale(AppearanceTextScale.Largest)
    showApp(fontScale = 2f) { SettingsDetailScreen(model, SettingsRoute.Appearance, onBack = {}) }
    val heading = assertTextStyle("Appearance", type.display)
    assertFalse("Large text must not clip the page title", heading.hasVisualOverflow)
    val density = heading.layoutInput.density
    assertEquals(2.8f, density.fontScale, 0.001f)
    assertEquals(1f, density.density, 0.001f)
    // Compose 1.12 intentionally extrapolates linearly above its largest (2x) table.
    // Match the platform conversion here rather than inventing a different accessibility curve.
    for (size in listOf(12.sp, 32.sp)) {
      assertEquals(with(Density(1f, 2.8f)) { size.toDp() }, with(density) { size.toDp() })
    }
    for (percent in listOf(90, 100, 110, 125, 140)) {
      val node = composeRule.onNodeWithText("$percent%", useUnmergedTree = true)
      node.performScrollTo().assertIsDisplayed()
      val layouts = mutableListOf<TextLayoutResult>()
      node.performSemanticsAction(SemanticsActions.GetTextLayoutResult) { assertTrue(it(layouts)) }
      if (percent == 90) capture("high-text-choices")
      val measured = layouts.single()
      val bounds = node.getUnclippedBoundsInRoot()
      // Semantics can report a wider paragraph box than the natural-width Text node.
      // Check the complete rendered line against its actual bounds, not that box.
      assertEquals("Text-size choice $percent% must stay on one line", 1, measured.lineCount)
      assertTrue("Text-size choice $percent% must fit horizontally", measured.getLineRight(0) <= (bounds.right - bounds.left).value * measured.layoutInput.density.density + 0.5f)
      assertTrue("Text-size choice $percent% must fit vertically", measured.getLineBottom(0) <= (bounds.bottom - bounds.top).value * measured.layoutInput.density.density + 0.5f)
    }
    capture("appearance-system-200-app-140")
    composeRule.onNodeWithText("100%").performScrollTo().performClick()
    composeRule.onNode(SemanticsMatcher.keyIsDefined(SemanticsActions.ScrollToIndex)).performScrollToNode(hasText("Appearance"))
    val restoredDensity = assertTextStyle("Appearance", type.display).layoutInput.density
    assertEquals(2f, restoredDensity.fontScale, 0.001f)
    assertTrue("Restoring 100% retains Android nonlinear scaling", with(restoredDensity) { 12.sp.toDp().value / 12 > 32.sp.toDp().value / 32 })
  }

  @Test
  fun appChoiceRetainsNonlinearConversionWithinPlatformRange() {
    model.setAppearanceTextScale(AppearanceTextScale.Small)
    showApp(fontScale = 2f) { SettingsDetailScreen(model, SettingsRoute.Appearance, onBack = {}) }
    val density = assertTextStyle("Appearance", type.display).layoutInput.density
    assertEquals(1.8f, density.fontScale, 0.001f)
    assertTrue("Combined platform scaling remains nonlinear", with(density) { 12.sp.toDp().value / 12 > 32.sp.toDp().value / 32 })
  }

  @Test
  fun textSizeReachesRealChatAndReturnsToUnchangedDefault() {
    model.enterScreenshotFixtureMode(AndroidScreenshotScene.Chat)
    showApp { RootScreen(model) }
    val message = "Summarize the open review feedback for me."
    composeRule.onNodeWithText(message, useUnmergedTree = true).performScrollTo().assertIsDisplayed()

    fun messageDensity(): Density {
      val layouts = mutableListOf<TextLayoutResult>()
      composeRule
        .onNodeWithText(message, useUnmergedTree = true)
        .performSemanticsAction(SemanticsActions.GetTextLayoutResult) { assertTrue(it(layouts)) }
      return layouts.single().layoutInput.density
    }
    assertEquals(1f, messageDensity().fontScale, 0.001f)
    capture("chat-100")
    composeRule.runOnIdle { model.setAppearanceTextScale(AppearanceTextScale.Largest) }
    composeRule.onNode(SemanticsMatcher.keyIsDefined(SemanticsActions.ScrollToIndex)).performScrollToNode(hasText(message))
    assertEquals(1.4f, messageDensity().fontScale, 0.001f)
    capture("chat-140")
    composeRule.runOnIdle { model.setAppearanceTextScale(AppearanceTextScale.Standard) }
    composeRule.onNode(SemanticsMatcher.keyIsDefined(SemanticsActions.ScrollToIndex)).performScrollToNode(hasText(message))
    assertEquals(1f, messageDensity().fontScale, 0.001f)
  }

  @Test
  fun textSizeReachesOnboardingWithoutResettingScreenshotPreferences() {
    model.setAppearanceTextScale(AppearanceTextScale.ExtraLarge)
    model.enterScreenshotFixtureMode(AndroidScreenshotScene.Home)
    assertEquals(AppearanceTextScale.ExtraLarge, model.appearanceTextScale.value)
    MlKitContext.initializeIfNeeded(app)
    showApp { OnboardingFlow(model) }
    val layouts = mutableListOf<TextLayoutResult>()
    composeRule
      .onNodeWithText("Welcome to OpenClaw", useUnmergedTree = true)
      .performSemanticsAction(SemanticsActions.GetTextLayoutResult) { assertTrue(it(layouts)) }
    assertEquals(
      1.25f,
      layouts
        .single()
        .layoutInput.density.fontScale,
      0.001f,
    )
    capture("onboarding-125")
  }

  @Test
  fun appTextSizeReachesNativePromptWindow() {
    model.setAppearanceTextScale(AppearanceTextScale.Largest)
    showApp {
      FoldAwarePrompt(
        onDismissRequest = {},
        title = "Native prompt scale",
        text = { androidx.compose.material3.Text("Prompt body") },
        actions = {},
      )
    }
    val layouts = mutableListOf<TextLayoutResult>()
    composeRule
      .onNodeWithText("Native prompt scale", useUnmergedTree = true)
      .performSemanticsAction(SemanticsActions.GetTextLayoutResult) { assertTrue(it(layouts)) }
    assertEquals(
      1.4f,
      layouts
        .single()
        .layoutInput.density.fontScale,
      0.001f,
    )
  }

  @Test
  fun appTextSizeReachesNativeMenuWindow() {
    model.setAppearanceTextScale(AppearanceTextScale.Largest)
    showApp {
      AppDropdownMenu(expanded = true, onDismissRequest = {}) {
        androidx.compose.material3.Text("Native menu scale")
      }
    }
    val layouts = mutableListOf<TextLayoutResult>()
    composeRule
      .onNodeWithText("Native menu scale", useUnmergedTree = true)
      .performSemanticsAction(SemanticsActions.GetTextLayoutResult) { assertTrue(it(layouts)) }
    assertEquals(
      1.4f,
      layouts
        .single()
        .layoutInput.density.fontScale,
      0.001f,
    )
  }

  @Test
  fun appTextSizeReachesTheNativeMessageReaderTitle() {
    model.setAppearanceTextScale(AppearanceTextScale.Largest)
    showApp {
      ai.openclaw.app.ui.chat
        .ChatTextReaderDialog("Reader body", "Native reader scale", "Done", {})
    }
    val layouts = mutableListOf<TextLayoutResult>()
    composeRule
      .onNodeWithText("Native reader scale", useUnmergedTree = true)
      .performSemanticsAction(SemanticsActions.GetTextLayoutResult) { assertTrue(it(layouts)) }
    assertEquals(
      1.4f,
      layouts
        .single()
        .layoutInput.density.fontScale,
      0.001f,
    )
  }

  @OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class)
  @Test
  fun appTextSizeReachesMaterialSheetWindow() {
    model.setAppearanceTextScale(AppearanceTextScale.Largest)
    showApp {
      AppModalBottomSheet(
        onDismissRequest = {},
        sheetState = androidx.compose.material3.rememberModalBottomSheetState(skipPartiallyExpanded = true),
        containerColor = ClawTheme.colors.surface,
        contentColor = ClawTheme.colors.text,
      ) {
        androidx.compose.material3.Text("Native sheet scale")
      }
    }
    val layouts = mutableListOf<TextLayoutResult>()
    composeRule
      .onNodeWithText("Native sheet scale", useUnmergedTree = true)
      .performSemanticsAction(SemanticsActions.GetTextLayoutResult) { assertTrue(it(layouts)) }
    assertEquals(
      1.4f,
      layouts
        .single()
        .layoutInput.density.fontScale,
      0.001f,
    )
  }

  @Test
  fun providerPageKeepsHeadingHierarchyAndPhoneGutters() {
    show { ProvidersModelsScreen(model, onBack = {}) }
    capture("providers-dark")
    assertTextStyle("Models", type.title)
    assertPhoneGutter()
    composeRule.onNode(hasScrollAction()).performScrollToNode(hasText("1 provider · 1 model"))
    assertTextStyle("1 provider · 1 model", type.caption)
    composeRule.onNodeWithText("OpenAI").performClick()
    composeRule.onNodeWithText("1 more model").performScrollTo().performClick()
    assertTextStyle("GPT-5.2", type.body, scroll = true)
  }

  @Test
  @Config(qualifiers = "w320dp-h800dp-mdpi")
  fun providerHeadingsAndDescriptionRemainReadableAtLargeFontScale() {
    show(fontScale = 2f) { ProvidersModelsScreen(model, onBack = {}) }
    capture("providers-large-dark")
    assertFalse("The page title must remain readable", assertTextStyle("Models", type.title).hasVisualOverflow)
    val section = assertTextStyle("Defaults for all agents", type.section)
    assertFalse("The full section name must remain readable: lines=${section.lineCount}, size=${section.size}, constraints=${section.layoutInput.constraints}, widthOverflow=${section.didOverflowWidth}, heightOverflow=${section.didOverflowHeight}", section.hasVisualOverflow)
    val description = "Model and behavior defaults for all agents. Agent-specific settings override these defaults."
    val descriptionLayout = assertTextStyle(description, type.caption)
    assertTrue("The long description must wrap instead of shrinking or clipping", descriptionLayout.lineCount > 1)
    assertFalse("The full description must remain readable", descriptionLayout.hasVisualOverflow)
    val titleBounds = composeRule.onNodeWithText("Defaults for all agents").getUnclippedBoundsInRoot()
    val subtitleBounds = composeRule.onNodeWithText(description).getUnclippedBoundsInRoot()
    assertTrue("The section heading must not overlap its description", titleBounds.bottom <= subtitleBounds.top)
  }

  @Test
  fun threadsKeepPageHierarchyAndReadableRowCaptions() {
    show { SessionsScreen(model, showSidebarButton = false, onOpenSidebar = {}, onOpenChat = {}) }
    capture("threads-dark")
    assertTextStyle("Threads", type.display)
    assertPhoneGutter()
    composeRule.onNodeWithText(AndroidScreenshotFixture.primarySessionTitle).performScrollTo().assertIsDisplayed()
    assertTextStyle(composeRule.onAllNodesWithText("OpenClaw thread", useUnmergedTree = true)[0], type.caption)
    composeRule.onNodeWithContentDescription("Toggle thread layout").performScrollTo().performClick()
    composeRule.onNodeWithText("Layout: Compact").assertIsDisplayed()
  }

  @Test
  fun settingsToProfileRetainsTheSamePageHeadingRole() {
    model.requestHomeDestination(HomeDestination.Settings)
    show { ShellScreen(model) }
    capture("settings-dark")
    assertTextStyle("Settings", type.display)
    assertTextStyle("OpenClaw mobile", type.caption)
    composeRule.onNodeWithContentDescription("Open profile").performClick()
    capture("profile-dark")
    assertTextStyle("Profile", type.display)
    composeRule.onNodeWithText("Save Profile").assertIsDisplayed()
    composeRule.onNodeWithContentDescription("Back").performClick()
    assertTextStyle("Settings", type.display)
  }

  @Test
  fun providerPageRetainsHeadingHierarchyInLightMode() {
    show(dark = false) { ProvidersModelsScreen(model, onBack = {}) }
    capture("providers-light")
    assertTextStyle("Models", type.title)
    assertPhoneGutter()
  }

  @Test
  fun threadsRetainHeadingHierarchyInLightMode() {
    show(dark = false) { SessionsScreen(model, showSidebarButton = false, onOpenSidebar = {}, onOpenChat = {}) }
    capture("threads-light")
    assertTextStyle("Threads", type.display)
  }

  @Test
  fun settingsRetainHeadingHierarchyInLightMode() {
    prefs.setAppearanceThemeMode(AppearanceThemeMode.Light)
    model.requestHomeDestination(HomeDestination.Settings)
    show(dark = false) { ShellScreen(model) }
    capture("settings-light")
    assertTextStyle("Settings", type.display)
  }

  @Test
  fun detailPageKeepsPageHeadingDistinctFromFormControls() {
    show { SettingsDetailScreen(model, SettingsRoute.Profile, onBack = {}) }
    capture("profile-detail-dark")
    assertTextStyle("Profile", type.display)
    assertTextStyle("How this phone appears to OpenClaw.", type.body)
    composeRule.onNodeWithText("Save Profile").assertIsDisplayed()
  }

  @Test
  @Config(qualifiers = "w320dp-h800dp-mdpi")
  fun localizedHealthHeadingWrapsWithoutClippingAtLargeFontScale() {
    NativeStringResources.install(app)
    try {
      NativeStringResources.setApplicationLocales(LocaleListCompat.forLanguageTags("fr"))
      val heading = nativeString("Health")
      assertEquals("État de santé", heading)
      show(fontScale = 2f) { SettingsDetailScreen(model, SettingsRoute.Health, onBack = {}) }
      capture("health-heading-large-dark")
      val title = assertTextStyle(heading, type.display)
      assertTrue("The localized page heading must wrap rather than truncate", title.lineCount > 1)
      assertFalse("The full localized page heading must remain readable", title.hasVisualOverflow)
      assertTrue("No heading line may be ellipsized", (0 until title.lineCount).none(title::isLineEllipsized))
    } finally {
      NativeStringResources.setApplicationLocales(LocaleListCompat.getEmptyLocaleList())
    }
    assertEquals("Locale cleanup must restore the following screens' language", "Health", nativeString("Health"))
  }

  private fun capture(name: String) {
    val directory = System.getenv("OPENCLAW_TYPOGRAPHY_PROOF_DIR") ?: return
    val target = File(directory, "$name.png")
    check(!target.exists()) { "Proof captures must not overwrite an earlier image" }
    requireNotNull(target.parentFile).mkdirs()
    val image = composeRule.onRoot().captureToImage().asAndroidBitmap()
    assertTrue("Capture must contain the full phone viewport", image.width in listOf(320, 360) && image.height > 600)
    target.outputStream().use { assertTrue(image.compress(Bitmap.CompressFormat.PNG, 100, it)) }
  }

  private fun showApp(
    fontScale: Float = 1f,
    content: @Composable () -> Unit,
  ) {
    composeRule.setContent {
      if (mounted.value) {
        val scale by model.appearanceTextScale.collectAsState()
        val density = LocalDensity.current
        CompositionLocalProvider(LocalDensity provides Density(density.density, fontScale)) {
          OpenClawTheme(textScale = scale) {
            ClawDesignTheme {
              type = ClawTheme.type
              content()
            }
          }
        }
      }
    }
    composeRule.waitForIdle()
  }

  private fun show(
    fontScale: Float = 1f,
    dark: Boolean = true,
    content: @Composable () -> Unit,
  ) {
    composeRule.setContent {
      if (mounted.value) {
        val density = LocalDensity.current
        CompositionLocalProvider(LocalDensity provides Density(density.density, fontScale)) {
          ClawDesignTheme(dark = dark) {
            type = ClawTheme.type
            content()
          }
        }
      }
    }
    composeRule.waitForIdle()
  }

  private fun assertPhoneGutter() {
    val bounds = composeRule.onNode(hasScrollAction()).getUnclippedBoundsInRoot()
    assertEquals("Phone content must have a 16dp leading gutter", 16f, bounds.left.value, 1f)
    assertEquals("Phone content must have a 16dp trailing gutter", 344f, bounds.right.value, 1f)
  }

  private fun assertTextStyle(
    text: String,
    expected: TextStyle,
    scroll: Boolean = false,
  ): TextLayoutResult {
    val node =
      if (text == "Settings") {
        // The closed sidebar retains its own Settings label; select the actual page scroll viewport.
        composeRule.onNode(
          hasText(text) and hasAnyAncestor(hasScrollAction() and hasAnyDescendant(hasTestTag("sidebar-open-settings"))),
          useUnmergedTree = true,
        )
      } else {
        composeRule.onNodeWithText(text, useUnmergedTree = true)
      }
    if (scroll) node.performScrollTo()
    return assertTextStyle(node, expected)
  }

  private fun assertTextStyle(
    node: SemanticsNodeInteraction,
    expected: TextStyle,
  ): TextLayoutResult {
    node.assertIsDisplayed()
    val layouts = mutableListOf<TextLayoutResult>()
    node.performSemanticsAction(SemanticsActions.GetTextLayoutResult) { assertTrue(it(layouts)) }
    val layout = layouts.single()
    val text = layout.layoutInput.text.text
    assertEquals(text, expected.fontSize, layout.layoutInput.style.fontSize)
    assertEquals(text, expected.lineHeight, layout.layoutInput.style.lineHeight)
    assertEquals(text, expected.fontWeight, layout.layoutInput.style.fontWeight)
    return layout
  }
}
