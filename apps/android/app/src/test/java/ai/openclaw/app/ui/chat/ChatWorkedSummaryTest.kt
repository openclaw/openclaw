package ai.openclaw.app.ui.chat

import ai.openclaw.app.chat.ChatMessage
import ai.openclaw.app.chat.ChatMessageContent
import ai.openclaw.app.chat.ChatMessageProvenance
import ai.openclaw.app.chat.ChatToolActivity
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

class ChatWorkedSummaryTest {
  private fun message(
    id: String,
    role: String,
    time: Long,
  ) = ChatMessage(id, role, listOf(ChatMessageContent(text = id)), time)

  private val messages =
    listOf(
      message("user", "user", 1000),
      message("commentary", "assistant", 2000),
      ChatMessage("call", "assistant", listOf(ChatMessageContent(type = "toolCall", toolActivity = ChatToolActivity("c", "bash", "pwd", "ok", false))), 3000),
      message("final", "assistant", 140000),
    )

  @Test fun completedWorkStartsCollapsedButFinalAnswerAndPromptStayVisible() {
    val timeline = buildChatTimeline(messages, 0, emptyList(), null).withCompletedWorkGroups(messages, false, emptySet(), "agent:main:dashboard:test")
    assertEquals(listOf("message:final", "worked:final", "message:user"), timeline.items.map(::chatTimelineItemKey))
    assertEquals(2, timeline.readAnchorIndex)
    val summary = timeline.items.filterIsInstance<ChatTimelineItem.WorkedSummary>().single()
    assertEquals("Worked for 2m 19s", workedSummaryLabel(summary.durationMs))
    assertFalse(summary.expanded)
  }

  @Test fun expandingRestoresOriginalOrderWithoutHidingFinalAnswer() {
    val timeline = buildChatTimeline(messages, 0, emptyList(), null).withCompletedWorkGroups(messages, false, setOf("final"), "agent:main:dashboard:test")
    assertEquals(listOf("message:final", "completed-tools:call", "message:commentary", "worked:final", "message:user"), timeline.items.map(::chatTimelineItemKey))
  }

  @Test fun mixedCommentaryFoldsWithEarlierWorkAndExpandsWithCanonicalContent() {
    val mixed =
      message("mixed", "assistant", 4000).copy(
        content = listOf(ChatMessageContent(text = "Checking the result")) + messages[2].content,
        entryId = "mixed-entry",
        truncated = true,
      )
    val history = messages.dropLast(1) + mixed + messages.last()
    val original = buildChatTimeline(history, 0, emptyList(), null)
    val collapsed = original.withCompletedWorkGroups(history, false, emptySet(), "agent:main:dashboard:test")
    assertEquals(listOf("message:final", "worked:final", "message:user"), collapsed.items.map(::chatTimelineItemKey))

    val expanded = original.withCompletedWorkGroups(history, false, setOf("final"), "agent:main:dashboard:test")
    assertEquals(
      original.items.map(::chatTimelineItemKey),
      expanded.items.filterNot { it is ChatTimelineItem.WorkedSummary }.map(::chatTimelineItemKey),
    )
    val restored =
      expanded.items
        .filterIsInstance<ChatTimelineItem.Message>()
        .single { it.message.id == "mixed" }
        .message
    assertSame(mixed, restored)
    assertTrue(restored.matchesFullRead(mixed))
  }

  @Test fun mixedToolAndImageMessageRemainsAFoldingBoundary() {
    val mixed =
      message("mixed", "assistant", 4000).copy(
        content = listOf(ChatMessageContent(text = "Screenshot"), ChatMessageContent(type = "image")) + messages[2].content,
      )
    val history = messages.dropLast(1) + mixed + messages.last()
    val collapsed =
      buildChatTimeline(history, 0, emptyList(), null)
        .withCompletedWorkGroups(history, false, emptySet(), "agent:main:dashboard:test")
    assertTrue(collapsed.items.any { it is ChatTimelineItem.Message && it.message === mixed })
    assertTrue(collapsed.items.any { it is ChatTimelineItem.Message && it.message.id == "commentary" })
  }

