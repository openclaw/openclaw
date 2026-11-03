package ai.openclaw.app.ui.chat

import ai.openclaw.app.chat.ChatHistoryPaging
import ai.openclaw.app.chat.ChatMessage
import ai.openclaw.app.chat.ChatMessageContent
import ai.openclaw.app.ui.design.ClawDesignTheme
import android.app.Application
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.Text
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.input.nestedscroll.nestedScroll
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.getUnclippedBoundsInRoot
import androidx.compose.ui.test.hasScrollToIndexAction
import androidx.compose.ui.test.junit4.StateRestorationTester
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performScrollToIndex
import androidx.compose.ui.unit.dp
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [36], qualifiers = "w360dp-h800dp-420dpi", application = Application::class)
class ChatHistoryReaderLayoutTest {
  @get:Rule
  val composeRule = createComposeRule()

  @Test
  fun snapshotOnlyAndCachedHistoryCannotClaimBeginningOfConversation() {
    var paging by mutableStateOf(ChatHistoryPaging())
    composeRule.setContent {
      ClawDesignTheme {
        ChatHistoryOlderBoundary(paging, enabled = true, showBoundary = true, onLoad = {})
      }
    }
    composeRule.onNodeWithText("Beginning of conversation").assertDoesNotExist()
    composeRule.onNodeWithText("Load older messages").assertDoesNotExist()
    composeRule.runOnIdle { paging = ChatHistoryPaging(olderComplete = true) }
    composeRule.onNodeWithText("Beginning of conversation").assertIsDisplayed()
    composeRule.runOnIdle { paging = ChatHistoryPaging(hasOlder = true) }
    composeRule.onNodeWithText("Beginning of conversation").assertDoesNotExist()
    composeRule.onNodeWithText("Load older messages").assertIsDisplayed()
    composeRule.runOnIdle { paging = ChatHistoryPaging() }
    composeRule.onNodeWithText("Beginning of conversation").assertDoesNotExist()
  }

  @Test
  fun pausedViewportSurvivesOlderPageRemotePromptAndRecreation() {
    var messages by mutableStateOf((1..30).map { row(it) })
    lateinit var reader: ChatReaderScrollController
    val restoration = StateRestorationTester(composeRule)
    restoration.setContent {
      ClawDesignTheme {
        val timeline = prepareChatHistory(messages, "session", "session").buildTimeline(0, emptyList(), null)
        reader = rememberChatReaderScrollController("gateway|agent|session", timeline, false)
        CompositionLocalProvider(LocalChatReaderNavigation provides reader.navigation) {
          LazyColumn(
            state = reader.listState,
            reverseLayout = true,
            modifier = Modifier.height(300.dp).nestedScroll(reader.nestedScrollConnection).onGloballyPositioned(reader.navigation.anchors::viewportPlaced),
          ) {
            items(timeline.items, key = ::chatTimelineItemKey) { item ->
              ChatReaderItem(chatTimelineItemKey(item)) {
                val anchor = rememberChatReaderAnchor()
                val message = (item as ChatTimelineItem.Message).message
                Text(message.content.single().text.orEmpty(), modifier = (anchor?.modifier ?: Modifier).height(60.dp), onTextLayout = anchor?.onTextLayout)
              }
            }
          }
        }
      }
    }
    composeRule.waitForIdle()
    composeRule.runOnIdle { reader.navigation.pause() }
    composeRule.onNode(hasScrollToIndexAction()).performScrollToIndex(10)
    composeRule.waitForIdle()
    val before = composeRule.onNodeWithText("Message 20").assertIsDisplayed().getUnclippedBoundsInRoot()
    composeRule.runOnIdle { messages = (0 downTo -10).reversed().map { row(it) } + messages + row(31, "user") }
    composeRule.waitForIdle()
    val updated = composeRule.onNodeWithText("Message 20").assertIsDisplayed().getUnclippedBoundsInRoot()
    assertEquals(before.top.value, updated.top.value, 1f)
    assertTrue(reader.showJumpToLatest)
    restoration.emulateSavedInstanceStateRestore()
    composeRule.waitForIdle()
    val restored = composeRule.onNodeWithText("Message 20").assertIsDisplayed().getUnclippedBoundsInRoot()
    assertEquals(updated.top.value, restored.top.value, 1f)
  }

  private fun row(index: Int, role: String = "assistant") = ChatMessage(
    id = "row-$index",
    entryId = "entry-$index",
    role = role,
    content = listOf(ChatMessageContent(text = "Message $index")),
    timestampMs = index.toLong(),
  )
}
