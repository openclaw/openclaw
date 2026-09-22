package ai.openclaw.app.ui.chat

import ai.openclaw.app.chat.ChatAgentActivity
import ai.openclaw.app.chat.ChatDiffStat
import ai.openclaw.app.chat.ChatMessage
import ai.openclaw.app.chat.ChatMessageContent
import ai.openclaw.app.chat.ChatPendingToolCall
import ai.openclaw.app.chat.ChatToolActivity
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ChatUnifiedToolActivityTest {
  private val user = ChatMessage("user", "user", listOf(ChatMessageContent(text = "Check the project")), 0)
  private val first = ChatPendingToolCall("read", "read", startedAtMs = 1, liveDiff = ChatDiffStat(3, 1), runId = "run")
  private val second = ChatPendingToolCall("exec", "exec", startedAtMs = 2, runId = "run")

  private fun result(
    id: String,
    run: String = "run",
    output: String = "output",
  ): ChatMessage = ChatMessage("result-$run-$id", "toolresult", listOf(ChatMessageContent(type = "toolResult", toolActivity = ChatToolActivity(id, id, null, output, false))), 3, runId = run)

  private fun timeline(
    messages: List<ChatMessage>,
    calls: List<ChatPendingToolCall>,
    runs: Int = 1,
  ): ChatTimeline = prepareChatHistory(messages, "agent:main:dashboard:tools", "agent:main:main").buildTimeline(runs, calls, null)

  @Test fun liveAndPartialHistoryHaveOneStableDisclosureWithDurableOutputAndLiveDiff() {
    val live = timeline(listOf(user), listOf(first, second)).items.filterIsInstance<ChatTimelineItem.ToolActivity>().single()
    val partial = timeline(listOf(user, result("read")), listOf(second, first.copy(isComplete = true))).items.filterIsInstance<ChatTimelineItem.ToolActivity>().single()
    val complete = timeline(listOf(user, result("read"), result("exec")), emptyList()).items.filterIsInstance<ChatTimelineItem.ToolActivity>().single()
    assertEquals(chatTimelineItemKey(live), chatTimelineItemKey(partial))
    assertEquals(chatTimelineItemKey(live), chatTimelineItemKey(complete))
    assertEquals(listOf("read", "exec"), partial.tools.map { it.toolCallId })
    assertEquals(listOf("read", "exec"), complete.tools.map { it.toolCallId })
    assertEquals("output", partial.tools.first().result)
    assertEquals(ChatDiffStat(3, 1), partial.liveTools.getValue(partial.toolKeys.first()).liveDiff)
    assertEquals(live.toolKeys, partial.toolKeys)
    assertEquals(live.toolKeys, complete.toolKeys)
  }

  @Test fun commentaryDoesNotCreateASecondDisclosureOrLoseText() {
    val commentary = ChatMessage("commentary", "assistant", listOf(ChatMessageContent(text = "Now testing")), 2, phase = "commentary")
    val rows = timeline(listOf(user, result("read"), commentary, result("exec")), listOf(first, second)).items
    assertEquals(1, rows.filterIsInstance<ChatTimelineItem.ToolActivity>().size)
    assertTrue(rows.filterIsInstance<ChatTimelineItem.Message>().any { it.message == commentary })
  }

  @Test fun reusedCallIdsRemainDistinctAcrossRunsAndTurns() {
    val nextUser = user.copy(id = "next", timestampMs = 5)
    val rows = timeline(listOf(user, result("read"), nextUser, result("read", "next-run", "next-output")), listOf(first.copy(runId = "next-run"))).items.filterIsInstance<ChatTimelineItem.ToolActivity>()
    assertEquals(2, rows.size)
    assertEquals(listOf("next-output", "output"), rows.map { it.tools.single().result })
    assertTrue(rows.last().liveTools.isEmpty())
    val sameTurn = timeline(listOf(user, result("read"), result("read", "parallel", "parallel-output")), listOf(first)).items.filterIsInstance<ChatTimelineItem.ToolActivity>().single()
    assertEquals(2, sameTurn.toolKeys.toSet().size)
    assertEquals(listOf("output", "parallel-output"), sameTurn.tools.map { it.result })
  }

  @Test fun terminalBeforeHistoryKeepsTheRowWithoutClaimingItIsRunning() {
    val bridge = LiveToolActivityBridge()
    val before = bridge.update("turn", listOf(first))
    val gap = bridge.update("turn", emptyList())
    assertFalse(before.single().isComplete)
    assertTrue(gap.single().isComplete)
    assertEquals(first.toolCallId, gap.single().toolCallId)
    assertTrue(bridge.update("next-turn", emptyList()).isEmpty())
  }

  @Test fun completedWorkDoesNotReappearAsALiveDuplicate() {
    val answer = ChatMessage("answer", "assistant", listOf(ChatMessageContent(text = "Done")), 4, runId = "run")
    val rows = timeline(listOf(user, result("read"), answer), listOf(first.copy(isComplete = true)), runs = 0).items
    assertEquals(1, rows.filterIsInstance<ChatTimelineItem.WorkedSummary>().size)
    assertTrue(rows.filterIsInstance<ChatTimelineItem.ToolActivity>().isEmpty())
  }

  @Test fun acknowledgementRekeyDoesNotRetainTheProvisionalRow() {
    val bridge = LiveToolActivityBridge()
    bridge.update("turn", listOf(first.copy(runId = "provisional", presentationId = "original-read")))
    val canonical = bridge.update("turn", listOf(first.copy(runId = "canonical", presentationId = "original-read")))
    assertEquals(listOf(first.copy(runId = "canonical", presentationId = "original-read")), canonical)
  }

  @Test fun laterResultArrivingFirstDoesNotReorderRunningRows() {
    val group = timeline(listOf(user, result("exec")), listOf(first, second.copy(isComplete = true))).items.filterIsInstance<ChatTimelineItem.ToolActivity>().single()
    assertEquals(listOf("read", "exec"), group.tools.map { it.toolCallId })
    assertEquals("output", group.tools.last().result)
  }

  @Test fun olderLiveRunDoesNotMoveUnderANewerPrompt() {
    val firstUser = user.copy(runId = "run")
    val nextUser = user.copy(id = "next-user", runId = "next-run", timestampMs = 4)
    val rows = timeline(listOf(firstUser, result("read"), nextUser), listOf(first)).items.filterIsInstance<ChatTimelineItem.ToolActivity>()
    assertEquals(1, rows.size)
    assertEquals("user", rows.single().disclosureKey)
    assertEquals(
      "output",
      rows
        .single()
        .tools
        .single()
        .result,
    )
    assertEquals(
      first,
      rows
        .single()
        .liveTools.values
        .single()
        .copy(isComplete = false),
    )
  }

  @Test fun newerBlockedActivityIsVisibleEvenWhenHistoryPreparedAnEmptyActivityList() {
    val blocked = ChatAgentActivity("tool:read", "tool", "end", "Read project", toolCallId = "read", status = "blocked")
    val group = timeline(listOf(user, result("read").copy(activity = emptyList())), listOf(first.copy(activity = blocked, isComplete = true))).items.filterIsInstance<ChatTimelineItem.ToolActivity>().single()
    assertEquals(
      "blocked",
      group.tools
        .single()
        .activity
        ?.status,
    )
    assertEquals("output", group.tools.single().result)
  }

  @Test fun identicalCallIdsAndTimestampsFromDifferentRunsAreNotTreatedAsAliases() {
    val bridge = LiveToolActivityBridge()
    val parallel = first.copy(runId = "parallel", presentationId = "parallel:read")
    val original = first.copy(presentationId = "run:read")
    bridge.update("turn", listOf(original, parallel))
    val retired = bridge.update("turn", listOf(parallel))
    assertEquals(2, retired.size)
    assertTrue(retired.single { it.runId == "run" }.isComplete)
    assertFalse(retired.single { it.runId == "parallel" }.isComplete)
  }

  @Test fun delayedResultDoesNotTransferAnOlderRunToTheNewestPrompt() {
    val call = result("read").copy(id = "call", role = "assistant", content = listOf(ChatMessageContent(type = "toolCall", toolActivity = ChatToolActivity("read", "read", "README.md", null, false))))
    val next = user.copy(id = "next-user", runId = "next-run", timestampMs = 4)
    val rows = timeline(listOf(user.copy(runId = "run"), call, next, result("read")), listOf(first)).items.filterIsInstance<ChatTimelineItem.ToolActivity>()
    assertEquals(1, rows.size)
    assertEquals("user", rows.single().disclosureKey)
    assertEquals(listOf("output"), rows.single().tools.map { it.result })
  }

  @Test fun lateBlockedActivityRemainsVisibleOutsideFoldedCompletedWork() {
    val answer = ChatMessage("answer", "assistant", listOf(ChatMessageContent(text = "Done")), 4, runId = "run")
    val blocked = ChatAgentActivity("tool:read", "tool", "end", "Read project", toolCallId = "read", status = "blocked")
    val rows = timeline(listOf(user.copy(runId = "run"), result("read"), answer), listOf(first.copy(activity = blocked, isComplete = true)), runs = 0).items
    assertEquals(1, rows.filterIsInstance<ChatTimelineItem.WorkedSummary>().size)
    val tool =
      rows
        .filterIsInstance<ChatTimelineItem.ToolActivity>()
        .single()
        .tools
        .single()
    assertEquals("blocked", tool.activity?.status)
    assertEquals("output", tool.result)
  }
}
