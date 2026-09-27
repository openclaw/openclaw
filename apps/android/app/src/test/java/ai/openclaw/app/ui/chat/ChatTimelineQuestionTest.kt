package ai.openclaw.app.ui.chat

import ai.openclaw.app.chat.ChatMessage
import ai.openclaw.app.chat.ChatMessageContent
import ai.openclaw.app.chat.ChatQuestionPrompt
import ai.openclaw.app.chat.ChatToolActivity
import ai.openclaw.app.gateway.QuestionRecord
import org.junit.Assert.assertEquals
import org.junit.Test

class ChatTimelineQuestionTest {
  private fun message(
    id: String,
    role: String,
    time: Long,
  ) = ChatMessage(id, role, listOf(ChatMessageContent(type = "text", text = id)), time)

  private fun question(
    id: String,
    status: String,
    time: Long,
  ) = ChatQuestionPrompt(QuestionRecord(id, emptyList(), createdAtMs = time, expiresAtMs = Long.MAX_VALUE, status = status))

  @Test
  fun answeredCardStaysBetweenOriginalMessagesAfterFollowup() {
    val history = listOf(message("original", "user", 10), message("answer", "assistant", 30), message("followup", "user", 40), message("reply", "assistant", 50))
    val timeline = buildChatTimeline(history, 0, emptyList(), null, questions = listOf(question("done", "answered", 20)))
    assertEquals(listOf("message:reply", "message:followup", "message:answer", "question:done", "message:original"), timeline.items.map(::chatTimelineItemKey))
    assertEquals(1, timeline.readAnchorIndex)
  }

  @Test
  fun pendingCardRemainsReachableWhileTerminalCardsFollowTimeOrder() {
    val history = listOf(message("original", "user", 10), message("reply", "assistant", 50))
    val prompts = listOf(question("older", "cancelled", 20), question("pending", "pending", 15), question("newer", "expired", 30))
    val timeline = buildChatTimeline(history, 0, emptyList(), "stream", questions = prompts)
    assertEquals(listOf("question:pending", "stream", "message:reply", "question:newer", "question:older", "message:original"), timeline.items.map(::chatTimelineItemKey))
  }

  @Test
  fun completedQuestionSeparatesOlderAndNewerToolRows() {
    fun tool(
      id: String,
      time: Long,
    ) = ChatMessage(id, "toolresult", listOf(ChatMessageContent(type = "toolResult", toolActivity = ChatToolActivity(id, "read", null, "done", false))), time)
    val history = listOf(message("original", "user", 10), tool("older-tool", 30), tool("newer-tool", 45), message("reply", "assistant", 50))
    val timeline = buildChatTimeline(history, 0, emptyList(), null, questions = listOf(question("done", "answered", 40)))
    assertEquals(
      listOf("message:reply", "completed-tools:newer-tool", "question:done", "completed-tools:older-tool", "message:original"),
      timeline.items.map(::chatTimelineItemKey),
    )
  }
}