  @Test fun hiddenToolTurnsKeepSeparateFinalRepliesAndDurations() {
    val history =
      listOf(
        messages[2].copy(id = "work-1", timestampMs = 1000, turnBoundary = true),
        message("final-1", "assistant", 3000),
        messages[2].copy(id = "work-2", timestampMs = 4000, turnBoundary = true),
        message("final-2", "assistant", 9000),
      )
    val timeline =
      buildChatTimeline(history, 0, emptyList(), null)
        .withCompletedWorkGroups(history, false, emptySet(), "agent:main:dashboard:test")
    assertEquals(listOf("message:final-2", "worked:final-2", "message:final-1", "worked:final-1"), timeline.items.map(::chatTimelineItemKey))
    assertEquals(listOf(5000L, 2000L), timeline.items.filterIsInstance<ChatTimelineItem.WorkedSummary>().map { it.durationMs })
  }

  @Test fun emptyBoundaryCarrierMovesToVisibleRowWithoutChangingCanonicalMessage() {
    val empty =
      ChatMessage(
        "empty",
        "toolresult",
        listOf(ChatMessageContent(type = "toolResult", toolActivity = ChatToolActivity("empty", "tool", null, null, false))),
        2500,
        turnBoundary = true,
      )
    val mixed = mixedToolMessage()
    val history = listOf(message("previous-final", "assistant", 2000), empty, mixed, toolResult(), messages.last())
    val timeline = buildChatTimeline(history, 0, emptyList(), null)
    val row = timeline.items.filterIsInstance<ChatTimelineItem.Message>().single { it.message.id == mixed.id }
    assertTrue(row.turnBoundary)
    assertFalse(row.message.turnBoundary)
    assertTrue(row.message.matchesFullRead(mixed))
    val collapsed = timeline.withCompletedWorkGroups(history, false, emptySet(), "agent:main:dashboard:test")
    assertEquals(listOf("message:final", "worked:final", "message:previous-final"), collapsed.items.map(::chatTimelineItemKey))
  }

  private fun mixedToolMessage() =
    ChatMessage(
      id = "mixed",
      role = "assistant",
      content =
        listOf(
          ChatMessageContent(text = "Checking now."),
          ChatMessageContent(type = "toolCall", toolActivity = ChatToolActivity("c", "bash", "pwd", null, false)),
        ),
      timestampMs = 3000,
      entryId = "mixed",
      truncated = true,
    )

  private fun toolResult() =
    ChatMessage(
      id = "result",
      role = "toolresult",
      content = listOf(ChatMessageContent(type = "toolResult", toolActivity = ChatToolActivity("c", "bash", null, "ok", false))),
      timestampMs = 4000,
    )

  @Test fun forwardedAssistantStartsSeparateTurnWithoutHidingActualAnswer() {
    val forwarded =
      message("forwarded", "assistant", 150000).copy(
        provenance = ChatMessageProvenance(kind = "inter_session", sourceTool = "sessions_send"),
      )
    for (expanded in listOf(emptySet(), setOf("final"))) {
      val history = messages + forwarded
      val timeline =
        buildChatTimeline(history, 0, emptyList(), null)
          .withCompletedWorkGroups(history, false, expanded, "agent:main:dashboard:test")
      assertEquals("message:forwarded", chatTimelineItemKey(timeline.items.first()))
      assertTrue(timeline.items.any { it is ChatTimelineItem.Message && it.message.id == "final" })
      assertEquals(listOf("final"), timeline.items.filterIsInstance<ChatTimelineItem.WorkedSummary>().map { it.key })
    }
  }

  @Test fun forwardedReportStaysVisibleWhenItsOwnResponseCompletes() {
    val forwarded =
      message("forwarded", "assistant", 150000).copy(
        provenance = ChatMessageProvenance(kind = "inter_session", sourceTool = "sessions_send"),
      )
    val history =
      messages + forwarded +
        message("report-work", "assistant", 151000) + message("report-answer", "assistant", 160000)
    val timeline =
      buildChatTimeline(history, 0, emptyList(), null)
        .withCompletedWorkGroups(history, false, emptySet(), "agent:main:dashboard:test")
    assertEquals(
      listOf("message:report-answer", "worked:report-answer", "message:forwarded", "message:final", "worked:final", "message:user"),
      timeline.items.map(::chatTimelineItemKey),
    )
  }

  @Test fun activeTurnAndToolOnlyResultRemainExposed() {
    val live = buildChatTimeline(messages, 1, emptyList(), null).withCompletedWorkGroups(messages, true, emptySet(), "agent:main:dashboard:test")
    assertTrue(live.items.none { it is ChatTimelineItem.WorkedSummary })
    val onlyTools = listOf(messages[0], messages[2])
    val noReply = buildChatTimeline(onlyTools, 0, emptyList(), null).withCompletedWorkGroups(onlyTools, false, emptySet(), "agent:main:dashboard:test")
    assertTrue(noReply.items.none { it is ChatTimelineItem.WorkedSummary })
  }

