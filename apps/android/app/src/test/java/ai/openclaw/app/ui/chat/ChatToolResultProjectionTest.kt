package ai.openclaw.app.ui.chat

import ai.openclaw.app.chat.ChatMessage
import ai.openclaw.app.chat.ChatMessageContent
import ai.openclaw.app.chat.ChatMessageProvenance
import ai.openclaw.app.chat.ChatToolActivity
import ai.openclaw.app.chat.ChatTranscriptMarker
import org.junit.Assert.assertEquals
import org.junit.Test

class ChatToolResultProjectionTest {
  private fun activity(
    id: String,
    type: String,
    tool: ChatToolActivity,
  ) = ChatMessage(id, if (type == "toolCall") "assistant" else "toolresult", listOf(ChatMessageContent(type = type, toolActivity = tool)), 1)

  private fun text(
    id: String,
    role: String = "assistant",
  ) = ChatMessage(id, role, listOf(ChatMessageContent(type = "text", text = id)), 1)

  private fun timeline(messages: List<ChatMessage>) = buildChatTimeline(messages, 0, emptyList(), null)

  @Test
  fun resultAcrossCommentaryUpdatesOriginalInvocationWithoutGenericRow() {
    val call = ChatToolActivity("call-1", "bash", "command: pwd", null, false)
    val result = ChatToolActivity("call-1", "tool", null, "/workspace", false)
    val built = timeline(listOf(activity("call", "toolCall", call), text("commentary"), activity("result", "toolResult", result), text("final")))
    assertEquals(listOf("message:final", "message:commentary", "completed-tools:call"), built.items.map(::chatTimelineItemKey))
    assertEquals(
      listOf(call.copy(result = "/workspace")),
      built.items
        .filterIsInstance<ChatTimelineItem.CompletedTools>()
        .single()
        .tools,
    )
  }

  @Test
  fun suppressesOnlyEmptyUnnamedOrphansAndKeepsRealOutputAndErrors() {
    val empty = ChatToolActivity("orphan", "tool", null, null, false)
    val built =
      timeline(
        listOf(
          activity("empty", "toolResult", empty),
          activity("output", "toolResult", empty.copy(toolCallId = "output", result = "useful output")),
          activity("error", "toolResult", empty.copy(toolCallId = "error", isError = true)),
          activity("named", "toolCall", empty.copy(toolCallId = "named", name = "read")),
        ),
      )
    assertEquals(
      listOf("output", "error", "named"),
      built.items
        .filterIsInstance<ChatTimelineItem.CompletedTools>()
        .flatMap { it.tools }
        .map { it.toolCallId },
    )
    assertEquals(emptyList<ChatTimelineItem>(), timeline(listOf(activity("empty", "toolResult", empty))).items)
  }

  @Test
  fun consecutiveCallResultPairsRemainOneGroup() {
    val first = ChatToolActivity("call-1", "bash", "command: pwd", null, false)
    val second = first.copy(toolCallId = "call-2", detail = "command: ls")
    val groups =
      timeline(
        listOf(
          activity("call-1", "toolCall", first),
          activity("result-1", "toolResult", first.copy(name = "tool", detail = null, result = "/workspace")),
          activity("call-2", "toolCall", second),
          activity("result-2", "toolResult", second.copy(name = "tool", detail = null, result = "file.txt")),
        ),
      ).items.filterIsInstance<ChatTimelineItem.CompletedTools>()
    assertEquals(1, groups.size)
    assertEquals(listOf(first.copy(result = "/workspace"), second.copy(result = "file.txt")), groups.single().tools)
  }

