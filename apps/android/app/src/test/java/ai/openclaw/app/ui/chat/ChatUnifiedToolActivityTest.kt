package ai.openclaw.app.ui.chat

import ai.openclaw.app.chat.ChatAgentActivity
import ai.openclaw.app.chat.ChatDiffStat
import ai.openclaw.app.chat.ChatMessage
import ai.openclaw.app.chat.ChatMessageContent
import ai.openclaw.app.chat.ChatPendingToolCall
import ai.openclaw.app.chat.ChatToolActivity
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
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

  @Test fun dispatcherLiveRowsUnwrapWithoutRewritingPendingCallsOrKeys() {
    val args = Json.parseToJsonElement("""{"id":"web_search","args":{"query":"OpenClaw release notes October 2026"}}""").jsonObject
    val call = first.copy(name = "tool_call", args = args)
    val group = timeline(listOf(user), listOf(call)).items.filterIsInstance<ChatTimelineItem.ToolActivity>().single()
    val tool = group.tools.single()
    assertEquals("web_search", tool.name)
    assertEquals("Web Search", completedToolDisplayName(tool.name))
    assertEquals(args["args"], tool.arguments)
    assertEquals(call.toolCallId, tool.toolCallId)
    assertEquals(listOf("run:read"), group.toolKeys)
    assertEquals(call, group.liveTools.values.single())
    assertEquals("tool_call", call.name)
    assertEquals(args, call.args)
  }

  @Test fun liveDispatcherArgumentsFillMissingHistoryArguments() {
    val args = Json.parseToJsonElement("""{"id":"client:client:exec","args":{"command":"printf ready"}}""").jsonObject
    val call = first.copy(name = "tool_call", args = args)
    val history = result("read").copy(content = listOf(ChatMessageContent(type = "toolResult", toolActivity = ChatToolActivity("read", "exec", null, "ready", false))))
    val group = timeline(listOf(user, history), listOf(call)).items.filterIsInstance<ChatTimelineItem.ToolActivity>().single()
    val tool = group.tools.single()
    assertEquals(args["args"], tool.arguments)
    assertEquals("printf ready", completedCommandText(tool))
    assertEquals("ready", tool.result)
    assertEquals(call.copy(isComplete = true), group.liveTools.values.single())
  }

  @Test fun liveDispatcherDiscardsNonObjectInnerArguments() {
    for (inner in listOf("", ",\"args\":null", ",\"args\":[]", ",\"args\":\"input\"", ",\"args\":3")) {
      val call = first.copy(name = "tool_call", args = Json.parseToJsonElement("""{"id":"web_search"$inner}""").jsonObject)
      val tool =
        timeline(listOf(user), listOf(call))
          .items
          .filterIsInstance<ChatTimelineItem.ToolActivity>()
          .single()
          .tools
          .single()
      assertEquals("web_search", tool.name)
      assertEquals(JsonObject(emptyMap()), tool.arguments)
    }
  }

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

  @Test fun latePreparedOutcomeControlsVisibilityOutsideFoldedCompletedWork() {
    val answer = ChatMessage("answer", "assistant", listOf(ChatMessageContent(text = "Done")), 4, runId = "run")
    for ((status, visible) in listOf("blocked" to true, "failed" to true, "skipped" to false, "completed" to false, null to false)) {
      val activity = ChatAgentActivity("tool:read", "tool", "end", "Read project", toolCallId = "read", status = status)
      val rows = timeline(listOf(user.copy(runId = "run"), result("read"), answer), listOf(first.copy(activity = activity, isError = true, isComplete = true)), runs = 0).items
      assertEquals(1, rows.filterIsInstance<ChatTimelineItem.WorkedSummary>().size)
      val tools = rows.filterIsInstance<ChatTimelineItem.ToolActivity>().flatMap { it.tools }
      assertEquals("status=$status", if (visible) 1 else 0, tools.size)
      if (visible) {
        assertEquals(status, tools.single().activity?.status)
        assertEquals("output", tools.single().result)
      }
    }
  }
}