  @Test fun priorCompletedTurnCollapsesWhileNewestTurnRuns() {
    val history = messages + message("next-user", "user", 150000) + message("next-comment", "assistant", 160000)
    val timeline = buildChatTimeline(history, 1, emptyList(), null).withCompletedWorkGroups(history, true, emptySet(), "agent:main:dashboard:test")
    assertEquals(
      "final",
      timeline.items
        .filterIsInstance<ChatTimelineItem.WorkedSummary>()
        .single()
        .key,
    )
    assertTrue(timeline.items.any { it is ChatTimelineItem.Message && it.message.id == "next-comment" })
  }

  @Test fun missingOrReversedTimesDoNotInventRuntime() {
    for (time in listOf(null, 0L)) {
      val history = messages.dropLast(1) + messages.last().copy(timestampMs = time)
      val timeline = buildChatTimeline(history, 0, emptyList(), null).withCompletedWorkGroups(history, false, emptySet(), "agent:main:dashboard:test")
      assertEquals(
        "Worked",
        workedSummaryLabel(
          timeline.items
            .filterIsInstance<ChatTimelineItem.WorkedSummary>()
            .single()
            .durationMs,
        ),
      )
    }
    assertEquals("Worked for 1m", workedSummaryLabel(59999))
    assertEquals("Worked for 1h 1s", workedSummaryLabel(3601000))
  }

  @Test fun finalOnlyReplyNeedsNoDisclosure() {
    val history = listOf(messages.first(), messages.last())
    val timeline = buildChatTimeline(history, 0, emptyList(), null)
    assertEquals(timeline.items, timeline.withCompletedWorkGroups(history, false, emptySet(), "agent:main:dashboard:test").items)
  }

  @Test fun systemBoundaryAndPrecedingCommentaryStayVisible() {
    val divider =
      ChatMessage(
        "reset",
        "system",
        emptyList(),
        2500,
        transcriptMarker =
          ai.openclaw.app.chat
            .ChatTranscriptMarker(kind = "reset", id = "reset"),
      )
    val history = listOf(messages[0].copy(role = "User"), messages[1], divider, messages[2], messages[3].copy(role = "Assistant"))
    val timeline = buildChatTimeline(history, 0, emptyList(), null).withCompletedWorkGroups(history, false, emptySet(), "agent:main:dashboard:test")
    assertTrue(timeline.items.any { it is ChatTimelineItem.SystemDivider })
    assertTrue(timeline.items.any { it is ChatTimelineItem.Message && it.message.id == "commentary" })
    assertEquals(1, timeline.items.filterIsInstance<ChatTimelineItem.WorkedSummary>().size)
  }

  @Test fun channelSessionsKeepTheirCanonicalTranscriptExposed() {
    val timeline = buildChatTimeline(messages, 0, emptyList(), null)
    for (session in listOf("agent:main:telegram:direct:123", "agent:main:main", "agent:main:dashboard:", "agent:main:dashboard:test:extra")) {
      assertEquals(timeline.items, timeline.withCompletedWorkGroups(messages, false, emptySet(), session).items)
    }
  }

  @Test fun steeringKeepsTheWholeRunningChainExposed() {
    val history =
      messages.dropLast(1).map { if (it.role == "user") it.copy(runId = "run") else it } +
        message("steer", "user", 4000).copy(steerTargetRunId = "run") +
        message("continued", "assistant", 5000)
    val timeline = buildChatTimeline(history, 1, emptyList(), null)
    assertEquals(timeline.items, timeline.withCompletedWorkGroups(history, true, emptySet(), "agent:main:dashboard:test").items)
  }

  @Test fun completedSteeredWorkUsesTerminalReplyAndDistinctStableKeys() {
    val history =
      messages.dropLast(1).map { if (it.role == "user") it.copy(runId = "run") else it } +
        message("steer", "user", 4000).copy(steerTargetRunId = "run") +
        message("continued", "assistant", 5000) + messages.last()
    val timeline =
      buildChatTimeline(history, 0, emptyList(), null)
        .withCompletedWorkGroups(history, false, emptySet(), "agent:main:dashboard:test")
    assertEquals(listOf("message:final", "worked:final", "message:steer", "worked:steer", "message:user"), timeline.items.map(::chatTimelineItemKey))
    assertEquals(listOf(136000L, 139000L), timeline.items.filterIsInstance<ChatTimelineItem.WorkedSummary>().map { it.durationMs })
  }
}
