package ai.openclaw.app.ui.chat

import ai.openclaw.app.chat.ChatDiffStat
import ai.openclaw.app.chat.ChatMessage
import ai.openclaw.app.chat.ChatMessageContent
import ai.openclaw.app.chat.ChatMessageProvenance
import ai.openclaw.app.chat.ChatOutboxItem
import ai.openclaw.app.chat.ChatOutboxStatus
import ai.openclaw.app.chat.ChatPendingToolCall
import ai.openclaw.app.chat.ChatSubagentActivity
import ai.openclaw.app.chat.ChatToolActivity
import ai.openclaw.app.chat.ChatTranscriptMarker
import ai.openclaw.app.chat.OUTBOX_OWNER_CHANGED_ERROR
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class ChatTimelineTest {
  @Test
  fun groupsContiguousToolOnlyMessagesWithoutSwallowingAssistantText() {
    val call = ChatToolActivity("call-1", "read", "path: README.md", null, false)
    val result = ChatToolActivity("call-1", "read", null, "contents", false)
    val messages =
      listOf(
        textMessage(id = "assistant-before", role = "assistant", text = "I will inspect it."),
        ChatMessage("call", "assistant", listOf(ChatMessageContent(type = "toolCall", toolActivity = call)), 2),
        ChatMessage("result", "toolresult", listOf(ChatMessageContent(type = "toolResult", toolActivity = result)), 3),
        textMessage(id = "assistant-after", role = "assistant", text = "Done."),
      )

    val timeline = buildChatTimeline(messages, 0, emptyList(), null)

    assertEquals(
      listOf("message:assistant-after", "completed-tools:call", "message:assistant-before"),
      timeline.items.map(::chatTimelineItemKey),
    )
    val group = timeline.items.filterIsInstance<ChatTimelineItem.CompletedTools>().single()
    assertEquals(listOf(ChatToolActivity("call-1", "read", "path: README.md", "contents", false)), group.tools)
  }

  @Test
  fun mixedAssistantMessageKeepsVisibleTextBesideItsToolGroup() {
    val mixed =
      ChatMessage(
        id = "mixed",
        role = "assistant",
        content =
          listOf(
            ChatMessageContent(type = "text", text = "Checking now."),
            ChatMessageContent(type = "toolCall", toolActivity = ChatToolActivity("call-1", "exec", "command: pwd", null, false)),
          ),
        timestampMs = 1,
        entryId = "mixed",
        truncated = true,
      )

    val timeline = buildChatTimeline(listOf(mixed), 0, emptyList(), null)

    assertEquals(listOf("completed-tools:mixed", "message:mixed"), timeline.items.map(::chatTimelineItemKey))
    assertTrue((timeline.items[1] as ChatTimelineItem.Message).message.matchesFullRead(mixed))
    assertEquals(
      "Checking now.",
      (timeline.items[1] as ChatTimelineItem.Message)
        .message.content
        .filter { it.toolActivity == null }
        .single()
        .text,
    )
  }

  @Test
  fun completedToolResultChangesLatestContentVersion() {
    fun timeline(result: String) =
      buildChatTimeline(
        messages =
          listOf(
            ChatMessage(
              "result",
              "toolresult",
              listOf(ChatMessageContent(type = "toolResult", toolActivity = ChatToolActivity("call-1", "exec", null, result, false))),
              1,
            ),
          ),
        pendingRunCount = 0,
        pendingToolCalls = emptyList(),
        streamingAssistantText = null,
      )

    assertTrue(timeline("partial").latestContentVersion != timeline("complete").latestContentVersion)
  }

  @Test
  fun completedToolMetadataChangesOnlyTheLiveEdgeVersion() {
    val original = ChatToolActivity("call-1", "exec", "command: pwd", "output", false)

    fun toolMessage(tool: ChatToolActivity) =
      ChatMessage(
        "result",
        "toolresult",
        listOf(ChatMessageContent(type = "toolResult", toolActivity = tool)),
        1,
      )

    fun timeline(history: List<ChatMessage>) = buildChatTimeline(history, 0, emptyList(), null)
    val originalVersion = timeline(listOf(toolMessage(original))).latestContentVersion
    val final = textMessage(id = "final", role = "assistant", text = "Done.")
    val historyVersion = timeline(listOf(toolMessage(original), final)).latestContentVersion
    for (changed in listOf(
      original.copy(detail = "command: ls"),
      original.copy(isError = true),
      original.copy(arguments = buildJsonObject { put("command", "pwd") }),
    )) {
      assertTrue(originalVersion != timeline(listOf(toolMessage(changed))).latestContentVersion)
      assertEquals(historyVersion, timeline(listOf(toolMessage(changed), final)).latestContentVersion)
    }
  }

  @Test
  fun hiddenTurnBoundaryChangesTheLiveEdgeVersion() {
    val message = textMessage(id = "reply", role = "assistant", text = "Completed")
    val original = buildChatTimeline(listOf(message), 0, emptyList(), null)
    val changed = buildChatTimeline(listOf(message.copy(turnBoundary = true)), 0, emptyList(), null)
    assertTrue(original.latestContentVersion != changed.latestContentVersion)
  }

  @Test
  fun canonicalReplacementPreservesAnIdempotencyBackedUserAnchor() {
    val optimistic = textMessage(id = "optimistic", role = "user", text = "Send this").copy(idempotencyKey = "input:user")
    val canonical = optimistic.copy(id = "canonical", content = listOf(ChatMessageContent(text = "Canonical text")), timestampMs = 2)
    val first = buildChatTimeline(listOf(optimistic), 0, emptyList(), null)
    val second = buildChatTimeline(listOf(canonical), 0, emptyList(), null)
    assertEquals(first.latestUserMessageVersion, second.latestUserMessageVersion)
    assertTrue(second.containsUserMessageVersion(requireNotNull(first.latestUserMessageVersion)))
    assertTrue(first.latestContentVersion != second.latestContentVersion)
  }

  @Test
  fun activeRunAnchorsNewestUserPromptInsteadOfThinkingRow() {
    val user = textMessage(id = "user-1", role = "user", text = "hello")

    val timeline =
      buildChatTimeline(
        messages = listOf(user),
        pendingRunCount = 1,
        pendingToolCalls = emptyList(),
        streamingAssistantText = null,
      )

    assertEquals(listOf("thinking", "message:user-1"), timeline.items.map(::chatTimelineItemKey))
    assertEquals(1, timeline.readAnchorIndex)
    assertEquals(0, timeline.latestContentIndex)
    assertEquals("user-1", timeline.latestUserMessageId)
  }

  @Test
  fun activeRunAnchorsNewestUserPromptWhileAssistantStreams() {
    val olderAssistant = textMessage(id = "assistant-1", role = "assistant", text = "previous")
    val user = textMessage(id = "user-1", role = "user", text = "next")
    val tool =
      ChatPendingToolCall(
        toolCallId = "tool-1",
        name = "memory.search",
        startedAtMs = 1000L,
      )

    val timeline =
      buildChatTimeline(
        messages = listOf(olderAssistant, user),
        pendingRunCount = 1,
        pendingToolCalls = listOf(tool),
        streamingAssistantText = "streaming",
      )

    assertEquals(
      listOf("stream", "tools", "thinking", "message:user-1", "message:assistant-1"),
      timeline.items.map(::chatTimelineItemKey),
    )
    assertEquals(3, timeline.readAnchorIndex)
    assertEquals(0, timeline.latestContentIndex)
    assertEquals("user-1", timeline.latestUserMessageId)
  }

  @Test
  fun finishedRunKeepsLatestUserPromptAsReaderAnchor() {
    val user = textMessage(id = "user-1", role = "user", text = "hello")
    val assistant = textMessage(id = "assistant-1", role = "assistant", text = "done")

    val timeline =
      buildChatTimeline(
        messages = listOf(user, assistant),
        pendingRunCount = 0,
        pendingToolCalls = emptyList(),
        streamingAssistantText = null,
      )

    assertEquals(listOf("message:assistant-1", "message:user-1"), timeline.items.map(::chatTimelineItemKey))
    assertEquals(1, timeline.readAnchorIndex)
    assertEquals(0, timeline.latestContentIndex)
    assertEquals("user-1", timeline.latestUserMessageId)
  }

  @Test
  fun internalSystemMessagesBecomeOrderedNoticesWithExactSourceToolMatching() {
    val messages =
      listOf(
        textMessage(id = "user-1", role = "user", text = "before"),
        textMessage(id = "recovery", role = "user", text = "[System] Continue the interrupted turn.")
          .copy(
            timestampMs = 10L,
            provenance = ChatMessageProvenance("internal_system", "main_session_restart_recovery"),
          ),
        textMessage(id = "restart", role = "user", text = "[System] Gateway restarted during update.")
          .copy(
            timestampMs = 11L,
            provenance = ChatMessageProvenance("internal_system", "restart-sentinel"),
          ),
        textMessage(id = "fallback", role = "user", text = "[System] Keep the raw fallback copy.")
          .copy(
            timestampMs = 12L,
            provenance = ChatMessageProvenance("internal_system", "session-companion"),
          ),
        textMessage(id = "near-match", role = "user", text = "[System] Exact matching matters.")
          .copy(
            timestampMs = 13L,
            provenance = ChatMessageProvenance("internal_system", " restart-sentinel"),
          ),
        textMessage(id = "assistant-1", role = "assistant", text = "after"),
      )

    val timeline =
      buildChatTimeline(
        messages = messages,
        pendingRunCount = 0,
        pendingToolCalls = emptyList(),
        streamingAssistantText = null,
      )

    assertEquals(
      listOf(
        "message:assistant-1",
        "system-notice:13:4",
        "system-notice:12:3",
        "system-notice:11:2",
        "system-notice:10:1",
        "message:user-1",
      ),
      timeline.items.map(::chatTimelineItemKey),
    )
    val notices = timeline.items.filterIsInstance<ChatTimelineItem.SystemNotice>().asReversed()
    assertEquals(
      listOf(
        "System · restart recovery" to
          "Turn interrupted by a gateway restart — asked the agent to resume and finish the response.",
        "System · gateway restarted" to "Gateway restarted during update.",
        "System" to "Keep the raw fallback copy.",
        "System" to "Exact matching matters.",
      ),
      notices.map { it.label to it.body },
    )
    assertEquals("user-1", timeline.latestUserMessageId)
  }

  @Test
  fun transcriptMarkersBecomeStableDividersAndUnknownKindsStayHidden() {
    val compaction =
      textMessage(id = "compaction", role = "system", text = "Compaction")
        .copy(
          transcriptMarker =
            ChatTranscriptMarker(
              kind = "compaction",
              id = "checkpoint-1",
              tokensBefore = 900_000.5,
              tokensAfter = 24_700.25,
            ),
        )
    val unknown =
      textMessage(id = "unknown", role = "system", text = "Unknown")
        .copy(transcriptMarker = ChatTranscriptMarker("reset ", "unknown-1", null, null))
    val plainSystem = textMessage(id = "plain-system", role = "system", text = "Maintenance begins soon")
    val reset =
      textMessage(id = "reset", role = "system", text = "Reset")
        .copy(transcriptMarker = ChatTranscriptMarker("reset", "reset-1", null, null))

    val timeline =
      buildChatTimeline(
        messages =
          listOf(
            textMessage(id = "user-1", role = "user", text = "before"),
            compaction,
            plainSystem,
            unknown,
            reset,
            textMessage(id = "assistant-1", role = "assistant", text = "after"),
          ),
        pendingRunCount = 0,
        pendingToolCalls = emptyList(),
        streamingAssistantText = null,
      )

    assertEquals(
      listOf(
        "message:assistant-1",
        "divider:reset:reset-1",
        "message:plain-system",
        "divider:compaction:checkpoint-1",
        "message:user-1",
      ),
      timeline.items.map(::chatTimelineItemKey),
    )
    assertEquals(
      "system",
      timeline.items
        .filterIsInstance<ChatTimelineItem.Message>()[1]
        .message.role,
    )
    val dividers = timeline.items.filterIsInstance<ChatTimelineItem.SystemDivider>()
    assertEquals(
      ChatTimelineItem.SystemDivider(
        key = "divider:reset:reset-1",
        kind = SystemDividerKind.Reset,
        label = "Session reset",
        secondary = "The earlier conversation was cleared.",
      ),
      dividers[0],
    )
    assertEquals("saved 875.3k tokens", dividers[1].metric)
    assertEquals(SystemDividerKind.Compaction, dividers[1].kind)

    val rebuilt =
      buildChatTimeline(
        messages = listOf(compaction, reset),
        pendingRunCount = 0,
        pendingToolCalls = emptyList(),
        streamingAssistantText = null,
      )
    assertEquals(
      listOf("divider:reset:reset-1", "divider:compaction:checkpoint-1"),
      rebuilt.items.map(::chatTimelineItemKey),
    )
  }

  @Test
  fun compactionMetricsRequireFiniteDecreasingTokenCounts() {
    val markers =
      listOf(
        ChatTranscriptMarker("compaction", "valid", 1_000.9, 200.0),
        ChatTranscriptMarker("compaction", "equal", 1_000.0, 1_000.0),
        ChatTranscriptMarker("compaction", "infinite", Double.POSITIVE_INFINITY, 1.0),
      )
    val timeline =
      buildChatTimeline(
        messages =
          markers.mapIndexed { index, marker ->
            textMessage(id = "marker-$index", role = "system", text = "Compaction").copy(transcriptMarker = marker)
          },
        pendingRunCount = 0,
        pendingToolCalls = emptyList(),
        streamingAssistantText = null,
      )

    val metrics =
      timeline.items
        .filterIsInstance<ChatTimelineItem.SystemDivider>()
        .associate { it.key to it.metric }
    assertEquals("saved 800 tokens", metrics["divider:compaction:valid"])
    assertEquals(null, metrics["divider:compaction:equal"])
    assertEquals(null, metrics["divider:compaction:infinite"])
  }

  @Test
  fun finishedTurnRecapUsesNewestSlotWithoutChangingReaderAnchorRow() {
    val user = textMessage(id = "user-1", role = "user", text = "hello")
    val assistant = textMessage(id = "assistant-1", role = "assistant", text = "done")
    val timeline =
      buildChatTimeline(
        messages = listOf(user, assistant),
        pendingRunCount = 0,
        pendingToolCalls = emptyList(),
        streamingAssistantText = null,
      )

    val withRecap = timeline.withTurnRecap(TurnRecap(runtimeMs = 2_000L, outputTokens = 10L))

    assertEquals(
      listOf("turn-recap", "message:assistant-1", "message:user-1"),
      withRecap.items.map(::chatTimelineItemKey),
    )
    assertEquals(0, withRecap.latestContentIndex)
    assertEquals(2, withRecap.readAnchorIndex)
    assertEquals("user-1", withRecap.latestUserMessageId)
  }

  @Test
  fun emptyTimelineHasNoScrollTarget() {
    val timeline =
      buildChatTimeline(
        messages = emptyList(),
        pendingRunCount = 0,
        pendingToolCalls = emptyList(),
        streamingAssistantText = null,
      )

    assertEquals(emptyList<String>(), timeline.items.map(::chatTimelineItemKey))
    assertEquals(null, timeline.readAnchorIndex)
    assertEquals(null, timeline.latestContentIndex)
    assertEquals(null, timeline.latestUserMessageId)
  }

  @Test
  fun outboxRowsHideOnceTheirUserTurnIsVisibleAsAMessage() {
    val visible =
      ChatOutboxItem(
        id = "visible-row",
        sessionKey = "main",
        text = "still queued",
        thinkingLevel = "off",
        createdAtMs = 1,
        status = ChatOutboxStatus.Queued,
        retryCount = 0,
        lastError = null,
        ownerAgentId = "main",
      )
    val consumed =
      visible.copy(
        id = "consumed-row",
        status = ChatOutboxStatus.Accepted,
        createdAtMs = 2,
      )
    val optimisticCopy =
      textMessage(id = "m1", role = "user", text = "sent already")
        .copy(idempotencyKey = "consumed-row:user")

    val filtered =
      outboxItemsForSession(
        items = listOf(visible, consumed),
        sessionKey = "main",
        mainSessionKey = "agent:work:main",
        ownerAgentId = "main",
        messages = listOf(optimisticCopy),
      )

    // A row whose turn already renders as a message never shows a second bubble.
    assertEquals(listOf("visible-row"), filtered.map { it.id })
  }

  @Test
  fun outboxRowsStayWithTheirAgentOwner() {
    val mainOwner =
      ChatOutboxItem(
        id = "main-row",
        sessionKey = "shared",
        text = "main",
        thinkingLevel = "off",
        createdAtMs = 1,
        status = ChatOutboxStatus.Queued,
        retryCount = 0,
        lastError = null,
        ownerAgentId = "main",
      )
    val otherOwner = mainOwner.copy(id = "other-row", text = "other", ownerAgentId = "other")
    val migratedOwnerless = mainOwner.copy(id = "legacy-row", text = "legacy", ownerAgentId = null)

    val filtered =
      outboxItemsForSession(
        items = listOf(mainOwner, otherOwner, migratedOwnerless),
        sessionKey = "shared",
        mainSessionKey = "agent:main:device",
        ownerAgentId = "main",
      )

    assertEquals(listOf("main-row"), filtered.map { it.id })
  }

  @Test
  fun unreachableRowsRenderOnlyInTheNeutralRecoverySection() {
    val ownerless =
      ChatOutboxItem(
        id = "legacy-row",
        sessionKey = "shared",
        text = "legacy private text",
        thinkingLevel = "off",
        createdAtMs = 1,
        status = ChatOutboxStatus.Failed,
        retryCount = 0,
        lastError = "owner unknown",
        ownerAgentId = null,
      )
    assertEquals(listOf(ownerless), outboxItemsForRecovery(listOf(ownerless)))

    val timeline =
      buildChatTimeline(
        messages = emptyList(),
        pendingRunCount = 0,
        pendingToolCalls = emptyList(),
        streamingAssistantText = null,
        recoveryOutboxItems = listOf(ownerless),
      )

    assertEquals(
      listOf("outbox-recovery:legacy-row", "outbox-recovery-header"),
      timeline.items.map(::chatTimelineItemKey),
    )
  }

  @Test
  fun parkedMainAliasRowRemainsReachableForRecovery() {
    val captured =
      ChatOutboxItem(
        id = "captured-main",
        sessionKey = "main",
        text = "park me",
        thinkingLevel = "off",
        createdAtMs = 1,
        status = ChatOutboxStatus.Failed,
        retryCount = 0,
        lastError = OUTBOX_OWNER_CHANGED_ERROR,
        ownerAgentId = "agent-a",
      )

    assertEquals(listOf(captured), outboxItemsForRecovery(listOf(captured)))
    assertTrue(
      outboxItemsForSession(
        items = listOf(captured),
        sessionKey = "main",
        mainSessionKey = "agent:agent-a:device",
        ownerAgentId = "agent-a",
      ).isEmpty(),
    )
  }

  @Test
  fun validForeignMainAliasRowStaysHiddenUntilItsCapturedOwnerIsCurrent() {
    val captured =
      ChatOutboxItem(
        id = "captured-main",
        sessionKey = "main",
        text = "keep private",
        thinkingLevel = "off",
        createdAtMs = 1,
        status = ChatOutboxStatus.Queued,
        retryCount = 0,
        lastError = null,
        ownerAgentId = "agent-a",
      )

    assertTrue(outboxItemsForRecovery(listOf(captured)).isEmpty())
  }

  @Test
  fun foreignCustomAliasRowStaysHiddenUntilItsCapturedOwnerIsCurrent() {
    val captured =
      ChatOutboxItem(
        id = "captured-custom",
        sessionKey = "custom-alias",
        text = "park me",
        thinkingLevel = "off",
        createdAtMs = 1,
        status = ChatOutboxStatus.Failed,
        retryCount = 0,
        lastError = "owner changed",
        ownerAgentId = "agent-a",
      )

    assertTrue(outboxItemsForRecovery(listOf(captured)).isEmpty())
  }

  @Test
  fun agentQualifiedRowMovesToRecoveryWhenItsCapturedOwnerDisagrees() {
    val mismatched =
      ChatOutboxItem(
        id = "mismatched-owner",
        sessionKey = "agent:agent-b:device",
        text = "park me",
        thinkingLevel = "off",
        createdAtMs = 1,
        status = ChatOutboxStatus.Failed,
        retryCount = 0,
        lastError = "owner changed",
        ownerAgentId = "agent-a",
      )

    assertEquals(listOf(mismatched), outboxItemsForRecovery(listOf(mismatched)))
  }

  @Test
  fun subagentRowsStayKeyedByTaskAndParticipateInLiveContentVersion() {
    val activity = subagentActivity(id = "task-1", snippet = "Reading files", added = 2)
    val first =
      buildChatTimeline(
        messages = emptyList(),
        pendingRunCount = 0,
        pendingToolCalls = emptyList(),
        streamingAssistantText = null,
        subagentActivities = mapOf(activity.id to activity),
      )
    val updated = activity.copy(snippet = "Editing files", diffStat = ChatDiffStat(added = 8, removed = 3, files = 2))
    val second =
      buildChatTimeline(
        messages = emptyList(),
        pendingRunCount = 0,
        pendingToolCalls = emptyList(),
        streamingAssistantText = null,
        subagentActivities = mapOf(updated.id to updated),
      )

    assertEquals(listOf("subagent-activity"), first.items.map(::chatTimelineItemKey))
    assertEquals(first.items.map(::chatTimelineItemKey), second.items.map(::chatTimelineItemKey))
    assertTrue(first.latestContentVersion != second.latestContentVersion)
  }

  @Test
  fun subagentRowsCapAtFiveAndOverflowCountsOnlyHiddenWorkingRows() {
    val working = (1..6).map { index -> subagentActivity(id = "task-$index", startedAtMs = index.toLong()) }
    val queued = subagentActivity(id = "task-queued", status = "queued", startedAtMs = 100)
    val finished = subagentActivity(id = "task-finished", status = "completed", startedAtMs = 0, endedAtMs = 20)

    val timeline =
      buildChatTimeline(
        messages = emptyList(),
        pendingRunCount = 0,
        pendingToolCalls = listOf(ChatPendingToolCall(toolCallId = "tool-1", name = "edit", startedAtMs = 1)),
        streamingAssistantText = null,
        subagentActivities = (working + queued + finished).associateBy(ChatSubagentActivity::id),
      )

    assertEquals(
      listOf("tools", "subagent-activity"),
      timeline.items.map(::chatTimelineItemKey),
    )
    val row = timeline.items.filterIsInstance<ChatTimelineItem.SubagentActivity>().single()
    assertEquals(listOf("task-1", "task-2", "task-3", "task-4", "task-5"), row.activities.map { it.id })
    assertEquals(1, row.moreWorkingCount)
  }

  @Test
  fun liveToolDiffChangesTimelineContentVersion() {
    val pending = ChatPendingToolCall(toolCallId = "tool-1", name = "edit", startedAtMs = 1)
    val initial =
      buildChatTimeline(
        messages = emptyList(),
        pendingRunCount = 0,
        pendingToolCalls = listOf(pending),
        streamingAssistantText = null,
      )
    val updated =
      buildChatTimeline(
        messages = emptyList(),
        pendingRunCount = 0,
        pendingToolCalls = listOf(pending.copy(liveDiff = ChatDiffStat(added = 4, removed = 1))),
        streamingAssistantText = null,
      )

    assertEquals(initial.items.map(::chatTimelineItemKey), updated.items.map(::chatTimelineItemKey))
    assertTrue(initial.latestContentVersion != updated.latestContentVersion)
  }

  private fun subagentActivity(
    id: String,
    status: String = "running",
    snippet: String? = null,
    added: Int = 0,
    startedAtMs: Long = 1,
    endedAtMs: Long? = null,
  ): ChatSubagentActivity =
    ChatSubagentActivity(
      id = id,
      status = status,
      snippet = snippet,
      diffStat = ChatDiffStat(added = added, removed = 0, files = 1),
      terminalSummary = null,
      error = null,
      startedAtMs = startedAtMs,
      endedAtMs = endedAtMs,
      childSessionKey = "agent:worker:subagent:$id",
    )

  private fun textMessage(
    id: String,
    role: String,
    text: String,
  ): ChatMessage =
    ChatMessage(
      id = id,
      role = role,
      content = listOf(ChatMessageContent(type = "text", text = text)),
      timestampMs = null,
    )
}
