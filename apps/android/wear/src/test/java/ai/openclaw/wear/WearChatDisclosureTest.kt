package ai.openclaw.wear

import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.assert
import androidx.compose.ui.test.assertIsNotSelected
import androidx.compose.ui.test.assertIsSelected
import androidx.compose.ui.test.click
import androidx.compose.ui.test.hasClickAction
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollToIndex
import androidx.compose.ui.test.performScrollToNode
import androidx.compose.ui.test.performSemanticsAction
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.test.swipeDown
import androidx.compose.ui.text.TextLayoutResult
import androidx.wear.compose.material3.AppScaffold
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "en-rUS-w227dp-h227dp-mdpi")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class WearChatDisclosureTest {
  @get:Rule
  val compose = createComposeRule()

  private val snapshot = mutableStateOf(conversation(1))
  private val theme = mutableStateOf(WearThemeMode.Dark)
  private val autoSpeak = mutableStateOf(false)
  private val selectedSessions = mutableListOf<String>()
  private val selectedAgents = mutableListOf<String>()
  private val selectedModels = mutableListOf<String>()
  private var networkActions = 0

  @Test
  fun longReceivedTextExpandsAndCollapsesWithoutChangingBytes() {
    val body = (1..18).joinToString("\n") { "Line $it" }
    snapshot.value = conversation(1).copy(messages = listOf(message(1).copy(text = body)))
    render()
    scrollToText("Show more")
    assertTrue(layout(body).hasVisualOverflow)
    compose.onNodeWithText("Show more").performClick()
    scrollToText(body)
    assertEquals(body, layout(body).layoutInput.text.text)
    assertFalse(layout(body).hasVisualOverflow)
    assertTrue(layout(body).lineCount > 8)
    scrollToText("Show less")
    compose.onNodeWithText("Show less").performClick()
    scrollToText(body)
    assertTrue(layout(body).hasVisualOverflow)
    assertEquals(0, networkActions)
  }

  @Test
  fun shortMessagesDoNotOfferDisclosureAndEightMessagesAreAllLoaded() {
    snapshot.value = conversation(8)
    render()
    list().performScrollToIndex(0)
    compose.onNodeWithText("Show more").assertDoesNotExist()
    scrollToText("Message 1")
    assertFalse(layout("Message 1").hasVisualOverflow)
    scrollToText("Message 8")
    assertEquals(0, networkActions)
  }

  @Test
  fun twentyLoadedMessagesRevealLocallyAndKeepTheReadingAnchor() {
    snapshot.value = conversation(20)
    render()
    list().performScrollToIndex(2)
    scrollToText("Show more")
    val before =
      compose
        .onNodeWithText("Message 13")
        .fetchSemanticsNode()
        .boundsInRoot.top
    compose.onNodeWithText("Show more").performClick()
    val after =
      compose
        .onNodeWithText("Message 13")
        .fetchSemanticsNode()
        .boundsInRoot.top
    assertEquals(before, after, 1f)
    newAction().assertDoesNotExist()
    scrollToText("Message 1")
    scrollToText("Message 20")
    assertEquals(0, networkActions)
  }

  @Test
  @Config(qualifiers = "en-rUS-w227dp-h227dp-round-mdpi")
  fun loadedHistoryKeepsVisibleMessageWhenPriorMessageIsLong() = assertLoadedHistoryAnchor(8)

  @Test
  @Config(qualifiers = "en-rUS-w227dp-h227dp-round-mdpi")
  fun loadedHistoryKeepsVisibleMessageWhenPriorMessageIsShort() = assertLoadedHistoryAnchor(1)

  private fun assertLoadedHistoryAnchor(priorLines: Int) {
    val messages =
      conversation(20).messages.map {
        if (it.id == "message-12") it.copy(text = (1..priorLines).joinToString("\n") { line -> "Older line $line" }) else it
      }
    snapshot.value = conversation(20).copy(messages = messages)
    render()
    list().performScrollToIndex(2)
    scrollToText("Show more")
    val beforeNode = compose.onNodeWithText("Message 13").fetchSemanticsNode()
    val before = beforeNode.positionInRoot.y
    val root = compose.onRoot().fetchSemanticsNode().boundsInRoot
    assertTrue("The retained message is visible before disclosure", beforeNode.boundsInRoot.overlaps(root))
    val disclosure = compose.onNodeWithText("Show more").fetchSemanticsNode().boundsInRoot
    compose.onRoot().performTouchInput { click(disclosure.center) }
    compose.waitForIdle()
    val after =
      compose
        .onNodeWithText("Message 13")
        .fetchSemanticsNode()
        .positionInRoot.y
    println("HISTORY_ANCHOR priorLines=$priorLines before=$before after=$after")
    assertEquals("Disclosure must preserve the surviving message's viewport position", before, after, 1f)
    assertEquals(messages, snapshot.value.messages)
    assertEquals(20, snapshot.value.messages.size)
    newAction().assertDoesNotExist()
    scrollToText("Message 1")
    scrollToText("Message 20")
    assertEquals(0, networkActions)
  }

  @Test
  fun manualReadingKeepsPositionWhileIncomingContentOffersNewThenResumesFollowing() {
    snapshot.value = conversation(8)
    render()
    // Real backward gesture, not ScrollToIndex (which intentionally is not user scroll).
    repeat(3) { list().performTouchInput { swipeDown() } }
    val before =
      compose
        .onNodeWithText("Message 1")
        .fetchSemanticsNode()
        .boundsInRoot.top
    compose.runOnIdle { snapshot.value = snapshot.value.copy(streamingAssistantText = "Incoming") }
    val after =
      compose
        .onNodeWithText("Message 1")
        .fetchSemanticsNode()
        .boundsInRoot.top
    assertEquals(before, after, 1f)
    newAction().performClick()
    compose.waitForIdle()
    newAction().assertDoesNotExist()
    compose.runOnIdle { snapshot.value = snapshot.value.copy(streamingAssistantText = "Incoming complete") }
    compose.onNodeWithText("Incoming complete").assertExists()
    newAction().assertDoesNotExist()
  }

  @Test
  fun sessionAndPhoneChangesResetDisclosureEvenWithIdenticalMessageIds() {
    val body = (1..18).joinToString("\n") { "Line $it" }
    snapshot.value = conversation(20).copy(messages = conversation(20).messages.dropLast(1) + message(20).copy(text = body))
    render()
    // The latest message's disclosure, not the history disclosure.
    scrollToText(body)
    scrollToText("Show more")
    compose.onNodeWithText("Show more").performClick()
    scrollToText(body)
    assertFalse(layout(body).hasVisualOverflow)
    compose.runOnIdle { snapshot.value = snapshot.value.copy(activeSessionId = "agent:alpha:other") }
    scrollToText(body)
    assertTrue(layout(body).hasVisualOverflow)
    list().performScrollToIndex(2)
    compose.onNodeWithText("Show more").performClick()
    scrollToText("Message 1")
    compose.runOnIdle { snapshot.value = snapshot.value.copy(phoneNodeId = "phone-b") }
    list().performScrollToIndex(2)
    compose.onNodeWithText("Show more").assertExists()
    compose.onNodeWithText("Message 1").assertDoesNotExist()
  }

  @Test
  fun sessionSelectionExposesWatchOwnerAndInvokesRealCallback() {
    render()
    scrollToText("Session: Current")
    compose
      .onNode(hasText("Session: Current") and hasClickAction())
      .assert(SemanticsMatcher.expectValue(SemanticsProperties.Role, Role.Button))
      .assert(SemanticsMatcher.keyNotDefined(SemanticsProperties.Selected))
      .performClick()
    scrollToText("Current")
    compose
      .onNode(hasText("Current") and hasClickAction())
      .assert(SemanticsMatcher.expectValue(SemanticsProperties.Role, Role.RadioButton))
      .assertIsSelected()
    scrollToText("Other")
    compose.onNode(hasText("Other") and hasClickAction()).assertIsNotSelected().performClick()
    assertEquals(listOf("agent:alpha:other"), selectedSessions)
  }

  @Test
  fun modelAndAgentSelectionExposeSelectedStateAndCallbacks() {
    render()
    openContext()
    scrollToText("Model A")
    compose.onNode(hasText("Model A") and hasClickAction()).performClick()
    scrollToText("Model A")
    compose.onNode(hasText("Model A") and hasClickAction()).assertIsSelected()
    scrollToText("Model B")
    compose.onNode(hasText("Model B") and hasClickAction()).assertIsNotSelected().performClick()
    assertEquals(listOf("model-b"), selectedModels)
    openContext()
    scrollToText("Alpha")
    compose.onNode(hasText("Alpha") and hasClickAction()).performClick()
    scrollToText("Alpha")
    compose.onNode(hasText("Alpha") and hasClickAction()).assertIsSelected()
    scrollToText("Beta")
    compose.onNode(hasText("Beta") and hasClickAction()).assertIsNotSelected().performClick()
    assertEquals(listOf("beta"), selectedAgents)
  }

  @Test
  fun controlsExposeSelectedStateAndProductionPreferenceCallbacks() {
    render(WearHomePage.Controls)
    scrollToText("Gateway")
    compose.onNode(hasText("Gateway") and hasClickAction()).assertIsSelected()
    scrollToText("Dark")
    compose.onNodeWithText("Dark").assertIsSelected()
    compose.onNodeWithText("Light").assertIsNotSelected().performClick()
    compose.onNodeWithText("Light").assertIsSelected()
    scrollToText("Speak replies automatically")
    compose.onNode(hasText("Speak replies automatically") and hasClickAction()).assertIsNotSelected().performClick()
    compose.onNode(hasText("Speak replies automatically") and hasClickAction()).assertIsSelected()
  }

  private fun newAction() =
    compose.onNode(
      SemanticsMatcher("Show new messages click label") {
        SemanticsActions.OnClick in it.config && it.config[SemanticsActions.OnClick].label == "Show new messages"
      },
    )

  private fun openContext() {
    scrollToText("Session: Current")
    compose.onNode(hasText("Session: Current") and hasClickAction()).performClick()
  }

  private fun list() = compose.onAllNodes(SemanticsMatcher.keyIsDefined(SemanticsProperties.VerticalScrollAxisRange)).let { it[it.fetchSemanticsNodes().lastIndex] }

  private fun scrollToText(text: String) {
    list().performScrollToNode(hasText(text))
  }

  private fun layout(text: String): TextLayoutResult {
    val results = mutableListOf<TextLayoutResult>()
    compose.onNodeWithText(text, useUnmergedTree = true).performSemanticsAction(SemanticsActions.GetTextLayoutResult) {
      assertTrue(it(results))
    }
    return results.single()
  }

  private fun render(page: WearHomePage = WearHomePage.Chat) {
    compose.setContent {
      OpenClawWearTheme(themeMode = theme.value) {
        AppScaffold {
          OpenClawWearScreens(
            snapshot = snapshot.value,
            failure = null,
            loading = false,
            interaction = WearInteractionState.READY,
            speaking = false,
            realtimeCapturing = false,
            realtimePlaying = false,
            realtimeMouthLevel = 0f,
            realtimePlaybackFailed = false,
            realtimeThinkingOverride = false,
            actionBusy = false,
            inputEnabled = true,
            canAbort = false,
            themeMode = theme.value,
            autoSpeak = autoSpeak.value,
            notificationsGranted = true,
            initialPage = page,
            voiceSwipeHintEnabled = false,
            onTalk = { networkActions++ },
            onType = { networkActions++ },
            onRealtimeTalk = { networkActions++ },
            onAbort = { networkActions++ },
            onSelectAgent = selectedAgents::add,
            onSelectSession = selectedSessions::add,
            onSelectModel = selectedModels::add,
            onRefresh = { networkActions++ },
            onGatewayEnabledChange = { networkActions++ },
            onThemeModeChange = { theme.value = it },
            onAutoSpeakChange = { autoSpeak.value = it },
            onRequestNotifications = {},
            onOpenNotificationSettings = {},
            onSpeakLatest = {},
            onStopSpeaking = {},
          )
        }
      }
    }
  }

  companion object {
    private fun message(number: Int) =
      WearChatMessage(
        id = "message-$number",
        role = "assistant",
        text = "Message $number",
        timestamp = number.toLong(),
      )

    private fun conversation(count: Int) =
      WearConversationSnapshot(
        gatewayState = WearGatewayState.CONNECTED,
        phoneNodeId = "phone-a",
        activeAgentId = "alpha",
        conversationAgentId = "alpha",
        activeSessionId = "agent:alpha:current",
        agentControlsSupported = true,
        modelControlsSupported = true,
        gatewayControlsSupported = true,
        agents = listOf(WearAgentSummary("alpha", "Alpha", null, true), WearAgentSummary("beta", "Beta", null, false)),
        models = listOf(WearModelSummary("model-a", "Model A", true), WearModelSummary("model-b", "Model B", false)),
        sessions =
          listOf(
            WearSessionSummary("agent:alpha:current", "Current", null, true, openOnWatch = true),
            WearSessionSummary("agent:alpha:other", "Other", null, false, activeOnPhone = true),
          ),
        messages = (1..count).map(::message),
      )
  }
}
