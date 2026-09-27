package ai.openclaw.app.ui

import ai.openclaw.app.GatewayConnectionDisplay
import ai.openclaw.app.MainViewModel
import ai.openclaw.app.NodeApp
import ai.openclaw.app.NodeRuntime
import ai.openclaw.app.NodeRuntimeMode
import ai.openclaw.app.SecurePrefs
import ai.openclaw.app.bindNodeRuntimeTestFixture
import ai.openclaw.app.closeNodeRuntimeTestFixture
import ai.openclaw.app.defaultSidebarPageOrder
import ai.openclaw.app.i18n.NativeStringResources
import ai.openclaw.app.ui.design.ClawDesignTheme
import android.content.Context
import android.graphics.Bitmap
import android.provider.Settings
import android.view.KeyEvent
import android.view.WindowManager
import android.view.inspector.WindowInspector
import androidx.activity.OnBackPressedDispatcher
import androidx.activity.compose.LocalOnBackPressedDispatcherOwner
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.input.InputMode
import androidx.compose.ui.input.InputModeManager
import androidx.compose.ui.platform.LocalInputModeManager
import androidx.compose.ui.semantics.CustomAccessibilityAction
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.assert
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsSelected
import androidx.compose.ui.test.captureToImage
import androidx.compose.ui.test.hasAnyAncestor
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.isPopup
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performSemanticsAction
import androidx.compose.ui.test.printToString
import androidx.core.os.LocaleListCompat
import androidx.lifecycle.SavedStateHandle
import androidx.lifecycle.ViewModelStore
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