  @Test
  fun transcriptMarkerPreventsMatchingStaleCallIds() {
    val call = ChatToolActivity("call-1", "bash", "command: pwd", null, false)
    val output = ChatToolActivity("call-1", "tool", null, "after boundary", false)
    for (kind in listOf("compaction", "reset")) {
      val marker = ChatMessage("boundary", "system", emptyList(), 2, transcriptMarker = ChatTranscriptMarker(kind = kind))
      val groups =
        timeline(listOf(activity("call", "toolCall", call), marker, activity("result", "toolResult", output)))
          .items
          .filterIsInstance<ChatTimelineItem.CompletedTools>()
      assertEquals(listOf(output, call), groups.flatMap { it.tools })
    }
  }

  @Test
  fun steeringMessagePreservesInvocationResultOwnership() {
    val call = ChatToolActivity("call-1", "bash", "command: pwd", null, false)
    val output = ChatToolActivity("call-1", "tool", null, "completed output", false)
    val groups =
      timeline(
        listOf(
          text("initial", "user").copy(runId = "run-1"),
          activity("call", "toolCall", call),
          text("steering", "user").copy(steerTargetRunId = "run-1"),
          activity("result", "toolResult", output),
        ),
      ).items.filterIsInstance<ChatTimelineItem.CompletedTools>()
    assertEquals(listOf(call.copy(result = "completed output")), groups.flatMap { it.tools })
  }

  @Test
  fun hiddenBoundariesFenceToolGroupsAndReusedCallIds() {
    val call = ChatToolActivity("call-1", "bash", "command: pwd", null, false)
    val output = ChatToolActivity("call-1", "tool", null, "new turn output", false)
    val oldCall = activity("call", "toolCall", call)
    val result = activity("result", "toolResult", output)
    val emptyBoundary = activity("boundary", "toolResult", ChatToolActivity("empty", "tool", null, null, false)).copy(turnBoundary = true)
    for (history in listOf(
      listOf(oldCall, result.copy(turnBoundary = true)),
      listOf(oldCall, emptyBoundary, result),
    )) {
      val groups = timeline(history).items.filterIsInstance<ChatTimelineItem.CompletedTools>()
      assertEquals(2, groups.size)
      assertEquals(listOf(output, call), groups.flatMap { it.tools })
      assertEquals(listOf(true, false), groups.map { it.turnBoundary })
    }
  }

  @Test
  fun forwardedUserInputFencesPreviousTurnToolCallIds() {
    val call = ChatToolActivity("call-1", "bash", "command: pwd", null, false)
    val output = ChatToolActivity("call-1", "tool", null, "new turn output", false)
    val report =
      text("forwarded").copy(
        provenance = ChatMessageProvenance(kind = "inter_session", sourceTool = "sessions_send"),
      )
    for (forwarded in listOf(report, report.copy(content = emptyList()))) {
      val history = listOf(activity("call", "toolCall", call), text("previous-final"), forwarded, activity("result", "toolResult", output), text("new-final"))
      val built = timeline(history)
      val groups = built.items.filterIsInstance<ChatTimelineItem.CompletedTools>()
      assertEquals(2, groups.size)
      assertEquals(listOf(output, call), groups.flatMap { it.tools })
      assertEquals(forwarded.content.isNotEmpty(), built.items.filterIsInstance<ChatTimelineItem.Message>().any { it.message.id == "forwarded" })
      val collapsed = built.withCompletedWorkGroups(history, false, emptySet(), "agent:main:dashboard:test")
      assertEquals(
        listOf("new-final", "previous-final"),
        collapsed.items
          .filterIsInstance<ChatTimelineItem.Message>()
          .map { it.message.id }
          .filterNot { it == "forwarded" },
      )
    }
  }

  @Test
  fun doesNotAttachReusedCallIdsAcrossUserTurns() {
    val call = ChatToolActivity("call-1", "bash", "command: pwd", null, false)
    val output = ChatToolActivity("call-1", "tool", null, "new turn output", false)
    val groups =
      timeline(listOf(activity("call", "toolCall", call), text("next-turn", "user"), activity("result", "toolResult", output)))
        .items
        .filterIsInstance<ChatTimelineItem.CompletedTools>()
    assertEquals(listOf(output, call), groups.flatMap { it.tools })
  }
}
