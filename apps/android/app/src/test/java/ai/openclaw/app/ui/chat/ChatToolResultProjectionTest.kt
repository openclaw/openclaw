package ai.openclaw.app.ui.chat

import ai.openclaw.app.chat.ChatMessage
import ai.openclaw.app.chat.ChatMessageContent
import ai.openclaw.app.chat.ChatMessageProvenance
import ai.openclaw.app.chat.ChatToolActivity
import ai.openclaw.app.chat.ChatTranscriptMarker
import org.junit.Assert.assertEquals
import org.junit.Assert.assertSame
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

  private fun timeline(messages: List<ChatMessage>) = prepareChatHistory(messages, "agent:main:telegram:direct:projection", "agent:main:main").buildTimeline(0, emptyList(), null)

  @Test
  fun resultAcrossCommentaryUpdatesOriginalInvocationWithoutGenericRow() {
    val call = ChatToolActivity("call-1", "bash", "command: pwd", null, false)
    val result = ChatToolActivity("call-1", "tool", null, "/workspace", false)
    val built = timeline(listOf(activity("call", "toolCall", call), text("commentary"), activity("result", "toolResult", result), text("final")))
    assertEquals(listOf("message:final", "message:commentary", "tools:root"), built.items.map(::chatTimelineItemKey))
    assertEquals(
      listOf(call.copy(result = "/workspace")),
      built.items
        .filterIsInstance<ChatTimelineItem.ToolActivity>()
        .single()
        .tools,
    )
  }

  @Test
  fun matchedFailuresOnlyCollapseWhenALaterAnswerExists() {
    val call = ChatToolActivity("call-1", "bash", "command: check draft", null, false)
    val failure = call.copy(name = "tool", detail = null, result = "Draft check failed", isError = true)
    val earlier = ChatToolActivity("earlier", "read", "path: draft.md", null, false)
    val earlierResult = earlier.copy(result = "Draft read")
    for (mixed in listOf(false, true)) {
      val invocation =
        activity("call", "toolCall", call).let {
          if (mixed) it.copy(content = listOf(ChatMessageContent(text = "Checking the draft")) + it.content) else it
        }
      val answer = text("final").copy(phase = "final_answer")
      val result = activity("result", "toolResult", failure)
      for (late in listOf(false, true)) {
        val history = listOf(text("prompt", "user"), text("commentary"), activity("earlier", "toolCall", earlier), activity("earlier-result", "toolResult", earlierResult), invocation) + if (late) listOf(answer, result) else listOf(result, answer)
        val built = timeline(history)
        assertEquals(2, built.items.filterIsInstance<ChatTimelineItem.ToolActivity>().sumOf { it.tools.size })
        val collapsed = prepareChatHistory(history, "main", "main").buildTimeline(0, emptyList(), null)
        assertEquals(
          "mixed=$mixed late=$late",
          if (late) (if (mixed) emptyList() else listOf(earlierResult)) + call.copy(result = failure.result, isError = true) else emptyList(),
          collapsed.items.filterIsInstance<ChatTimelineItem.ToolActivity>().flatMap { it.tools },
        )
        assertEquals(listOf("final", "prompt"), collapsed.items.filterIsInstance<ChatTimelineItem.Message>().map { it.message.id })
      }
    }
  }

  @Test
  fun mixedMessagesUseResolvedToolCompletionWithoutChangingCanonicalContent() {
    val call = ChatToolActivity("mixed-call", "read", "path: draft.md", null, false)
    for (phase in listOf("final_answer", "commentary")) {
      for (output in listOf("Draft read", null)) {
        for (messageError in listOf(false, true)) {
          val mixed =
            text("mixed").copy(
              content = listOf(ChatMessageContent(text = "mixed"), ChatMessageContent(type = "toolCall", toolActivity = call)),
              phase = phase,
              isError = messageError,
              entryId = "mixed-entry",
              truncated = true,
            )
          val priorAnswer = if (phase == "commentary") listOf(text("final").copy(phase = "final_answer")) else emptyList()
          val history =
            listOf(text("prompt", "user"), text("work").copy(phase = "commentary")) + priorAnswer + mixed +
              activity("result", "toolResult", call.copy(result = output))
          val built = timeline(history)
          assertSame(
            mixed,
            built.items
              .filterIsInstance<ChatTimelineItem.Message>()
              .single { it.message.id == "mixed" }
              .message,
          )
          val collapsed = prepareChatHistory(history, "main", "main").buildTimeline(0, emptyList(), null)
          val expected =
            when {
              phase == "final_answer" && messageError -> listOf("mixed", "work", "prompt")
              phase == "final_answer" -> listOf("mixed", "prompt")
              messageError -> listOf("mixed", "final", "prompt")
              else -> listOf("final", "prompt")
            }
          assertEquals("phase=$phase output=$output error=$messageError", expected, collapsed.items.filterIsInstance<ChatTimelineItem.Message>().map { it.message.id })
          assertEquals(if (phase == "final_answer" && messageError) 0 else 1, collapsed.items.filterIsInstance<ChatTimelineItem.WorkedSummary>().size)
          assertEquals(1, built.items.filterIsInstance<ChatTimelineItem.ToolActivity>().sumOf { it.tools.size })
          if (!messageError) assertEquals(0, collapsed.items.filterIsInstance<ChatTimelineItem.ToolActivity>().size)
        }
      }
    }
  }

  @Test
  fun adjacentReplylessRunKeepsItsOwnResultOutsideEarlierCompletedWork() {
    val first = ChatToolActivity("a", "read", null, "First run result", false)
    val second = ChatToolActivity("b", "read", null, "Independent run result", false)
    for (earlyCall in listOf(false, true)) {
      val history =
        listOf(text("prompt", "user").copy(runId = "run-b")) +
          (if (earlyCall) listOf(activity("b-call", "toolCall", second.copy(result = null)).copy(runId = "run-b")) else emptyList()) +
          listOf(
            text("final").copy(runId = "run-a", phase = "final_answer"),
            activity("a", "toolResult", first).copy(runId = "run-a"),
            activity("b", "toolResult", second).copy(runId = "run-b"),
          )
      val built = timeline(history)
      for (active in listOf(null, "run-b")) {
        val collapsed = prepareChatHistory(history, "main", "main").buildTimeline(0, emptyList(), null, activeRunId = active)
        if (active == null) {
          assertEquals(listOf(second), collapsed.items.filterIsInstance<ChatTimelineItem.ToolActivity>().flatMap { it.tools })
        } else {
          assertEquals(built.items, collapsed.items)
        }
        assertEquals(listOf("final", "prompt"), collapsed.items.filterIsInstance<ChatTimelineItem.Message>().map { it.message.id })
      }
    }
  }

  @Test
  fun independentRunFailuresRequireALaterReplyFromThatRun() {
    val call = ChatToolActivity("run-b-call", "read", "path: draft.md", null, false)
    val failure = call.copy(result = "Draft read failed", isError = true)
    val replies = listOf(null, text("run-b-final").copy(phase = "final_answer"), text("run-b-final"))
    for (reply in replies) {
      for (nonReply in listOf(text("run-b-work").copy(phase = "commentary"), text("run-b-work").copy(isError = true))) {
        val history =
          listOf(
            text("prompt", "user").copy(runId = "run-a"),
            text("run-a-work").copy(runId = "run-a", phase = "commentary"),
            activity("call", "toolCall", call).copy(runId = "run-b"),
          ) + listOfNotNull(reply?.copy(runId = "run-b")) +
            listOf(
              nonReply.copy(runId = "run-b"),
              activity("failure", "toolResult", failure).copy(runId = "run-b"),
              text("final").copy(runId = "run-a", phase = "final_answer"),
            )
        val collapsed = prepareChatHistory(history, "main", "main").buildTimeline(0, emptyList(), null)
        val expected =
          listOf("final") +
            (if (reply == null || nonReply.isError) listOf("run-b-work") else emptyList()) +
            (if (reply?.phase == "final_answer") listOf("run-b-final") else emptyList()) + listOf("prompt")
        assertEquals(expected, collapsed.items.filterIsInstance<ChatTimelineItem.Message>().map { it.message.id })
        assertEquals(listOf(failure), collapsed.items.filterIsInstance<ChatTimelineItem.ToolActivity>().flatMap { it.tools })
        assertEquals(1, collapsed.items.filterIsInstance<ChatTimelineItem.WorkedSummary>().size)
      }
    }
  }

  @Test
  fun matchedResultsSupplyMissingRunOwnershipWithoutChangingCanonicalMessages() {
    val call = ChatToolActivity("partial-call", "read", "path: draft.md", null, false)
    for (mixedAt in listOf(null, "call", "result")) {
      for (failed in listOf(false, true)) {
        for (answered in listOf(false, true)) {
          val invocation =
            activity("call", "toolCall", call).copy(runId = if (mixedAt == "result") "run-b" else null).let {
              if (mixedAt == "call") it.copy(content = listOf(ChatMessageContent(text = "Checking")) + it.content, phase = "commentary") else it
            }
          val result = call.copy(result = if (failed) "B failed" else null, isError = failed)
          val carrier =
            activity("result", "toolResult", result).copy(runId = if (mixedAt == "result") null else "run-b").let {
              if (mixedAt == "result") it.copy(role = "assistant", content = listOf(ChatMessageContent(text = "Checked")) + it.content, phase = "commentary") else it
            }
          val history =
            listOf(
              text("prompt", "user").copy(runId = "run-a"),
              text("a-work").copy(runId = "run-a", phase = "commentary"),
              invocation,
              carrier,
            ) + (if (answered) listOf(text("b-final").copy(runId = "run-b", phase = "final_answer")) else emptyList()) +
              text("a-final").copy(runId = "run-a", phase = "final_answer")
          val prepared = prepareChatHistory(history, "main", "main")
          val mixed = if (mixedAt == "result") carrier else invocation
          if (mixedAt != null) {
            assertSame(
              mixed,
              prepared.rows
                .filterIsInstance<ChatTimelineItem.Message>()
                .single { it.message.id == mixed.id }
                .message,
            )
          }
          val collapsed = prepared.buildTimeline(0, emptyList(), null)
          assertEquals(1, prepared.rows.filterIsInstance<ChatTimelineItem.ToolActivity>().sumOf { it.tools.size })
          assertEquals(if (answered) emptyList() else listOf(result), collapsed.items.filterIsInstance<ChatTimelineItem.ToolActivity>().flatMap { it.tools })
          val expected =
            listOf("a-final") + (
              if (answered) {
                listOf("b-final")
              } else if (mixedAt != null) {
                listOf(mixed.id)
              } else {
                emptyList()
              }
            ) + listOf("prompt")
          assertEquals(expected, collapsed.items.filterIsInstance<ChatTimelineItem.Message>().map { it.message.id })
          assertEquals(prepared.rows.asReversed().map(::chatTimelineItemKey), prepared.buildTimeline(0, emptyList(), null, activeRunId = "run-b").items.map(::chatTimelineItemKey))
        }
      }
    }
  }

  @Test
  fun adoptedRunCannotBeOverwrittenThroughTheUnownedCallFallback() {
    val call = ChatToolActivity("reused", "read", "path: draft.md", null, false)
    val failed = call.copy(result = "B failed", isError = true)
    val other = call.copy(name = "tool", detail = null, result = "C report")
    val history =
      listOf(
        activity("unowned", "toolCall", call),
        activity("b-result", "toolResult", failed).copy(runId = "run-b"),
        activity("c-result", "toolResult", other).copy(runId = "run-c"),
      )
    assertEquals(listOf(failed, other), timeline(history).items.filterIsInstance<ChatTimelineItem.ToolActivity>().flatMap { it.tools })
  }

  @Test
  fun aMixedMessageOnlyInfersASingleOwnerAndRequiresEveryToolOwnerAnswered() {
    val callB = ChatToolActivity("b", "read", "path: b.md", null, false)
    val callC = callB.copy(toolCallId = "c", detail = "path: c.md")
    for (calls in listOf(listOf(callB), listOf(callB, callC))) {
      for (answered in listOf(emptySet(), setOf("b"), setOf("b", "c"))) {
        val mixed = text("mixed-final").copy(phase = "final_answer", content = listOf(ChatMessageContent(text = "mixed-final")) + calls.map { ChatMessageContent(type = "toolCall", toolActivity = it) })
        val history =
          listOf(text("prompt", "user"), mixed) +
            calls.map { activity("result-${it.toolCallId}", "toolResult", it.copy(result = "ok")).copy(runId = "run-${it.toolCallId}") } +
            answered.map { text("final-$it").copy(runId = "run-$it", phase = "final_answer") } +
            text("a-final").copy(runId = "run-a", phase = "final_answer")
        val prepared = prepareChatHistory(history, "main", "main")
        assertSame(
          mixed,
          prepared.rows
            .filterIsInstance<ChatTimelineItem.Message>()
            .single { it.message.id == mixed.id }
            .message,
        )
        val collapsed = prepared.buildTimeline(0, emptyList(), null)
        val allAnswered = calls.size == 1 || answered.containsAll(calls.map { checkNotNull(it.toolCallId) })
        assertEquals(if (allAnswered) 0 else calls.size, collapsed.items.filterIsInstance<ChatTimelineItem.ToolActivity>().sumOf { it.tools.size })
        assertEquals(1, collapsed.items.filterIsInstance<ChatTimelineItem.Message>().count { it.message.id == "mixed-final" })
      }
    }
  }

  @Test
  fun repeatedToolIdsInDifferentRunsKeepTheirOwnResults() {
    val first = ChatToolActivity("same-id", "read", "path: first.md", null, false)
    val second = first.copy(detail = "path: second.md")
    val history =
      listOf(
        activity("a", "toolCall", first).copy(runId = "run-a"),
        activity("b", "toolCall", second).copy(runId = "run-b"),
        activity("b-result", "toolResult", second.copy(result = "Second failed", isError = true)).copy(runId = "run-b"),
        activity("a-result", "toolResult", first.copy(result = "First succeeded")).copy(runId = "run-a"),
      )
    assertEquals(
      listOf(first.copy(result = "First succeeded"), second.copy(result = "Second failed", isError = true)),
      timeline(history).items.filterIsInstance<ChatTimelineItem.ToolActivity>().flatMap { it.tools },
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
        .filterIsInstance<ChatTimelineItem.ToolActivity>()
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
      ).items.filterIsInstance<ChatTimelineItem.ToolActivity>()
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
          .filterIsInstance<ChatTimelineItem.ToolActivity>()
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
      ).items.filterIsInstance<ChatTimelineItem.ToolActivity>()
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
      val groups = timeline(history).items.filterIsInstance<ChatTimelineItem.ToolActivity>()
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
      val groups = built.items.filterIsInstance<ChatTimelineItem.ToolActivity>()
      assertEquals(2, groups.size)
      assertEquals(listOf(output, call), groups.flatMap { it.tools })
      assertEquals(forwarded.content.isNotEmpty(), built.items.filterIsInstance<ChatTimelineItem.Message>().any { it.message.id == "forwarded" })
      val collapsed = prepareChatHistory(history, "agent:main:dashboard:test", "agent:main:main").buildTimeline(0, emptyList(), null)
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
        .filterIsInstance<ChatTimelineItem.ToolActivity>()
    assertEquals(listOf(output, call), groups.flatMap { it.tools })
  }
}