/** Exercises actions on the production sidebar, including its ViewModel and persisted preferences. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [36], qualifiers = "en-rUS-w320dp-h800dp-mdpi")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class SidebarNavigationAccessibilityTest {
  @get:Rule val composeRule = createComposeRule()
  private val models = ViewModelStore()
  private val mounted = mutableStateOf(true)
  private val selections = mutableListOf<SidebarDestination>()
  private lateinit var app: NodeApp
  private lateinit var prefs: SecurePrefs
  private lateinit var runtime: NodeRuntime
  private lateinit var model: MainViewModel
  private var previousRuntime: NodeRuntime? = null
  private var previousScale: String? = null
  private var editing = false
  private lateinit var inputModeManager: InputModeManager
  private lateinit var backDispatcher: OnBackPressedDispatcher
  private val personalizedOrder = listOf("settings", "work", "home", "skills", "threads")

  @Before
  fun setUp() {
    app = RuntimeEnvironment.getApplication() as NodeApp
    app
      .getSharedPreferences("openclaw.node", Context.MODE_PRIVATE)
      .edit()
      .clear()
      .commit()
    prefs = newPrefs()
    prefs.setDisplayName("OpenClaw")
    previousRuntime = app.peekRuntime()
    runtime = NodeRuntime(app, prefs, NodeRuntimeMode.ScreenshotFixture)
    bindNodeRuntimeTestFixture(app, runtime)
    model = MainViewModel(app, prefs, SavedStateHandle()).also { models.put("sidebar", it) }
    previousScale = Settings.Global.getString(app.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE)
    Settings.Global.putFloat(app.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 0f)
    NativeStringResources.install(app)
    NativeStringResources.setApplicationLocales(LocaleListCompat.forLanguageTags("en"))
  }

  @After
  fun tearDown() {
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

  @Test
  fun visibleRowsSkipHiddenSlotsPersistMovesAndRetainNavigation() {
    prefs.setSidebarPageOrder(personalizedOrder)
    prefs.setSidebarVisiblePages(listOf("settings", "home", "threads"))
    showSidebar()
    capture("normal-sidebar")
    assertActions("Settings", "Move down")
    assertActions("Home", "Move up", "Move down")
    assertActions("Threads", "Move up")
    composeRule.onNodeWithText("Overview").assertDoesNotExist()
    composeRule.onNodeWithText("Skills").assertDoesNotExist()
    val home = composeRule.onNodeWithText("Home").assertIsSelected()
    // Keyboard focus is unavailable in touch mode; TalkBack node identity is checked separately.
    composeRule.runOnIdle { assertTrue(inputModeManager.requestInputMode(InputMode.Keyboard)) }
    home.performSemanticsAction(SemanticsActions.RequestFocus) { assertTrue(it()) }
    val homeId = home.fetchSemanticsNode().id
    invokeMove("Home", "Move up")
    assertPersisted(listOf("home", "work", "settings", "skills", "threads"), listOf("settings", "home", "threads"))
    assertActions("Home", "Move down")
    assertEquals(homeId, home.fetchSemanticsNode().id)
    home.assertIsSelected().assert(SemanticsMatcher.expectValue(SemanticsProperties.Focused, true))
    invokeMove("Home", "Move down")
    assertPersisted(personalizedOrder, listOf("settings", "home", "threads"))
    home.performClick()
    composeRule.runOnIdle { assertEquals(listOf(SidebarDestination.Home), selections) }
    capture("normal-sidebar-restored")
  }

  @Test
  fun editorMovesHiddenPagesInFullOrderWithoutTogglingPinsOrNavigating() {
    prefs.setSidebarPageOrder(personalizedOrder)
    prefs.setSidebarVisiblePages(listOf("home"))
    showSidebar()
    assertActions("Home")
    composeRule.onNodeWithTag("sidebar-pages-menu").performClick()
    composeRule.onNodeWithText("Edit pinned items").performScrollTo().performClick()
    editing = true
    capture("editor", popup = true)
    assertActions("Settings", "Move down")
    assertActions("Overview", "Move up", "Move down")
    assertActions("Threads", "Move up", "Move down")
    invokeMove("Overview", "Move up")
    assertPersisted(listOf("work", "settings", "home", "skills", "threads"), listOf("home"))
    assertActions("Overview", "Move down")
    row("Overview").assert(SemanticsMatcher.expectValue(SemanticsProperties.StateDescription, "Not pinned"))
    row("Overview").performClick()
    assertPersisted(listOf("work", "settings", "home", "skills", "threads"), listOf("work", "home"))
    row("Overview").assert(SemanticsMatcher.expectValue(SemanticsProperties.StateDescription, "Pinned"))
    row("Overview").performClick()
    row("Home").performClick()
    assertPersisted(listOf("work", "settings", "home", "skills", "threads"), listOf("home"))
    composeRule.runOnIdle { assertTrue(selections.isEmpty()) }
  }

  @Test
  fun retainedActionRechecksLatestOrderAndVisibilityBeforeReportingHandled() {
    prefs.setSidebarPageOrder(personalizedOrder)
    prefs.setSidebarVisiblePages(personalizedOrder)
    showSidebar()
    val moveUp = actions("Overview").single { it.label == "Move up" }
    composeRule.runOnIdle {
      assertTrue(moveUp.action())
      assertFalse("Already at the boundary; stale action must not report success", moveUp.action())
      model.setSidebarVisiblePages(listOf("home"))
      assertFalse("Hidden source has no visible move", moveUp.action())
    }
    assertPersisted(listOf("work", "settings", "home", "skills", "threads"), listOf("home"))
    assertActions("Home")
  }

  @Test
  fun defaultsResetAndOfflineSettingsUseTheExistingShellNavigation() {
    composeRule.setContent {
      if (mounted.value) {
        backDispatcher = requireNotNull(LocalOnBackPressedDispatcherOwner.current).onBackPressedDispatcher
        ShellScreen(model)
      }
    }
    composeRule.onNodeWithTag("sidebar-open-overview").assertIsDisplayed().performClick()
    capture("default-sidebar")
    assertDefaultRows()
    assertFalse(model.gatewayConnectionDisplay.value.isConnected)
    val settings = composeRule.onNodeWithContentDescription("Settings").assertIsDisplayed().assertIsEnabled()
    val gear = settings.fetchSemanticsNode()
    assertTrue("Settings touch target", gear.size.width >= 48 && gear.size.height >= 48)
    settings.performClick()
    composeRule.onNodeWithContentDescription("Search settings").assertIsDisplayed()
    capture("offline-settings")
    composeRule.runOnIdle { backDispatcher.onBackPressed() }
    composeRule.onNodeWithTag("sidebar-open-overview").assertIsDisplayed().performClick()
    sidebarRow("Threads").performClick()
    composeRule.onNodeWithContentDescription("Show Sidebar").performClick()
    composeRule.onNodeWithContentDescription("Settings").performClick()
    composeRule.onNodeWithContentDescription("Search settings").assertIsDisplayed()
    composeRule.runOnIdle { backDispatcher.onBackPressed() }
    composeRule.onNodeWithContentDescription("Show Sidebar").performClick()
    sidebarRow("Threads").assertIsSelected()
    composeRule.runOnIdle {
      model.setSidebarPageOrder(personalizedOrder)
      model.setSidebarVisiblePages(listOf("settings", "work", "home"))
    }
    assertPersisted(personalizedOrder, listOf("settings", "work", "home"))
    sidebarRow("Settings").assertIsDisplayed()
    composeRule.onNodeWithTag("sidebar-pages-menu").performClick()
    composeRule.onNodeWithText("Edit pinned items").performScrollTo().performClick()
    composeRule.onNodeWithText("Reset pinned items").performScrollTo().performClick()
    composeRule.runOnIdle {
      val popup =
        WindowInspector.getGlobalWindowViews().single {
          it.isAttachedToWindow && (it.layoutParams as? WindowManager.LayoutParams)?.type == WindowManager.LayoutParams.TYPE_APPLICATION_SUB_PANEL
        }
      assertTrue(popup.dispatchKeyEvent(KeyEvent(KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_ESCAPE)))
      assertTrue(popup.dispatchKeyEvent(KeyEvent(KeyEvent.ACTION_UP, KeyEvent.KEYCODE_ESCAPE)))
    }
    assertDefaultRows()
    assertPersisted(listOf("home", "threads", "skills", "work", "settings"), listOf("home", "threads", "skills", "work"))
    capture("reset-sidebar")
  }

  private fun sidebarRow(label: String) = composeRule.onNode(hasText(label) and hasAnyAncestor(hasTestTag("sidebar-drawer")))

  private fun assertDefaultRows() {
    val rows =
      listOf("Home", "Threads", "Skills", "Overview").map {
        sidebarRow(it)
          .assertIsDisplayed()
          .fetchSemanticsNode()
          .positionInRoot.y
      }
    assertTrue("Default pages are Home, Threads, Skills, Overview", rows.zipWithNext().all { (a, b) -> a < b })
    sidebarRow("Settings").assertDoesNotExist()
  }

  private fun newPrefs() = SecurePrefs(app, app.getSharedPreferences("sidebar-reorder-secure", Context.MODE_PRIVATE))

  private fun showSidebar() {
    composeRule.setContent {
      if (mounted.value) {
        inputModeManager = LocalInputModeManager.current
        ClawDesignTheme {
          OpenClawSidebar(
            viewModel = model,
            agents = emptyList(),
            selectedAgentId = "main",
            sessions = emptyList(),
            activeSessionKey = "agent:main:test",
            activeDestination = SidebarDestination.Home,
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
            onSelectDestination = { selections += it },
          )
        }
      }
    }
  }

  private fun row(label: String) = composeRule.onNode(if (editing) hasText(label) and hasAnyAncestor(isPopup()) else hasText(label))

  private fun actions(label: String): List<CustomAccessibilityAction> = row(label).fetchSemanticsNode().config.getOrElse(SemanticsActions.CustomActions) { emptyList() }

  private fun assertActions(
    label: String,
    vararg expected: String,
  ) {
    assertEquals("Available moves for $label", expected.toList(), actions(label).map { it.label })
  }

  private fun invokeMove(
    label: String,
    actionLabel: String,
  ) {
    val action = actions(label).single { it.label == actionLabel }
    composeRule.runOnIdle { assertTrue(action.action()) }
  }

  private fun assertPersisted(
    order: List<String>,
    visible: List<String>,
  ) {
    composeRule.runOnIdle {
      val reloaded = newPrefs()
      val expectedOrder = order + defaultSidebarPageOrder.filterNot(order::contains)
      assertEquals(expectedOrder, reloaded.sidebarPageOrder.value)
      assertEquals(visible, reloaded.sidebarVisiblePages.value)
      assertEquals(expectedOrder, model.sidebarPageOrder.value)
      assertEquals(visible, model.sidebarVisiblePages.value)
    }
  }

  private fun capture(
    name: String,
    popup: Boolean = false,
  ) {
    val outputPath = System.getenv("OPENCLAW_SIDEBAR_PROOF_DIR") ?: return
    val directory = File(outputPath).apply { mkdirs() }
    val root = if (popup) composeRule.onNode(isPopup()) else composeRule.onRoot()
    File(directory, "$name.png").outputStream().use {
      check(root.captureToImage().asAndroidBitmap().compress(Bitmap.CompressFormat.PNG, 100, it))
    }
    File(directory, "$name-semantics.txt").writeText(root.printToString())
  }
}
