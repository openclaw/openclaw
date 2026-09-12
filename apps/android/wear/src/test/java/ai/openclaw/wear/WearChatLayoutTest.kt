package ai.openclaw.wear

import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollToIndex
import androidx.compose.ui.test.performScrollToNode
import androidx.compose.ui.test.performSemanticsAction
import androidx.compose.ui.text.TextLayoutResult
import androidx.compose.ui.unit.Density
import androidx.wear.compose.material3.AppScaffold
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

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class WearChatLayoutTest {
  @get:Rule
  val compose = createComposeRule()

  private val theme = mutableStateOf(WearThemeMode.Dark)
  private val fontScale = mutableStateOf(1f)
  private val interaction = mutableStateOf(WearInteractionState.READY)
  private val speaking = mutableStateOf(false)

  @Test
  @Config(qualifiers = "en-rUS-w192dp-h192dp-round-mdpi")
  fun smallEnglishRound() = assertChatLayout()

  @Test
  @Config(qualifiers = "en-rUS-w227dp-h227dp-round-mdpi")
  fun largerEnglishRound() = assertChatLayout()

  @Test
  @Config(qualifiers = "de-rDE-w192dp-h192dp-round-mdpi")
  fun smallGermanRound() = assertChatLayout()

  @Test
  @Config(qualifiers = "de-rDE-w227dp-h227dp-round-mdpi")
  fun largerGermanRound() = assertChatLayout()

  @Test
  @Config(qualifiers = "de-rDE-w192dp-h192dp-round-mdpi")
  fun streamingDisclosureErrorsAndOfflineStatusRemainAvailableWithLargeText() {
    val resources = RuntimeEnvironment.getApplication().resources
    theme.value = WearThemeMode.Light
    fontScale.value = 1.3f
    val body = (1..12).joinToString("\n") { "Antwort $it" }
    render(
      WearConversationSnapshot(
        gatewayState = WearGatewayState.DISCONNECTED,
        phoneNodeId = "fixture-phone",
        activeSessionId = "fixture-session",
        streamingAssistantText = body,
        failure = WearConversationFailure.ACTION_REJECTED,
      ),
    )
    list().performScrollToIndex(1)
    assertFalse(layout(resources.getString(R.string.gateway_offline)).hasVisualOverflow)
    compose.runOnIdle { speaking.value = true }
    assertFalse(layout(resources.getString(R.string.speaking)).hasVisualOverflow)
    scrollTo(body)
    assertTrue(layout(body).hasVisualOverflow)
    val heading = resources.getString(R.string.agent_working).uppercase(resources.configuration.locales[0])
    assertFalse(layout(heading).hasVisualOverflow)
    assertEquals(wearColorsFor(WearThemeMode.Light).warning, layout(heading).layoutInput.style.color)
    scrollTo(resources.getString(R.string.show_more))
    compose.onNodeWithText(resources.getString(R.string.show_more)).performClick()
    scrollTo(body)
    assertFalse(layout(body).hasVisualOverflow)
    assertEquals(body, layout(body).layoutInput.text.text)
    scrollTo(resources.getString(R.string.show_less))
    compose.onNodeWithText(resources.getString(R.string.show_less)).performClick()
    scrollTo(body)
    assertTrue(layout(body).hasVisualOverflow)
    val error = resources.getString(R.string.try_again)
    scrollTo(error)
    assertFalse(layout(error).hasVisualOverflow)
    assertEquals(wearColorsFor(WearThemeMode.Light).danger, layout(error).layoutInput.style.color)
  }

  @Test
  @Config(qualifiers = "en-rUS-w227dp-h227dp-round-mdpi")
  fun controlsKeepTheirOriginalHeaderPresentation() {
    val resources = RuntimeEnvironment.getApplication().resources
    render(WearConversationSnapshot(gatewayState = WearGatewayState.CONNECTED), WearHomePage.Controls)
    list().performScrollToIndex(0)
    val brand = layout(resources.getString(R.string.app_name).uppercase(resources.configuration.locales[0]))
    val page = layout(resources.getString(R.string.controls).uppercase(resources.configuration.locales[0]))
    assertEquals(16f, brand.layoutInput.style.fontSize.value, 0f)
    assertEquals(10f, page.layoutInput.style.fontSize.value, 0f)
    assertFalse(brand.hasVisualOverflow)
    assertFalse(page.hasVisualOverflow)
  }

  private fun assertChatLayout() {
    val resources = RuntimeEnvironment.getApplication().resources
    val german = resources.configuration.locales[0].language == "de"
    val body = if (german) "Die Antwort bleibt auf der Uhr gut lesbar. Alle Nachrichten bleiben erhalten." else "The reply stays readable on the watch. All conversation messages remain available."
    val userBody = if (german) "Bitte kurz antworten." else "Please keep it brief."
    val systemBody = if (german) "Sitzung bereit." else "Session ready."
    val snapshot =
      WearConversationSnapshot(
        gatewayState = WearGatewayState.CONNECTED,
        phoneNodeId = "fixture-phone",
        activeSessionId = "agent:fixture:chat",
        sessions = listOf(WearSessionSummary("agent:fixture:chat", "Current", null, true)),
        messages =
          listOf(
            WearChatMessage(id = "assistant", role = "assistant", text = body, timestamp = 1),
            WearChatMessage(id = "user", role = "user", text = userBody, timestamp = 2),
            WearChatMessage(id = "system", role = "system", text = systemBody, timestamp = 3),
          ),
      )
    val brandText = resources.getString(R.string.app_name).uppercase(resources.configuration.locales[0])
    val brandOverflow = mutableListOf<String>()
    val bodyOverflow = mutableListOf<String>()
    val roundErrors = mutableListOf<String>()
    assertTrue(resources.configuration.isScreenRound)
    render(snapshot)
    for (mode in WearThemeMode.entries) {
      for (scale in listOf(1f, 1.3f)) {
        compose.runOnIdle {
          theme.value = mode
          fontScale.value = scale
          interaction.value = WearInteractionState.READY
        }
        list().performScrollToIndex(0)
        val brand = layout(brandText)
        val page = layout("CHAT")
        val status = layout(resources.getString(R.string.ready))
        if (brand.hasVisualOverflow) brandOverflow += "$mode/$scale"
        assertFalse("Page remains complete", page.hasVisualOverflow)
        assertFalse("Status remains complete", status.hasVisualOverflow)
        val brandNode = compose.onNodeWithText(brandText).fetchSemanticsNode()
        val pageNode = compose.onNodeWithText("CHAT").fetchSemanticsNode()
        val statusNode = compose.onNodeWithText(resources.getString(R.string.ready)).fetchSemanticsNode()
        assertTrue("Header tiers must not overlap", brandNode.boundsInRoot.bottom <= pageNode.boundsInRoot.top)
        assertTrue("Status follows the header", pageNode.boundsInRoot.bottom <= statusNode.boundsInRoot.top)
        val headerHeight = pageNode.boundsInRoot.bottom - brandNode.boundsInRoot.top
        val statusBottom = statusNode.boundsInRoot.bottom
        // Keep the production TimeText arc above the compact header and leave room to read.
        assertTrue("Header leaves the top clock band clear", brandNode.boundsInRoot.top >= resources.configuration.screenHeightDp * 0.1f)
        assertTrue("Compact header stays within a quarter of the viewport", headerHeight <= resources.configuration.screenHeightDp * 0.25f)
        assertTrue("Header and status leave the lower half for messages", statusBottom <= resources.configuration.screenHeightDp * 0.5f)
        roundErrors += roundTextErrors(brandText)
        roundErrors += roundTextErrors("CHAT")
        roundErrors += roundTextErrors(resources.getString(R.string.ready))
        scrollTo(body)
        val message = layout(body)
        assertEquals(body, message.layoutInput.text.text)
        if (message.hasVisualOverflow) bodyOverflow += "$mode/$scale"
        assertEquals(13f, message.layoutInput.style.fontSize.value, 0f)
        assertEquals(17f, message.layoutInput.style.lineHeight.value, 0f)
        assertTrue("Body has positive measured area", message.size.width > 0 && message.size.height > 0)
        val agent = layout(resources.getString(R.string.agent).uppercase(resources.configuration.locales[0]))
        assertFalse("Speaker role remains complete", agent.hasVisualOverflow)
        assertTrue("Body remains the reading tier", message.layoutInput.style.fontSize > agent.layoutInput.style.fontSize)
        val bodyWidth = message.layoutInput.constraints.maxWidth
        for ((text, role) in listOf(userBody to R.string.you, systemBody to R.string.system)) {
          list().performScrollToIndex(if (role == R.string.you) 3 else 4)
          roundErrors += roundTextErrors(text)
          assertFalse("Other roles retain full text", layout(text).hasVisualOverflow)
          assertFalse("Other role labels stay readable", layout(resources.getString(role).uppercase(resources.configuration.locales[0])).hasVisualOverflow)
          assertEquals("All roles receive equal reading width", bodyWidth, layout(text).layoutInput.constraints.maxWidth)
        }
        for (state in WearInteractionState.entries) {
          compose.runOnIdle { interaction.value = state }
          list().performScrollToIndex(1)
          val label =
            resources.getString(
              when (state) {
                WearInteractionState.READY -> R.string.ready
                WearInteractionState.LISTENING -> R.string.listening
                WearInteractionState.TYPING -> R.string.typing
                WearInteractionState.SENDING -> R.string.sending
                WearInteractionState.AGENT_WORKING -> R.string.agent_working
                WearInteractionState.ERROR -> R.string.error
              },
            )
          assertFalse("Every status remains readable: $label", layout(label).hasVisualOverflow)
        }
        val viewport = compose.onRoot().fetchSemanticsNode().size
        assertEquals(resources.configuration.screenWidthDp, viewport.width)
        assertEquals(viewport.width, viewport.height)
        println("CHAT_LAYOUT locale=${resources.configuration.locales[0].language} width=${resources.configuration.screenWidthDp} theme=$mode scale=$scale bodyWidth=$bodyWidth bodyLines=${message.lineCount} bodyHeight=${message.size.height} headerHeight=$headerHeight statusBottom=$statusBottom bodyOverflow=${message.hasVisualOverflow} roleHeight=${agent.size.height} brandOverflow=${brand.hasVisualOverflow}")
      }
    }
    assertTrue("Received sample fits without ellipsis: $bodyOverflow", bodyOverflow.isEmpty())
    assertTrue("Text must stay inside the round reading viewport: $roundErrors", roundErrors.isEmpty())
    assertTrue("Brand remains complete in every configuration: $brandOverflow", brandOverflow.isEmpty())
  }

  private fun roundTextErrors(text: String): List<String> {
    val node = compose.onNodeWithText(text, useUnmergedTree = true).fetchSemanticsNode()
    val result = layout(text)
    val viewport = compose.onRoot().fetchSemanticsNode().size
    val radius = viewport.width / 2f
    return text.indices.filter { !text[it].isWhitespace() }.mapNotNull { index ->
      val box = result.getBoundingBox(index).translate(node.positionInRoot)
      val inside =
        listOf(box.topLeft, box.topRight, box.bottomLeft, box.bottomRight).all {
          val x = it.x - radius
          val y = it.y - viewport.height / 2f
          x * x + y * y <= radius * radius
        }
      if (inside) null else "$text[$index]: $box"
    }
  }

  private fun list() = compose.onAllNodes(SemanticsMatcher.keyIsDefined(SemanticsProperties.VerticalScrollAxisRange)).let { it[it.fetchSemanticsNodes().lastIndex] }

  private fun scrollTo(text: String) {
    list().performScrollToNode(hasText(text))
  }

  private fun layout(text: String): TextLayoutResult {
    val results = mutableListOf<TextLayoutResult>()
    compose.onNodeWithText(text, useUnmergedTree = true).performSemanticsAction(SemanticsActions.GetTextLayoutResult) {
      assertTrue(it(results))
    }
    return results.single()
  }

  private fun render(
    snapshot: WearConversationSnapshot,
    page: WearHomePage = WearHomePage.Chat,
  ) {
    compose.setContent {
      CompositionLocalProvider(LocalDensity provides Density(LocalDensity.current.density, fontScale.value)) {
        OpenClawWearTheme(themeMode = theme.value) {
          AppScaffold {
            OpenClawWearScreens(
              snapshot = snapshot,
              failure = null,
              loading = false,
              interaction = interaction.value,
              speaking = speaking.value,
              realtimeCapturing = false,
              realtimePlaying = false,
              realtimeMouthLevel = 0f,
              realtimePlaybackFailed = false,
              realtimeThinkingOverride = false,
              actionBusy = false,
              inputEnabled = true,
              canAbort = false,
              themeMode = theme.value,
              autoSpeak = false,
              notificationsGranted = true,
              voiceSwipeHintEnabled = false,
              initialPage = page,
              onTalk = {},
              onType = {},
              onRealtimeTalk = {},
              onAbort = {},
              onSelectAgent = {},
              onSelectSession = {},
              onSelectModel = {},
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
  }
}
