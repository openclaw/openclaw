package ai.openclaw.app.ui

import ai.openclaw.app.GatewayConnectionDisplay
import ai.openclaw.app.MainViewModel
import ai.openclaw.app.NodeApp
import ai.openclaw.app.NodeRuntime
import ai.openclaw.app.NodeRuntimeMode
import ai.openclaw.app.SecurePrefs
import ai.openclaw.app.SessionCatalog
import ai.openclaw.app.SessionCatalogEntry
import ai.openclaw.app.SessionCatalogHost
import ai.openclaw.app.SessionCatalogState
import ai.openclaw.app.bindNodeRuntimeTestFixture
import ai.openclaw.app.closeNodeRuntimeTestFixture
import ai.openclaw.app.i18n.NativeStringResources
import ai.openclaw.app.ui.design.ClawDesignTheme
import android.content.Context
import android.provider.Settings
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.assert
import androidx.compose.ui.test.assertHasClickAction
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.core.os.LocaleListCompat
import androidx.lifecycle.SavedStateHandle
import androidx.lifecycle.ViewModelStore
import kotlinx.coroutines.flow.MutableStateFlow
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import org.robolectric.util.ReflectionHelpers
import java.util.UUID

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w1000dp-h1000dp-mdpi")
class SidebarDisclosureStateTest {
  @get:Rule
  val composeRule = createComposeRule()

  private val models = ViewModelStore()
  private val mounted = mutableStateOf(true)
  private val destinations = mutableListOf<SidebarDestination>()
  private val selectedSessions = mutableListOf<SessionCatalogEntry>()
  private lateinit var app: NodeApp
  private lateinit var runtime: NodeRuntime
  private lateinit var model: MainViewModel
  private var previousRuntime: NodeRuntime? = null
  private var previousScale: String? = null

  @Before
  fun setUp() {
    app = RuntimeEnvironment.getApplication() as NodeApp
    previousRuntime = app.peekRuntime()
    previousScale = Settings.Global.getString(app.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE)
    Settings.Global.putFloat(app.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 0f)
    val storage = app.getSharedPreferences("sidebar-disclosure-${UUID.randomUUID()}", Context.MODE_PRIVATE)
    val prefs = SecurePrefs(app, securePrefsOverride = storage)
    prefs.setSidebarVisiblePages(listOf("home"))
    runtime = NodeRuntime(app, prefs, NodeRuntimeMode.ScreenshotFixture)
    bindNodeRuntimeTestFixture(app, runtime)
    model = MainViewModel(app, prefs, SavedStateHandle())
    models.put("sidebar", model)
    val runtimeRef = ReflectionHelpers.getField<MutableStateFlow<NodeRuntime?>>(model, "runtimeRef")
    runtimeRef.value = runtime
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
  fun pagesAnnounceExpansionWithoutHidingTheIndependentMenu() {
    showSidebar()
    assertDisclosure("Recent", "Collapsed")
    composeRule.onNodeWithText("Home").assertIsDisplayed()
    assertDisclosure("Pages", "Expanded")

    click("Pages")
    assertDisclosure("Pages", "Collapsed")
    composeRule.onNodeWithText("Home").assertDoesNotExist()
    composeRule.onNodeWithTag("sidebar-pages-menu").assertIsDisplayed()
    assertDisclosure("Recent", "Collapsed")

    click("Pages")
    assertDisclosure("Pages", "Expanded")
    click("Home")
    composeRule.runOnIdle { assertEquals(listOf(SidebarDestination.Home), destinations) }
  }

  @Test
  fun catalogHostAndWorkspaceAnnounceTheirIndependentExpansionStates() {
    val session =
      SessionCatalogEntry(
        catalogId = "codex",
        hostId = "fixture-host",
        threadId = "fixture-thread",
        name = "Fixture conversation",
        cwd = "/work/fixture-workspace",
        status = "idle",
        archived = false,
        sessionKey = "agent:main:fixture-thread",
        canContinue = true,
      )
    val host = SessionCatalogHost("fixture-host", "Fixture host", true, listOf(session))
    val catalog = SessionCatalog("codex", "Fixture catalog", listOf(host))
    val state = ReflectionHelpers.getField<MutableStateFlow<SessionCatalogState>>(runtime, "_sessionCatalogState")
    val available = ReflectionHelpers.getField<MutableStateFlow<Boolean>>(runtime, "_sessionCatalogAvailable")
    state.value = SessionCatalogState(agentId = "main", catalogs = listOf(catalog))
    available.value = true
    showSidebar()

    assertDisclosure("Fixture catalog", "Collapsed")
    composeRule.onNodeWithText("Fixture host").assertDoesNotExist()
    click("Fixture catalog")
    assertDisclosure("Fixture catalog", "Expanded")
    composeRule.onNodeWithText("Fixture conversation").assertIsDisplayed()
    assertDisclosure("Fixture host", "Expanded")
    assertDisclosure("fixture-workspace", "Expanded")

    click("fixture-workspace")
    assertDisclosure("fixture-workspace", "Collapsed")
    assertDisclosure("Fixture host", "Expanded")
    composeRule.onNodeWithText("Fixture conversation").assertDoesNotExist()

    click("Fixture host")
    assertDisclosure("Fixture host", "Collapsed")
    composeRule.onNodeWithText("fixture-workspace").assertDoesNotExist()
    assertDisclosure("Fixture catalog", "Expanded")

    click("Fixture host")
    assertDisclosure("Fixture host", "Expanded")
    assertDisclosure("fixture-workspace", "Collapsed")
    composeRule.onNodeWithText("Fixture conversation").assertDoesNotExist()

    click("fixture-workspace")
    assertDisclosure("fixture-workspace", "Expanded")
    click("Fixture conversation")
    composeRule.runOnIdle { assertEquals(listOf(session), selectedSessions) }
  }

  private fun assertDisclosure(
    label: String,
    expected: String,
  ) {
    val row = composeRule.onNodeWithText(label)
    row.performScrollTo()
    row.assertHasClickAction()
    row.assert(SemanticsMatcher.expectValue(SemanticsProperties.Role, Role.Button))
    row.assert(SemanticsMatcher.expectValue(SemanticsProperties.StateDescription, expected))
  }

  private fun click(label: String) {
    val row = composeRule.onNodeWithText(label)
    row.performScrollTo()
    row.performClick()
    composeRule.waitForIdle()
  }

  private fun showSidebar() {
    composeRule.setContent {
      if (mounted.value) {
        ClawDesignTheme {
          OpenClawSidebar(
            viewModel = model,
            agents = emptyList(),
            selectedAgentId = "main",
            sessions = emptyList(),
            activeSessionKey = "agent:main:other",
            activeDestination = null,
            connection = GatewayConnectionDisplay(false, "Offline", null),
            visible = true,
            showCloseButton = false,
            onClose = {},
            onDragActiveChange = {},
            onNewSession = {},
            onSelectAgent = {},
            onSelectSession = {},
            onSelectCatalogSession = { selectedSessions += it },
            onCreateCatalogSession = {},
            onSelectDestination = { destinations += it },
          )
        }
      }
    }
    composeRule.waitForIdle()
  }
}
