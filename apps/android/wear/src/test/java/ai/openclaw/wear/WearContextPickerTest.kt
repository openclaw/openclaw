package ai.openclaw.wear

import android.app.Application
import android.graphics.Bitmap
import android.provider.Settings
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.assert
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.assertIsNotSelected
import androidx.compose.ui.test.assertIsSelected
import androidx.compose.ui.test.captureToImage
import androidx.compose.ui.test.hasAnyAncestor
import androidx.compose.ui.test.hasScrollToIndexAction
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.v2.createEmptyComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollToNode
import androidx.compose.ui.test.performSemanticsAction
import androidx.compose.ui.text.TextLayoutResult
import androidx.wear.compose.material3.AppScaffold
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.android.controller.ActivityController
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import java.io.File

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "en-rUS-w227dp-h227dp-round-xhdpi", application = Application::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class WearContextPickerTest {
  @get:Rule val compose = createEmptyComposeRule()
  private var controller: ActivityController<ComponentActivity>? = null
  private var snapshot by mutableStateOf(fixture())
  private var busy by mutableStateOf(false)
  private val choices = mutableListOf<String>()
  private var previousScale = 1f

  @Before
  fun disableUnrelatedAnimations() {
    val resolver = RuntimeEnvironment.getApplication().contentResolver
    previousScale = Settings.Global.getFloat(resolver, Settings.Global.ANIMATOR_DURATION_SCALE, 1f)
    Settings.Global.putFloat(resolver, Settings.Global.ANIMATOR_DURATION_SCALE, 0f)
  }

  @After
  fun restoreAnimations() {
    try {
      controller?.pause()?.stop()?.destroy()
    } finally {
      Settings.Global.putFloat(RuntimeEnvironment.getApplication().contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, previousScale)
      RuntimeEnvironment.setFontScale(1f)
    }
  }

  @Test
  fun agentChoicesExposeSelectionAndBusyOptionsCannotSelect() {
    show()
    openContext()
    reveal("AGENT").assert(button).assert(noSelection).performClick()
    reveal("Research assistant").assertIsSelected().assert(radio)
    reveal("Travel assistant").assertIsNotSelected().assert(radio)
    compose.runOnIdle { busy = true }
    reveal("Travel assistant").assertIsNotEnabled().performClick()
    assertEquals(emptyList<String>(), choices)
    compose.runOnIdle { busy = false }
    reveal("Travel assistant").performClick()
    assertEquals(listOf("agent:travel"), choices)
  }

  @Test
  fun modelSearchChoicesExposeSelectionAndPreserveRouting() {
    show()
    openContext()
    reveal("MODEL").assert(button).assert(noSelection).performClick()
    reveal("Search models").assert(button).assert(noSelection).performClick()
    reveal("Long reasoning model").assertIsSelected().assert(radio)
    reveal("Search-only model").assertIsNotSelected().assert(radio)
    compose.runOnIdle { busy = true }
    reveal("Search-only model").assertIsNotEnabled().performClick()
    assertEquals(emptyList<String>(), choices)
    compose.runOnIdle { busy = false }
    reveal("Search-only model").performClick()
    assertEquals(listOf("model:example/search-only"), choices)
    assertEquals(null, snapshot.modelSearchQuery)
  }

  @Test
  fun sessionSearchKeepsWatchSelectionDistinctFromPhoneAndSummaryIsNavigation() {
    show()
    openContext()
    reveal("Search sessions").performClick()
    reveal("Watch research session").assertIsSelected().assert(radio)
    compose.onNodeWithText("Open on watch", substring = true).assertExists()
    reveal("Phone session").assertIsNotSelected().assert(radio)
    compose.onNodeWithText("Active on phone", substring = true).assertExists()
    compose.runOnIdle { busy = true }
    reveal("Phone session").assertIsNotEnabled().performClick()
    assertEquals(emptyList<String>(), choices)
    compose.runOnIdle { busy = false }
    reveal("Search-only session").performClick()
    assertEquals(listOf("session:search-only"), choices)
    reveal("Session: Search-only session").assert(button).assert(noSelection)
    assertEquals(null, snapshot.sessionSearchQuery)
  }

  @Test
  fun unavailableControlsAndBusySummaryStayDisabled() {
    snapshot = snapshot.copy(agentControlsSupported = false, modelControlsSupported = false)
    show()
    openContext()
    reveal("AGENT").assertIsNotEnabled().performClick()
    reveal("MODEL").assertIsNotEnabled().performClick()
    reveal("Close").performClick()
    compose.runOnIdle { busy = true }
    reveal("Session: Watch research session")
      .assertIsNotEnabled()
      .assert(button)
      .assert(noSelection)
      .performClick()
    assertEquals(emptyList<String>(), choices)
  }

  @Test
  fun captureTypicalDarkContext() = captureContext(WearThemeMode.Dark)

  @Test
  @Config(qualifiers = "en-rUS-w192dp-h192dp-round-xhdpi")
  fun captureCompactLightContext() = captureContext(WearThemeMode.Light)

  @Test
  @Config(qualifiers = "en-rUS-w192dp-h192dp-round-xhdpi")
  fun captureCompactLargeTextContext() {
    RuntimeEnvironment.setFontScale(1.3f)
    captureContext(WearThemeMode.Dark)
  }

  private fun captureContext(theme: WearThemeMode) {
    show(theme)
    reveal("Session: Watch research session").assertIsDisplayed()
    assertMetadata("Agent: Research assistant")
    assertMetadata("Model: Long reasoning model")
    capture("summary-" + theme)
    openContext()
    reveal("Watch research session").assertIsDisplayed()
    assertMetadata("Open on watch")
    capture("session-" + theme)
    reveal("MODEL").performClick()
    reveal("Long reasoning model").assertIsDisplayed()
    assertMetadata("example/long-reasoning-model-reference")
    capture("model-" + theme)
  }

  private fun assertMetadata(text: String) {
    val layouts = mutableListOf<TextLayoutResult>()
    compose.onNodeWithText(text, useUnmergedTree = true).performSemanticsAction(SemanticsActions.GetTextLayoutResult) { it(layouts) }
    val layout = layouts.single()
    assertTrue("Metadata must be readable", layout.layoutInput.style.fontSize.value >= 11f)
    assertFalse("Metadata must not clip its final visible line: " + text, layout.getLineBottom(layout.lineCount - 1) > layout.size.height)
    assertTrue("Metadata must fit its card", layout.lineCount <= 2)
  }

  private fun openContext() {
    reveal("Session: Watch research session").assert(button).assert(noSelection).performClick()
  }

  private fun reveal(text: String): androidx.compose.ui.test.SemanticsNodeInteraction {
    compose.onAllNodes(hasScrollToIndexAction()).let { lists ->
      lists[lists.fetchSemanticsNodes().lastIndex].performScrollToNode(hasText(text))
    }
    return compose.onNodeWithText(text)
  }

  private fun capture(name: String) {
    val output = System.getenv("WEAR_CONTEXT_PROOF_DIR") ?: return
    val config = RuntimeEnvironment.getApplication().resources.configuration
    val file = File(output, name + "-" + config.screenWidthDp + "-" + config.fontScale + ".png")
    checkNotNull(file.parentFile).mkdirs()
    file.outputStream().use {
      check(
        compose
          .onRoot()
          .captureToImage()
          .asAndroidBitmap()
          .compress(Bitmap.CompressFormat.PNG, 100, it),
      )
    }
  }

  private fun show(theme: WearThemeMode = WearThemeMode.Dark) {
    val activity = Robolectric.buildActivity(ComponentActivity::class.java).setup().visible()
    controller = activity
    activity.get().setContent {
      OpenClawWearTheme(theme) {
        AppScaffold {
          OpenClawWearScreens(
            snapshot = snapshot,
            failure = null,
            loading = false,
            interaction = WearInteractionState.READY,
            speaking = false,
            realtimeCapturing = false,
            realtimePlaying = false,
            realtimeMouthLevel = 0f,
            realtimePlaybackFailed = false,
            realtimeThinkingOverride = false,
            actionBusy = busy,
            inputEnabled = true,
            canAbort = false,
            themeMode = theme,
            autoSpeak = false,
            notificationsGranted = true,
            voiceSwipeHintEnabled = false,
            onTalk = {},
            onType = {},
            onRealtimeTalk = {},
            onAbort = {},
            onSelectAgent = { choices += "agent:" + it },
            onSelectSession = { id ->
              choices += "session:" + id
              val selected = snapshot.sessionSearchResults.single { it.id == id }
              val state =
                WearUiState(
                  phoneNodeId = "fixture-phone",
                  selectedSession = WearSession(selected.id, selected.title, null, false, "fixture-phone"),
                )
              val projection = checkNotNull(state.toConversationSnapshot())
              snapshot = snapshot.copy(activeSessionId = projection.activeSessionId, activeSessionTitle = projection.activeSessionTitle)
            },
            onSelectModel = { choices += "model:" + it },
            onSearchSessions = {
              snapshot = snapshot.copy(sessionSearchQuery = "session", sessionSearchResults = snapshot.sessions + WearSessionSummary("search-only", "Search-only session"))
            },
            onSearchModels = {
              snapshot = snapshot.copy(modelSearchQuery = "model", modelSearchResults = listOf(snapshot.models.first(), WearModelSummary("example/search-only", "Search-only model", false)))
            },
            onClearSessionSearch = { snapshot = snapshot.copy(sessionSearchQuery = null, sessionSearchResults = emptyList()) },
            onClearModelSearch = { snapshot = snapshot.copy(modelSearchQuery = null, modelSearchResults = emptyList()) },
            onRefresh = {},
            onGatewayEnabledChange = {},
            onThemeModeChange = {},
            onAutoSpeakChange = {},
            onRequestNotifications = {},
            onOpenNotificationSettings = {},
            onSpeakLatest = {},
            onStopSpeaking = {},
          )
        }
      }
    }
  }

  private companion object {
    val radio =
      SemanticsMatcher.expectValue(SemanticsProperties.Role, Role.RadioButton) and
        hasAnyAncestor(SemanticsMatcher.keyIsDefined(SemanticsProperties.SelectableGroup))
    val button = SemanticsMatcher.expectValue(SemanticsProperties.Role, Role.Button)
    val noSelection = SemanticsMatcher.keyNotDefined(SemanticsProperties.Selected)

    fun fixture() =
      WearConversationSnapshot(
        gatewayState = WearGatewayState.CONNECTED,
        activeSessionId = "watch",
        activeSessionTitle = "Watch research session",
        agents = listOf(WearAgentSummary("research-assistant", "Research assistant", null, true), WearAgentSummary("travel", "Travel assistant", null, false)),
        sessions = listOf(WearSessionSummary("watch", "Watch research session", openOnWatch = true), WearSessionSummary("phone", "Phone session", activeOnPhone = true)),
        models = listOf(WearModelSummary("example/long-reasoning-model-reference", "Long reasoning model", true), WearModelSummary("example/fast", "Fast model", false)),
        agentControlsSupported = true,
        modelControlsSupported = true,
        sessionModelCatalogSupported = true,
        sessionSearchSupported = true,
        modelSearchSupported = true,
      )
  }
}
