package ai.openclaw.app.chat

/**
 * History owns attribution: preserve exact session/entry matches and capture only the newest
 * successful final inside its authoritative run interval. Never search backward for an answer
 * when the terminal row is a tool, commentary, error, synthetic mirror, or media-only reply.
 */
internal fun ChatHistory.withReplyMetrics(previous: List<ChatMessage>): ChatHistory {
  val sid = sessionId?.takeIf(String::isNotBlank) ?: return copy(messages = messages.map { it.copy(replyMetrics = null) })
  val retained = previous.mapNotNull { it.replyMetrics }.filter { it.sessionId == sid }.associateBy { it.entryId }
  var annotated =
    messages.map { message ->
      message.copy(replyMetrics = retained[message.entryId].takeIf { message.isReplyMetricsAnswer() })
    }
  val row = sessionInfo
  val startedAt = row?.startedAt
  val endedAt = row?.endedAt
  val runtimeMs = row?.runtimeMs
  val final = annotated.lastOrNull()
  val timestamp = final?.timestampMs
  if (
    inFlightRun == null && row?.hasActiveRun != true && row?.status == "done" &&
    (row.sessionId == null || row.sessionId == sid) &&
    startedAt != null && endedAt != null && endedAt >= startedAt && runtimeMs != null && runtimeMs >= 0 &&
    final != null && final.isReplyMetricsAnswer() &&
    !final.entryId.isNullOrBlank() && timestamp != null && timestamp in startedAt..endedAt &&
    final.replyMetrics == null && retained.values.none { it.endedAt == endedAt && it.entryId != final.entryId }
  ) {
    annotated = annotated.dropLast(1) +
      final.copy(
        replyMetrics = ChatReplyMetrics(sid, final.entryId, endedAt, runtimeMs, row.outputTokens?.takeIf { it >= 0 }),
      )
  }
  return copy(messages = annotated)
}

private fun ChatMessage.isReplyMetricsAnswer(): Boolean =
  role == "assistant" && !isForwardedBoundary() && !isSyntheticDisplay && !isError && !isTranscriptOnlyOpenClawAssistant() &&
    (phase == null || phase == "final_answer") &&
    content.none { it.toolActivity != null || it.type in setOf("toolCall", "tool_call", "tool_use", "toolResult", "tool_result") } &&
    content.any { it.type == "text" && !it.text.isNullOrBlank() }
