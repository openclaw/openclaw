package ai.openclaw.app.ui.chat

import ai.openclaw.app.chat.ChatMessage
import ai.openclaw.app.chat.ChatMessageContent
import ai.openclaw.app.chat.ChatPendingInput
import ai.openclaw.app.chat.ChatPendingInputsPage
import ai.openclaw.app.ui.design.ClawDesignTheme
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.hasClickAction
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w360dp-h800dp-420dpi")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class ChatGatewayQueueTest {
  @get:Rule val compose = createComposeRule()

  @Test
  fun queueIsReadOnlyOrderedAndDisclosesItsBoundedPage() {
    fun input(
      id: String,
      at: Long,
      state: String = "queued",
      visible: Boolean = true,
    ) = ChatPendingInput(
      id = id,
      runId = "run-$id",
      message = if (visible) ChatMessage(id, "user", listOf(ChatMessageContent(text = id)), at) else null,
      acceptedAtMs = at,
      state = state,
      queued = state == "queued",
    )
    val page =
      ChatPendingInputsPage(
        items = listOf(input("first", 20), input("second", 10), input("hidden", 30, "cancelled", false), input("interrupted", 40, "interrupted")),
        total = 30,
        queuedCount = 7,
        nextBefore = 21,
      )
    compose.setContent { ClawDesignTheme { ChatGatewayQueue(page) } }
    compose.onNodeWithTag("chat-gateway-queue").assertIsDisplayed()
    compose.onNodeWithText("Showing recent inputs only.").assertIsDisplayed()
    compose.onNodeWithText("Queued on Gateway: 7").assertIsDisplayed()
    val first = compose.onNodeWithText("first", substring = true).fetchSemanticsNode()
    val second = compose.onNodeWithText("second", substring = true).fetchSemanticsNode()
    assertTrue(first.boundsInRoot.top < second.boundsInRoot.top)
    compose.onNodeWithText("hidden", substring = true).assertDoesNotExist()
    compose.onNodeWithText("interrupted", substring = true).assertDoesNotExist()
    compose.onAllNodes(hasClickAction()).assertCountEquals(0)
  }
}
