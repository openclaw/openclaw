package ai.openclaw.app.ui.chat

import ai.openclaw.app.chat.ChatAgentActivity
import ai.openclaw.app.chat.ChatMessage
import ai.openclaw.app.chat.ChatMessageContent
import ai.openclaw.app.chat.ChatMessageProvenance
import ai.openclaw.app.chat.ChatPendingToolCall
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
    val timeline = prepareChatHistory(messages, "agent:main:dashboard:test", "agent:main:main").buildTimeline(0, emptyList(), null)
    assertEquals(listOf("message:final", "worked:final", "message:user"), timeline.items.map(::chatTimelineItemKey))
    assertEquals(2, timeline.readAnchorIndex)
    val summary = timeline.items.filterIsInstance<ChatTimelineItem.WorkedSummary>().single()
    assertEquals("Worked for 2m 19s", workedSummaryLabel(summary.durationMs))
    assertFalse(summary.expanded)
  }

  @Test fun mainConversationCollapsesCompletedWork() {
    val mainKey = ai.openclaw.app.buildNodeMainSessionKey("synthetic-device", "main")
    for (session in listOf("main", "agent:main:main", mainKey)) {
      val timeline = prepareChatHistory(messages, session, mainKey).buildTimeline(0, emptyList(), null)
      assertEquals(listOf("message:final", "worked:final", "message:user"), timeline.items.map(::chatTimelineItemKey))
    }
  }

  @Test fun foldedOutcomesUseCurrentPreparedFactsInsteadOfStickyRawErrors() {
    val activity = ChatAgentActivity("tool:c", "tool", "end", "Check draft", toolCallId = "c", status = "failed")
    val cases =
      listOf(
        null to mapOf(WorkedToolOutcome.Failed to 1),
        emptyList<ChatAgentActivity>() to emptyMap(),
        listOf(activity) to mapOf(WorkedToolOutcome.Failed to 1),
        listOf(activity.copy(status = "blocked")) to mapOf(WorkedToolOutcome.Blocked to 1),
        listOf(activity.copy(status = null)) to mapOf(WorkedToolOutcome.Unknown to 1),
        listOf(activity.copy(status = "completed")) to emptyMap(),
        listOf(activity.copy(hideFromChannelProgress = true)) to emptyMap(),
        listOf(activity.copy(suppressChannelProgress = true)) to emptyMap(),
      )
    for ((prepared, expected) in cases) {
      val call = messages[2].copy(activity = prepared?.let { listOf(activity) })
      val result =
        ChatMessage(
          "result",
          "toolresult",
          listOf(ChatMessageContent(type = "toolResult", toolActivity = ChatToolActivity("c", "bash", null, "Earlier error", true))),
          4000,
          activity = prepared,
        )
      val history = prepareChatHistory(messages.take(2) + call + result + messages.last(), "main", "main")
      for (expanded in listOf(emptySet(), setOf("final"))) {
        val timeline = history.buildTimeline(0, emptyList(), null, expandedWorkKeys = expanded)
        assertEquals(
          "prepared=$prepared expanded=$expanded",
          expected,
          timeline.items
            .filterIsInstance<ChatTimelineItem.WorkedSummary>()
            .single()
            .outcomes,
        )
        assertTrue(timeline.items.any { it is ChatTimelineItem.Message && it.message.id == "final" })
      }
    }
  }

  @Test fun foldedMixedToolsKeepRunScopedCountsAndExcludeOtherTurns() {
    fun mixed(
      run: String,
      status: String,
    ) = message("mixed-$run", "assistant", 3000).copy(
      runId = run,
      content = listOf(ChatMessageContent(text = "Checking draft")) + messages[2].content,
      activity = listOf(ChatAgentActivity("tool:c", "tool", "end", "Check draft", toolCallId = "c", status = status)),
    )
    val history =
      listOf(
        messages.first(),
        mixed("first", "failed"),
        mixed("second", "failed"),
        message("first-answer", "assistant", 5000).copy(runId = "first", phase = "final_answer"),
        messages.last().copy(runId = "second"),
        message("next-user", "user", 150000),
        mixed("third", "blocked").copy(timestampMs = 160000),
        message("next-answer", "assistant", 170000).copy(runId = "third"),
      )
    val timeline = prepareChatHistory(history, "main", "main").buildTimeline(0, emptyList(), null)
    val summaries = timeline.items.filterIsInstance<ChatTimelineItem.WorkedSummary>().associateBy { it.key }
    assertEquals(mapOf(WorkedToolOutcome.Failed to 2), summaries.getValue("final").outcomes)
    assertEquals(mapOf(WorkedToolOutcome.Blocked to 1), summaries.getValue("next-answer").outcomes)
  }

  @Test fun expandingRestoresOriginalOrderWithoutHidingFinalAnswer() {
    val timeline = prepareChatHistory(messages, "agent:main:dashboard:test", "agent:main:main").buildTimeline(0, emptyList(), null, expandedWorkKeys = setOf("final"))
    assertEquals(listOf("message:final", "tools:user", "message:commentary", "worked:final", "message:user"), timeline.items.map(::chatTimelineItemKey))
  }

  @Test fun mixedCommentaryFoldsWithEarlierWorkAndExpandsWithCanonicalContent() {
    val mixed =
      message("mixed", "assistant", 4000).copy(
        content = listOf(ChatMessageContent(text = "Checking the result")) + messages[2].content,
        entryId = "mixed-entry",
        truncated = true,
      )
    val history = messages.dropLast(1) + mixed + messages.last()
    val original = prepareChatHistory(history, "agent:main:telegram:direct:projection", "agent:main:main").buildTimeline(0, emptyList(), null)
    val prepared = prepareChatHistory(history, "agent:main:dashboard:test", "agent:main:main")
    val collapsed = prepared.buildTimeline(0, emptyList(), null)
    assertEquals(listOf("message:final", "worked:final", "message:user"), collapsed.items.map(::chatTimelineItemKey))

    val expanded = prepared.buildTimeline(0, emptyList(), null, expandedWorkKeys = setOf("final"))
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

  @Test fun mixedToolAndImageMessageStaysVisibleOutsideCompletedWork() {
    val mixed =
      message("mixed", "assistant", 4000).copy(
        content = listOf(ChatMessageContent(text = "Screenshot"), ChatMessageContent(type = "image")) + messages[2].content,
      )
    val history = messages.dropLast(1) + mixed + messages.last()
    val collapsed =
      prepareChatHistory(history, "agent:main:dashboard:test", "agent:main:main").buildTimeline(0, emptyList(), null)
    assertTrue(collapsed.items.any { it is ChatTimelineItem.Message && it.message === mixed })
    assertFalse(collapsed.items.any { it is ChatTimelineItem.Message && it.message.id == "commentary" })
    assertTrue(collapsed.items.any { it is ChatTimelineItem.Message && it.message.id == "final" })
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
      prepareChatHistory(history, "agent:main:dashboard:test", "agent:main:main").buildTimeline(0, emptyList(), null)
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
    val timeline = prepareChatHistory(history, "agent:main:telegram:direct:projection", "agent:main:main").buildTimeline(0, emptyList(), null)
    val row = timeline.items.filterIsInstance<ChatTimelineItem.Message>().single { it.message.id == mixed.id }
    assertTrue(row.turnBoundary)
    assertFalse(row.message.turnBoundary)
    assertTrue(row.message.matchesFullRead(mixed))
    val collapsed = prepareChatHistory(history, "agent:main:dashboard:test", "agent:main:main").buildTimeline(0, emptyList(), null)
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
        prepareChatHistory(history, "agent:main:dashboard:test", "agent:main:main").buildTimeline(0, emptyList(), null, expandedWorkKeys = expanded)
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
      prepareChatHistory(history, "agent:main:dashboard:test", "agent:main:main").buildTimeline(0, emptyList(), null)
    assertEquals(
      listOf("message:report-answer", "worked:report-answer", "message:forwarded", "message:final", "worked:final", "message:user"),
      timeline.items.map(::chatTimelineItemKey),
    )
  }

  @Test fun activeTurnAndToolOnlyResultRemainExposed() {
    val live = prepareChatHistory(messages, "agent:main:dashboard:test", "agent:main:main").buildTimeline(1, emptyList(), null)
    assertTrue(live.items.none { it is ChatTimelineItem.WorkedSummary })
    val onlyTools = listOf(messages[0], messages[2])
    val noReply = prepareChatHistory(onlyTools, "agent:main:dashboard:test", "agent:main:main").buildTimeline(0, emptyList(), null)
    assertTrue(noReply.items.none { it is ChatTimelineItem.WorkedSummary })
  }

  @Test fun priorCompletedTurnCollapsesWhileNewestTurnRuns() {
    val history = messages + message("next-user", "user", 150000) + message("next-comment", "assistant", 160000)
    val timeline = prepareChatHistory(history, "agent:main:dashboard:test", "agent:main:main").buildTimeline(1, emptyList(), null)
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
      val timeline = prepareChatHistory(history, "agent:main:dashboard:test", "agent:main:main").buildTimeline(0, emptyList(), null)
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
    val timeline = prepareChatHistory(history, "agent:main:telegram:direct:projection", "agent:main:main").buildTimeline(0, emptyList(), null)
    assertEquals(timeline.items, prepareChatHistory(history, "agent:main:dashboard:test", "agent:main:main").buildTimeline(0, emptyList(), null).items)
  }

  @Test fun commentaryWithoutAnAnswerAndUnresolvedPostAnswerToolsStayExposed() {
    val unfinished = messages.dropLast(1).map { if (it.role == "assistant") it.copy(phase = "commentary") else it }
    val original = prepareChatHistory(unfinished, "agent:main:telegram:direct:projection", "agent:main:main").buildTimeline(0, emptyList(), null)
    assertEquals(original.items, prepareChatHistory(unfinished, "main", "main").buildTimeline(0, emptyList(), null).items)
    for (tool in listOf(ChatToolActivity("later", "read", null, null, false), ChatToolActivity("later", "read", null, "Failed to read", true))) {
      val history = messages + ChatMessage("later", if (tool.isError) "toolresult" else "assistant", listOf(ChatMessageContent(type = if (tool.isError) "toolResult" else "toolCall", toolActivity = tool)), 150000)
      val timeline = prepareChatHistory(history, "main", "main").buildTimeline(0, emptyList(), null)
      assertEquals(listOf("tools:user", "message:final", "worked:final", "message:user"), timeline.items.map(::chatTimelineItemKey))
    }
  }

  @Test fun anActiveEarlierRunStaysVisibleAfterANewerUserMessage() {
    val history = messages.map { it.copy(runId = "running") } + message("next-user", "user", 160000)
    val timeline = prepareChatHistory(history, "agent:main:telegram:direct:projection", "agent:main:main").buildTimeline(1, emptyList(), null)
    assertEquals(timeline.items, prepareChatHistory(history, "main", "main").buildTimeline(1, emptyList(), null, activeRunId = "running").items)
  }

  @Test fun expandedIdentitySurvivesOlderHistoryPrepend() {
    val answer = messages.last().copy(entryId = "answer-entry")
    val history = listOf(message("older", "assistant", 500)) + messages.dropLast(1) + answer
    val timeline = prepareChatHistory(history, "main", "main").buildTimeline(0, emptyList(), null, expandedWorkKeys = setOf("answer-entry"))
    assertEquals(listOf("message:final", "tools:user", "message:commentary", "worked:answer-entry", "message:user", "message:older"), timeline.items.map(::chatTimelineItemKey))
    assertTrue(
      timeline.items
        .filterIsInstance<ChatTimelineItem.WorkedSummary>()
        .single()
        .expanded,
    )
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
    val timeline = prepareChatHistory(history, "agent:main:dashboard:test", "agent:main:main").buildTimeline(0, emptyList(), null)
    assertTrue(timeline.items.any { it is ChatTimelineItem.SystemDivider })
    assertTrue(timeline.items.any { it is ChatTimelineItem.Message && it.message.id == "commentary" })
    assertEquals(1, timeline.items.filterIsInstance<ChatTimelineItem.WorkedSummary>().size)
  }

  @Test fun channelSessionsKeepTheirCanonicalTranscriptExposed() {
    val timeline = prepareChatHistory(messages, "agent:main:telegram:direct:projection", "agent:main:main").buildTimeline(0, emptyList(), null)
    for (session in listOf("agent:main:telegram:direct:123", "agent:main:dashboard:", "agent:main:dashboard:test:extra")) {
      assertEquals(timeline.items, prepareChatHistory(messages, session, "agent:main:main").buildTimeline(0, emptyList(), null).items)
    }
  }

  @Test fun steeringKeepsTheWholeRunningChainExposed() {
    val history =
      messages.dropLast(1).map { if (it.role == "user") it.copy(runId = "run") else it } +
        message("steer", "user", 4000).copy(steerTargetRunId = "run") +
        message("continued", "assistant", 5000)
    val timeline = prepareChatHistory(history, "agent:main:telegram:direct:projection", "agent:main:main").buildTimeline(1, emptyList(), null)
    assertEquals(timeline.items, prepareChatHistory(history, "agent:main:dashboard:test", "agent:main:main").buildTimeline(1, emptyList(), null).items)
  }

  @Test fun completedSteeredWorkUsesTerminalReplyAndDistinctStableKeys() {
    val history =
      listOf(messages.first().copy(runId = "run"), messages[2].copy(runId = "run")) +
        message("steer", "user", 4000).copy(steerTargetRunId = "run") +
        message("continued", "assistant", 5000) + messages.last().copy(runId = "run")
    val timeline =
      prepareChatHistory(history, "agent:main:dashboard:test", "agent:main:main").buildTimeline(0, emptyList(), null)
    assertEquals(listOf("message:final", "worked:final", "message:steer", "worked:steer", "message:user"), timeline.items.map(::chatTimelineItemKey))
    assertEquals(listOf(136000L, 139000L), timeline.items.filterIsInstance<ChatTimelineItem.WorkedSummary>().map { it.durationMs })
  }

  @Test fun liveContentWithoutARunningChainExposesOnlyTheLatestSteeredTurn() {
    val history =
      messages.dropLast(1).map { if (it.role == "user") it.copy(runId = "run") else it } +
        message("steer", "user", 4000).copy(steerTargetRunId = "run") +
        message("continued", "assistant", 5000) + messages.last()
    for ((stream, tools) in listOf(
      "Streaming" to emptyList(),
      null to listOf(ChatPendingToolCall("pending", "read", startedAtMs = 150000)),
    )) {
      val timeline = prepareChatHistory(history, "agent:main:dashboard:test", mainSessionKey = "agent:main:main").buildTimeline(0, tools, stream)
      val summary = timeline.items.filterIsInstance<ChatTimelineItem.WorkedSummary>().single()
      assertEquals("steer", summary.key)
      assertFalse(summary.expanded)
      assertEquals(
        listOf("final", "continued", "steer", "user"),
        timeline.items.filterIsInstance<ChatTimelineItem.Message>().map { it.message.id },
      )
    }
  }

  @Test fun preparedHistoryReusesPartitionsAcrossLiveChangesWithoutReadingRawContent() {
    var contentReadable = true
    val source =
      listOf(
        message("user", "user", 1000),
        message("commentary", "assistant", 2000).copy(phase = "commentary"),
        message("media", "assistant", 3000).copy(content = listOf(ChatMessageContent(type = "image"))),
        message("final", "assistant", 4000).copy(phase = "final_answer"),
        messages[2].copy(timestampMs = 5000),
        message("error", "assistant", 6000).copy(isError = true),
      ).map { message ->
        val content = message.content
        message.copy(
          runId = "run-a",
          content =
            object : AbstractList<ChatMessageContent>() {
              override val size: Int get() {
                check(contentReadable) { "Live timeline rebuild reread history content" }
                return content.size
              }

              override fun get(index: Int): ChatMessageContent {
                check(contentReadable) { "Live timeline rebuild reread history content" }
                return content[index]
              }
            },
        )
      }
    val prepared = prepareChatHistory(source, "agent:main:main", "agent:main:main")
    val originalKeys = prepared.rows.asReversed().map(::chatTimelineItemKey)
    contentReadable = false
    repeat(3) { index ->
      val collapsed = prepared.buildTimeline(0, emptyList(), null)
      assertEquals(listOf("message:error", "message:final", "message:media", "worked:final", "message:user"), collapsed.items.map(::chatTimelineItemKey))
      assertEquals(collapsed.items.lastIndex, collapsed.readAnchorIndex)
      val expanded = prepared.buildTimeline(0, emptyList(), null, expandedWorkKeys = setOf("final"))
      assertEquals(listOf("message:error", "message:final", "message:media", "tools:user", "message:commentary", "worked:final", "message:user"), expanded.items.map(::chatTimelineItemKey))
      assertEquals(expanded.items.lastIndex, expanded.readAnchorIndex)
      val active = prepared.buildTimeline(0, emptyList(), null, activeRunId = "run-a")
      assertEquals(originalKeys, active.items.map(::chatTimelineItemKey))
      val streaming = prepared.buildTimeline(1, listOf(ChatPendingToolCall("pending-$index", "read", startedAtMs = 7000)), "Live $index")
      assertEquals(listOf("stream", "thinking") + originalKeys, streaming.items.map(::chatTimelineItemKey))
      assertEquals(streaming.items.lastIndex, streaming.readAnchorIndex)
    }
  }
}
