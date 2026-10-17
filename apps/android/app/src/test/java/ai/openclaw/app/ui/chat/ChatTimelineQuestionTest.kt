package ai.openclaw.app.ui.chat

import ai.openclaw.app.chat.ChatMessage
import ai.openclaw.app.chat.ChatMessageContent
import ai.openclaw.app.chat.ChatQuestionPrompt
import ai.openclaw.app.chat.ChatQuestionStatus
import ai.openclaw.app.chat.ChatToolActivity
import ai.openclaw.app.gateway.QuestionRecord
import org.junit.Assert.assertEquals
import org.junit.Test

class ChatTimelineQuestionTest {
  private fun buildChatTimeline(
    messages: List<ChatMessage>,
    pendingRunCount: Int,
    pendingToolCalls: List<ai.openclaw.app.chat.ChatPendingToolCall>,
    stream: String?,
    questions: List<ChatQuestionPrompt>,
  ) = prepareChatHistory(messages, "agent:main:telegram:direct:question-test", "agent:main:main", questions.filter { it.status() !in setOf(ChatQuestionStatus.Pending, ChatQuestionStatus.Submitting) })
    .buildTimeline(pendingRunCount, pendingToolCalls, stream, questions = questions)

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
  fun completedQuestionFollowsOlderToolRow() {
    fun tool(
      id: String,
      time: Long,
    ) = ChatMessage(id, "toolresult", listOf(ChatMessageContent(type = "toolResult", toolActivity = ChatToolActivity(id, "read", null, "done", false))), time)
    val history = listOf(message("original", "user", 10), tool("older-tool", 30), message("reply", "assistant", 50))
    val timeline = buildChatTimeline(history, 0, emptyList(), null, questions = listOf(question("done", "answered", 40)))
    assertEquals(
      listOf("message:reply", "question:done", "tools:original", "message:original"),
      timeline.items.map(::chatTimelineItemKey),
    )
  }
}
