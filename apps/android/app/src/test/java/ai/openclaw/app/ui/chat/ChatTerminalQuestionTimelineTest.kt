package ai.openclaw.app.ui.chat

import ai.openclaw.app.chat.ChatMessage
import ai.openclaw.app.chat.ChatMessageContent
import ai.openclaw.app.chat.ChatQuestionPrompt
import ai.openclaw.app.chat.ChatToolActivity
import ai.openclaw.app.chat.ChatTranscriptMarker
import ai.openclaw.app.gateway.QuestionRecord
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class ChatTerminalQuestionTimelineTest {
  @Test
  fun terminalSummariesLeaveTheDockAcrossResetAndHistoryRefresh() {
    val messages =
      listOf(
        text("old", "user", 100),
        ChatMessage("reset", "system", emptyList(), 300, transcriptMarker = ChatTranscriptMarker("reset", "reset")),
        text("new", "user", 400),
        text("reply", "assistant", 500),
      )
    val terminalPrompts =
      listOf(
        prompt("terminal", "answered"),
        prompt("terminal", "answered").copy(answeredLocally = true),
        prompt("terminal", "expired"),
        prompt("terminal", "cancelled"),
        prompt("terminal", "pending").copy(recoveryUnavailable = true),
        prompt("terminal", "pending").let { it.copy(record = it.record.copy(expiresAtMs = 0)) },
      )
    for (terminal in terminalPrompts) {
      val pending = prompt("pending", "pending")
      for (live in listOf(pending, pending.copy(submitting = true))) {
        val timeline =
          prepareChatHistory(messages, "agent:main:main", "agent:main:main")
            .buildTimeline(0, emptyList(), null, questions = listOf(terminal, live))
        assertEquals(listOf("question:pending", "message:reply", "message:new", "divider:reset:reset", "question:terminal", "message:old"), timeline.items.map(::chatTimelineItemKey))
        assertEquals(
          terminal,
          timeline.items
            .filterIsInstance<ChatTimelineItem.QuestionPrompt>()
            .last()
            .prompt,
        )
      }
    }
  }

  @Test
  fun terminalSummaryUsesToolResultTimeWithWorkFoldedOrExpanded() {
    val tool = ChatToolActivity("read", "read", null, null, false)
    val messages =
      listOf(
        text("user", "user", 100),
        ChatMessage("call", "assistant", listOf(ChatMessageContent(type = "toolCall", toolActivity = tool)), 150),
        ChatMessage("result", "toolresult", listOf(ChatMessageContent(type = "toolResult", toolActivity = tool.copy(result = "done"))), 160),
        text("reply", "assistant", 300),
      )
    for (session in listOf("agent:main:main", "agent:main:telegram:direct:proof")) {
      val history = prepareChatHistory(messages, session, "agent:main:main")
      for (expanded in listOf(emptySet(), setOf("reply"))) {
        for (createdAt in listOf(155L, 200L)) {
          val question = prompt("terminal", "answered").let { it.copy(record = it.record.copy(createdAtMs = createdAt)) }
          val items = history.buildTimeline(0, emptyList(), null, questions = listOf(question), expandedWorkKeys = expanded).items
          val questionIndex = items.indexOfFirst { it is ChatTimelineItem.QuestionPrompt }
          val toolIndex = items.indexOfFirst { it is ChatTimelineItem.ToolActivity || it is ChatTimelineItem.WorkedSummary }
          assertEquals("message:reply", chatTimelineItemKey(items.first()))
          assertTrue(if (createdAt < 160) questionIndex > toolIndex else questionIndex < toolIndex)
          assertEquals("message:user", chatTimelineItemKey(items.last()))
          assertEquals(1, items.filterIsInstance<ChatTimelineItem.QuestionPrompt>().size)
        }
      }
    }
  }

  @Test
  fun mergedToolDisclosureUsesItsLaterContributingResultTime() {
    val first = ChatToolActivity("first", "read", null, null, false)
    val second = first.copy(toolCallId = "second")
    val messages =
      listOf(
        text("user", "user", 100),
        ChatMessage("first-call", "assistant", listOf(ChatMessageContent(type = "toolCall", toolActivity = first)), 150),
        ChatMessage("first-result", "toolresult", listOf(ChatMessageContent(type = "toolResult", toolActivity = first.copy(result = "done"))), 160),
        text("commentary", "assistant", 170).copy(phase = "commentary"),
        ChatMessage("second-call", "assistant", listOf(ChatMessageContent(type = "toolCall", toolActivity = second)), 175),
        ChatMessage("second-result", "toolresult", listOf(ChatMessageContent(type = "toolResult", toolActivity = second.copy(result = "done"))), 250),
        text("reply", "assistant", 300),
      )
    val items =
      prepareChatHistory(messages, "agent:main:telegram:direct:proof", "agent:main:main")
        .buildTimeline(0, emptyList(), null, questions = listOf(prompt("terminal", "answered")))
        .items
    assertEquals(
      listOf("message:reply", "tools", "question:terminal", "message:commentary", "message:user"),
      items.map { if (it is ChatTimelineItem.ToolActivity) "tools" else chatTimelineItemKey(it) },
    )
  }

  private fun text(
    id: String,
    role: String,
    time: Long,
  ) = ChatMessage(id, role, listOf(ChatMessageContent(type = "text", text = id)), time)

  private fun prompt(
    id: String,
    status: String,
  ) = ChatQuestionPrompt(
    QuestionRecord(id = id, questions = emptyList(), agentId = "main", sessionKey = "agent:main:main", createdAtMs = 200, expiresAtMs = Long.MAX_VALUE, status = status),
  )
}
