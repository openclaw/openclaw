package ai.openclaw.app.chat

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class ChatReplyMetricsTest {
  private fun answer(
    id: String,
    time: Long,
  ) = ChatMessage(
    id = id,
    entryId = id,
    role = "assistant",
    content = listOf(ChatMessageContent(text = "answer $id")),
    timestampMs = time,
    phase = "final_answer",
  )

  private fun history(
    messages: List<ChatMessage>,
    start: Long = 100,
    end: Long = 200,
  ) = ChatHistory(
    sessionKey = "agent:main:chat",
    sessionId = "transcript-one",
    thinkingLevel = null,
    messages = messages,
    sessionInfo =
      ChatSessionEntry(
        key = "agent:main:chat",
        updatedAtMs = end,
        status = "done",
        startedAt = start,
        endedAt = end,
        runtimeMs = end - start,
        outputTokens = 42,
      ),
  )

  @Test
  fun twoFinalsKeepIndependentMetricsAcrossRefreshAndFollowingActiveRun() {
    val first = history(listOf(answer("a", 190))).withReplyMetrics(emptyList())
    val second = history(listOf(answer("a", 190), answer("b", 490)), 300, 500).withReplyMetrics(first.messages)
    assertEquals(listOf(100L, 200L), second.messages.map { it.replyMetrics?.runtimeMs })
    val thirdRunning =
      second
        .copy(
          messages = second.messages.map { it.copy(replyMetrics = null) } + answer("c", 590).copy(phase = "commentary"),
          sessionInfo = second.sessionInfo!!.copy(status = "running", startedAt = 550, endedAt = null, runtimeMs = null),
          inFlightRun = ChatInFlightRun("third", "working"),
        ).withReplyMetrics(second.messages)
    assertEquals(listOf(100L, 200L, null), thirdRunning.messages.map { it.replyMetrics?.runtimeMs })
    val missingRow = thirdRunning.copy(sessionInfo = null).withReplyMetrics(second.messages)
    assertEquals(thirdRunning.messages, missingRow.messages)
  }

  @Test
  fun missingIdentityFailedActiveStaleAndNonfinalSnapshotsCannotAcquireMetrics() {
    val base = history(listOf(answer("a", 190)))
    val variants =
      listOf(
        base.copy(sessionId = null),
        base.copy(sessionInfo = base.sessionInfo!!.copy(sessionId = "different-transcript")),
        base.copy(messages = listOf(answer("a", 190).copy(entryId = null))),
        base.copy(sessionInfo = base.sessionInfo.copy(status = "failed")),
        base.copy(sessionInfo = base.sessionInfo.copy(hasActiveRun = true)),
        base.copy(inFlightRun = ChatInFlightRun("new", "working")),
        history(listOf(answer("old", 90))),
        history(listOf(answer("future", 210))),
        base.copy(messages = listOf(answer("a", 190).copy(phase = "commentary"))),
        base.copy(messages = listOf(answer("a", 190).copy(isSyntheticDisplay = true))),
      )
    variants.forEach {
      assertNull(
        it
          .withReplyMetrics(emptyList())
          .messages
          .single()
          .replyMetrics,
      )
    }
  }

  @Test
  fun terminalNonAnswersNeverBorrowEarlierFinalOrKeepStaleMetrics() {
    val final = answer("a", 190)
    val captured = history(listOf(final)).withReplyMetrics(emptyList()).messages
    val rejected =
      listOf(
        final.copy(isError = true),
        final.copy(provenance = ChatMessageProvenance("inter_session", "sessions_send")),
        final.copy(isSyntheticDisplay = true),
        final.copy(provider = "openclaw", model = "delivery-mirror"),
        final.copy(phase = "commentary"),
        final.copy(content = listOf(ChatMessageContent(type = "image", url = "https://example.invalid/image"))),
        final.copy(content = listOf(ChatMessageContent(type = "toolCall", text = "tool"), ChatMessageContent(text = "working"))),
        final.copy(role = "toolResult"),
      )
    rejected.forEach { terminal ->
      val messages = listOf(answer("older", 180), terminal)
      assertEquals(listOf(null, null), history(messages).withReplyMetrics(captured).messages.map { it.replyMetrics })
    }
  }

  @Test
  fun resetAndRewindDoNotTransferMetricsToAnUnrelatedEntry() {
    val first = history(listOf(answer("a", 190))).withReplyMetrics(emptyList())
    val reset = first.copy(sessionId = "transcript-two", sessionInfo = null).withReplyMetrics(first.messages)
    assertNull(reset.messages.single().replyMetrics)
    val differentEntrySameTime = history(listOf(answer("other", 190))).withReplyMetrics(first.messages)
    assertNull(differentEntrySameTime.messages.single().replyMetrics)
  }
}
