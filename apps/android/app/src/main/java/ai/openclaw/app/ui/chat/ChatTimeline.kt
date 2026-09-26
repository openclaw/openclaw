package ai.openclaw.app.ui.chat

import ai.openclaw.app.chat.ChatMessage
import ai.openclaw.app.chat.ChatMessageContent
import ai.openclaw.app.chat.ChatOutboxItem
import ai.openclaw.app.chat.ChatOutboxStatus
import ai.openclaw.app.chat.ChatPendingToolCall
import ai.openclaw.app.chat.ChatQuestionPrompt
import ai.openclaw.app.chat.ChatToolActivity
import ai.openclaw.app.chat.OUTBOX_OWNER_CHANGED_ERROR
import ai.openclaw.app.i18n.nativeString
import ai.openclaw.app.resolveAgentIdFromMainSessionKey

internal sealed class ChatTimelineItem {
  data class Message(
    val message: ChatMessage,
    val turnBoundary: Boolean = message.turnBoundary,
    /** Resolved separately so full-message reads retain the original call blocks. */
    val hasUnresolvedTools: Boolean = false,
    val knownRunIds: Set<String> = message.runId?.let { setOf(it) }.orEmpty(),
  ) : ChatTimelineItem()

  /** Durable queued/failed offline command shown below the transcript until acked or deleted. */
  data class OutboxCommand(
    val item: ChatOutboxItem,
  ) : ChatTimelineItem()

  /** Gateway-level recovery row that cannot be placed in the visible owner/session. */
  data class RecoveryOutboxCommand(
    val item: ChatOutboxItem,
  ) : ChatTimelineItem()

  data class OutboxRecoveryHeader(
    val count: Int,
  ) : ChatTimelineItem()

  data class StreamingAssistant(
    val text: String,
  ) : ChatTimelineItem()

  data class ToolActivity(
    val key: String,
    val tools: List<ChatToolActivity>,
    val turnBoundary: Boolean = false,
    /** Results render at the call, but only a later source answer can cover a failure. */
    val lastFailureMessageIndex: Int = -1,
    val hasUnresolvedTools: Boolean = false,
    val knownRunIds: Set<String> = emptySet(),
    val disclosureKey: String = key,
    val toolKeys: List<String> = tools.mapIndexed { index, tool -> tool.toolCallId ?: "anonymous:$index" },
    val liveTools: Map<String, ChatPendingToolCall> = emptyMap(),
    val settledToolKeys: Set<String> = emptySet(),
  ) : ChatTimelineItem()


  data class QuestionPrompt(
    val prompt: ChatQuestionPrompt,
  ) : ChatTimelineItem()

  data class WorkedSummary(
    val key: String,
    val durationMs: Long?,
    val expanded: Boolean,
    val outcomes: Map<WorkedToolOutcome, Int>,
  ) : ChatTimelineItem()

  data class TurnRecapSummary(
    val recap: TurnRecap,
  ) : ChatTimelineItem()

  data class SystemNotice(
    val key: String,
    val label: String,
    val body: String,
  ) : ChatTimelineItem()

  data class SystemDivider(
    val key: String,
    val kind: SystemDividerKind,
    val label: String,
    val metric: String? = null,
    val secondary: String? = null,
  ) : ChatTimelineItem()

  object Thinking : ChatTimelineItem()
}

internal enum class SystemDividerKind {
  Compaction,
  Reset,
}

internal data class ChatTimeline(
  val items: List<ChatTimelineItem>,
  val readAnchorIndex: Int?,
  val latestContentIndex: Int?,
  val latestUserMessageId: String?,
  val latestUserMessageVersion: String?,
  val latestContentVersion: String,
)

internal data class PreparedChatHistory(
  val rows: List<ChatTimelineItem>,
  val latestUserMessageId: String?,
  val latestUserMessageVersion: String?,
  val rawHistoryVersionPrefix: String,
  val workSpans: List<PreparedChatWorkSpan>,
  val toolScope: String,
  val toolScopesByRun: Map<String, String>,
)

internal fun prepareChatHistory(
  messages: List<ChatMessage>,
  sessionKey: String,
  mainSessionKey: String,
): PreparedChatHistory {
  val toolScopes = toolScopes(messages)
  val rows = buildTranscriptTimeline(messages, toolScopes)
  val latestUser =
    rows.asReversed().firstNotNullOfOrNull { item ->
      (item as? ChatTimelineItem.Message)?.message?.takeIf {
        it.role.trim().equals("user", ignoreCase = true)
      }
    }
  val latest = messages.lastOrNull()
  return PreparedChatHistory(
    rows = rows,
    latestUserMessageId = latestUser?.id,
    latestUserMessageVersion = latestUser?.let(::stableMessageVersion),
    rawHistoryVersionPrefix =
      buildString {
        append(messages.size)
        append(':')
        append(latest?.id.orEmpty())
        append(':')
        append(latest?.role.orEmpty())
        append(':')
        append(latest?.timestampMs ?: "")
        latest?.content?.forEach { appendContentVersion(it) }
        append(latest?.activity)
        append(":turnBoundary=")
        append(latest?.turnBoundary ?: false)
      },
    workSpans = prepareCompletedWorkSpans(rows, messages, sessionKey, mainSessionKey),
    toolScope = messages.indexOfLast { it.startsToolScope() }.takeIf { it >= 0 }?.let { toolScopes[it] } ?: "root",
    toolScopesByRun = messages.mapIndexedNotNull { index, message -> message.runId?.let { it to toolScopes[index] } }.distinctBy { it.first }.toMap(),
  )
}

internal fun PreparedChatHistory.buildTimeline(
  pendingRunCount: Int,
  pendingToolCalls: List<ChatPendingToolCall>,
  streamingAssistantText: String?,
  outboxItems: List<ChatOutboxItem> = emptyList(),
  recoveryOutboxItems: List<ChatOutboxItem> = emptyList(),
  questions: List<ChatQuestionPrompt> = emptyList(),
  expandedWorkKeys: Set<String> = emptySet(),
  activeRunId: String? = null,
): ChatTimeline {
  val stream = streamingAssistantText?.trim()?.takeIf { it.isNotEmpty() }
  val latestTurnLive = pendingRunCount > 0 || pendingToolCalls.any { !it.isComplete } || stream != null
  val sourceItems =
    buildList {
      // reverseLayout: index 0 renders bottom-most; queued commands are the newest user input.
      questions.asReversed().forEach { prompt -> add(ChatTimelineItem.QuestionPrompt(prompt)) }
      outboxItems.asReversed().forEach { item -> add(ChatTimelineItem.OutboxCommand(item)) }
      recoveryOutboxItems.asReversed().forEach { item -> add(ChatTimelineItem.RecoveryOutboxCommand(item)) }
      if (recoveryOutboxItems.isNotEmpty()) add(ChatTimelineItem.OutboxRecoveryHeader(recoveryOutboxItems.size))
      if (stream != null) add(ChatTimelineItem.StreamingAssistant(stream))
      if (pendingRunCount > 0) add(ChatTimelineItem.Thinking)
      var rowIndex = rows.lastIndex
      var spanIndex = workSpans.lastIndex
      while (rowIndex >= 0) {
        val span = workSpans.getOrNull(spanIndex)
        if (span != null && rowIndex == span.endExclusive - 1) {
          val live =
            (span.inLatestTurn && latestTurnLive) || (span.inLatestRunChain && pendingRunCount > 0) ||
              activeRunId?.let { (span.runLastTurnIndexes[it] ?: -1) >= span.turnIndex } == true
          if (live) {
            for (index in rowIndex downTo span.start) add(rows[index])
          } else {
            span.preservedRowIndexes.asReversed().forEach { add(rows[it]) }
            if (span.key in expandedWorkKeys) span.workRowIndexes.asReversed().forEach { add(rows[it]) }
            add(ChatTimelineItem.WorkedSummary(span.key, span.durationMs, span.key in expandedWorkKeys, span.outcomes))
          }
          rowIndex = span.start - 1
          spanIndex--
        } else {
          add(rows[rowIndex--])
        }
      }
    }
  val items = projectToolActivity(sourceItems, rows, pendingToolCalls, toolScope, toolScopesByRun)
  val latestUserIndex = items.indexOfFirst { it is ChatTimelineItem.Message && it.message.id == latestUserMessageId }.takeIf { it >= 0 }
  if (items.isEmpty()) {
    return ChatTimeline(
      items = items,
      readAnchorIndex = null,
      latestContentIndex = null,
      latestUserMessageId = null,
      latestUserMessageVersion = null,
      latestContentVersion = "",
    )
  }

  val latestContentIndex = 0
  // In reverseLayout, index 0 is bottom-most. Keep the latest prompt as a stable
  // reader anchor even after streaming rows collapse into a finished reply.
  val readAnchorIndex = latestUserIndex ?: latestContentIndex

  return ChatTimeline(
    items = items,
    readAnchorIndex = readAnchorIndex,
    latestContentIndex = latestContentIndex,
    latestUserMessageId = latestUserMessageId,
    latestUserMessageVersion = latestUserMessageVersion,
    latestContentVersion =
      latestContentVersion(
        rawHistoryVersionPrefix,
        pendingRunCount,
        pendingToolCalls,
        stream,
        outboxItems + recoveryOutboxItems,
        questions,
      ),
  )
}

// Gateway projects sessions_send user inputs as assistant rows; they still start a new turn.
internal fun ChatMessage.isForwardedBoundary(): Boolean =
  role.trim().equals("assistant", ignoreCase = true) &&
    provenance?.kind == "inter_session" && provenance.sourceTool == "sessions_send"

/** Build transcript rows in source order so hidden turn boundaries fence tool groups. */
private fun buildTranscriptTimeline(
  messages: List<ChatMessage>,
  toolScopes: List<String>,
): List<ChatTimelineItem> {
  val toolsByMessage = projectTranscriptToolActivity(messages)
  return buildList {
    val completedTools = mutableListOf<TranscriptTool>()
    var completedToolsKey: String? = null
    var completedToolsTurnBoundary = false
    var completedToolsRunIds: Set<String> = emptySet()
    var lastFailureMessageIndex = -1
    var hasUnresolvedTools = false
    var pendingTurnBoundary = false
    var toolScope = "root"

    fun flushToolActivity() {
      if (completedTools.isEmpty()) return
      add(ChatTimelineItem.ToolActivity(checkNotNull(completedToolsKey), coalesceToolActivity(completedTools), completedToolsTurnBoundary, lastFailureMessageIndex, hasUnresolvedTools, completedToolsRunIds, toolScope, coalescedToolKeys(completedTools, checkNotNull(completedToolsKey)), settledToolKeys = settledToolKeys(completedTools, checkNotNull(completedToolsKey))))
      completedTools.clear()
      completedToolsKey = null
      completedToolsTurnBoundary = false
      completedToolsRunIds = emptySet()
      lastFailureMessageIndex = -1
      hasUnresolvedTools = false
    }

    messages.forEachIndexed { index, message ->
      if (toolScope != toolScopes[index] || message.startsToolScope()) {
        flushToolActivity()
        toolScope = toolScopes[index]
      }
      if (message.turnBoundary || message.isForwardedBoundary()) {
        flushToolActivity()
        pendingTurnBoundary = true
      }
      val projection = toolsByMessage[index]
      val tools = projection.displayedTools
      val knownRunIds = tools.mapNotNull { it.runId }.toSet()
      val unresolvedTools = tools.any { it.pending || it.activity.isError }
      val lastFailure = tools.maxOfOrNull { it.lastFailureMessageIndex } ?: -1
      val hasVisibleContent = message.content.any { it.toolActivity == null }
      // Empty or consumed result envelopes must not erase a pending turn boundary.
      if (tools.isEmpty() && !hasVisibleContent && message.transcriptMarker == null) return@forEachIndexed
      val key = message.entryId ?: message.idempotencyKey ?: message.id
      if (tools.isNotEmpty() && !hasVisibleContent && message.transcriptMarker == null) {
        if (completedTools.isNotEmpty() && completedToolsRunIds != knownRunIds) flushToolActivity()
        if (completedTools.isEmpty()) {
          completedToolsKey = key
          completedToolsTurnBoundary = pendingTurnBoundary
          completedToolsRunIds = knownRunIds
          pendingTurnBoundary = false
        }
        completedTools.addAll(tools)
        lastFailureMessageIndex = maxOf(lastFailureMessageIndex, lastFailure)
        hasUnresolvedTools = hasUnresolvedTools || unresolvedTools
      } else {
        flushToolActivity()
        val classified = classifyTranscriptMessage(message, index)
        if (classified is ChatTimelineItem.Message) {
          add(
            classified.copy(
              turnBoundary = pendingTurnBoundary || classified.turnBoundary,
              hasUnresolvedTools = projection.relatedTools.any { it.pending || it.activity.isError },
              knownRunIds = projection.relatedTools.mapNotNull { it.runId }.toSet() + listOfNotNull(message.runId),
            ),
          )
          pendingTurnBoundary = false
        } else {
          classified?.let(::add)
        }
        if (tools.isNotEmpty()) {
          add(ChatTimelineItem.ToolActivity(key, coalesceToolActivity(tools), pendingTurnBoundary, lastFailure, unresolvedTools, knownRunIds, toolScope, coalescedToolKeys(tools, key), settledToolKeys = settledToolKeys(tools, key)))
          pendingTurnBoundary = false
        }
      }
    }
    flushToolActivity()
  }
}

/**
 * Outbox rows for the visible session owner. Rows enqueued under the "main" alias still belong to the
 * canonical main session once the gateway hello rewrites the current key. Rows whose user turn
 * is already visible as a message (optimistic while a live run owns it, or the canonical history
 * copy right before the row retires) are hidden so one send never renders as two bubbles. Migrated
 * ownerless and unreachable legacy-main rows are excluded here and rendered only in the
 * gateway-level recovery section.
 */
internal fun outboxItemsForSession(
  items: List<ChatOutboxItem>,
  sessionKey: String,
  mainSessionKey: String,
  ownerAgentId: String,
  messages: List<ChatMessage> = emptyList(),
): List<ChatOutboxItem> {
  val mainKey = mainSessionKey.trim().ifEmpty { "main" }
  val current = sessionKey.trim().let { if (it == "main") mainKey else it }
  val visibleUserKeys =
    messages
      .mapNotNull { message -> message.idempotencyKey?.trim()?.takeIf { it.isNotEmpty() } }
      .toSet()
  return items.filter { item ->
    val itemKey = item.sessionKey.let { if (it == "main") mainKey else it }
    val ownerMatches = item.ownerAgentId == ownerAgentId
    ownerMatches &&
      itemKey == current &&
      "${item.id}:user" !in visibleUserKeys &&
      !isRecoveryOutboxItem(item)
  }
}

/** Rows with missing or internally contradictory ownership still need neutral controls. */
internal fun outboxItemsForRecovery(items: List<ChatOutboxItem>): List<ChatOutboxItem> = items.filter(::isRecoveryOutboxItem)

private fun isRecoveryOutboxItem(item: ChatOutboxItem): Boolean {
  val keyOwner = resolveAgentIdFromMainSessionKey(item.sessionKey)
  val parkedMainAlias =
    item.sessionKey.trim() == "main" &&
      item.status == ChatOutboxStatus.Failed &&
      item.lastError == OUTBOX_OWNER_CHANGED_ERROR
  return item.ownerAgentId == null ||
    (keyOwner != null && keyOwner != item.ownerAgentId) ||
    parkedMainAlias
}

private fun stableMessageVersion(message: ChatMessage): String {
  val role = message.role.trim().lowercase()
  val idempotencyKey = message.idempotencyKey?.trim().orEmpty()
  if (idempotencyKey.isNotEmpty()) return "$role:idempotency:$idempotencyKey"

  return buildString {
    append(role)
    append(':')
    append(message.timestampMs ?: "")
    message.content.forEach { appendContentVersion(it) }
  }
}

private fun StringBuilder.appendContentVersion(content: ChatMessageContent) {
  append(':')
  append(content.type)
  append('=')
  append(content.text?.hashCode() ?: 0)
  append(',')
  append(content.mimeType.orEmpty())
  append(',')
  append(content.fileName.orEmpty())
  append(',')
  append(content.base64?.length ?: 0)
  append(',')
  append(content.durationMs ?: "")
  append(',')
  append(content.toolActivity?.toolCallId.orEmpty())
  append(',')
  append(content.toolActivity?.detail?.hashCode() ?: 0)
  append(',')
  append(content.toolActivity?.result?.hashCode() ?: 0)
  append(',')
  append(content.toolActivity?.isError ?: false)
  append(',')
  append(content.toolActivity?.arguments?.hashCode() ?: 0)
}

internal fun ChatTimeline.containsUserMessageVersion(version: String): Boolean =
  items.any { item ->
    val message = (item as? ChatTimelineItem.Message)?.message ?: return@any false
    message.role.trim().equals("user", ignoreCase = true) && stableMessageVersion(message) == version
  }

internal fun ChatTimeline.withTurnRecap(recap: TurnRecap?): ChatTimeline {
  if (recap == null) return this
  // reverseLayout makes index 0 the newest visual edge. The recap replaces the terminal
  // thinking slot there, while shifting the saved user-message anchor to the same row.
  return copy(
    items = listOf(ChatTimelineItem.TurnRecapSummary(recap)) + items,
    readAnchorIndex = readAnchorIndex?.plus(1),
    latestContentIndex = 0,
    latestContentVersion = "$latestContentVersion:recap=${recap.runtimeMs}:${recap.outputTokens ?: ""}",
  )
}

// Reader restoration only needs to detect changes at the live edge. Avoid hashing
// the full transcript whenever a streamed response updates.
private fun latestContentVersion(
  rawHistoryVersionPrefix: String,
  pendingRunCount: Int,
  pendingToolCalls: List<ChatPendingToolCall>,
  stream: String?,
  outboxItems: List<ChatOutboxItem> = emptyList(),
  questions: List<ChatQuestionPrompt> = emptyList(),
): String =
  buildString {
    append(rawHistoryVersionPrefix)
    append(":runs=")
    append(pendingRunCount)
    append(":tools=")
    pendingToolCalls.forEach { call ->
      append(call.toolCallId)
      append(',')
      append(call.name)
      append(',')
      append(call.isError)
      append(',')
      append(call.liveDiff)
      append(',')
      append(call.isComplete)
      append(',')
      append(call.activity)
      append(';')
    }
    append(":stream=")
    append(stream?.hashCode() ?: 0)
    append(":outbox=")
    outboxItems.forEach { item ->
      append(item.id)
      append(',')
      append(item.status)
      append(';')
    }
    append(":questions=")
    questions.forEach { prompt ->
      append(prompt.record.id)
      append(',')
      append(prompt.status())
      append(',')
      append(prompt.submitting)
      append(',')
      append(prompt.skipping)
      append(',')
      append(prompt.errorText?.hashCode() ?: 0)
      append(',')
      append(prompt.record.answers.hashCode())
      append(';')
    }
  }

internal fun chatTimelineItemKey(item: ChatTimelineItem): String =
  when (item) {
    is ChatTimelineItem.Message -> "message:${item.message.id}"
    is ChatTimelineItem.OutboxCommand -> "outbox:${item.item.id}"
    is ChatTimelineItem.RecoveryOutboxCommand -> "outbox-recovery:${item.item.id}"
    is ChatTimelineItem.OutboxRecoveryHeader -> "outbox-recovery-header"
    is ChatTimelineItem.ToolActivity -> "tools:${item.disclosureKey}"
    is ChatTimelineItem.QuestionPrompt -> "question:${item.prompt.record.id}"
    is ChatTimelineItem.WorkedSummary -> "worked:${item.key}"
    is ChatTimelineItem.TurnRecapSummary -> "turn-recap"
    is ChatTimelineItem.SystemNotice -> item.key
    is ChatTimelineItem.SystemDivider -> item.key
    is ChatTimelineItem.StreamingAssistant -> "stream"
    ChatTimelineItem.Thinking -> "thinking"
  }

private fun classifyTranscriptMessage(
  message: ChatMessage,
  index: Int,
): ChatTimelineItem? {
  message.transcriptMarker?.let { marker ->
    val keySuffix = marker.id ?: "${message.timestampMs ?: "missing"}:$index"
    return when (marker.kind) {
      "compaction" -> {
        val before = marker.tokensBefore
        val after = marker.tokensAfter
        val saved =
          if (before != null && before.isFinite() && after != null && after.isFinite() && before > after) {
            (before - after).toLong()
          } else {
            null
          }
        ChatTimelineItem.SystemDivider(
          key = "divider:compaction:$keySuffix",
          kind = SystemDividerKind.Compaction,
          label = nativeString("Compacted history"),
          metric = saved?.let { nativeString("saved \$count tokens", formatCompactTokenCount(it)) },
        )
      }

      "reset" -> {
        ChatTimelineItem.SystemDivider(
          key = "divider:reset:$keySuffix",
          kind = SystemDividerKind.Reset,
          label = nativeString("Session reset"),
          secondary = nativeString("The earlier conversation was cleared."),
        )
      }

      else -> {
        null
      }
    }
  }

  val provenance = message.provenance
  if (message.role == "user" && provenance?.kind == "internal_system") {
    val rawBody = chatMessagePlainText(message.content).removePrefix("[System] ")
    val label: String
    val body: String
    when (provenance.sourceTool) {
      "main_session_restart_recovery" -> {
        label = nativeString("System · restart recovery")
        body = nativeString("Turn interrupted by a gateway restart — asked the agent to resume and finish the response.")
      }

      "restart-sentinel" -> {
        label = nativeString("System · gateway restarted")
        body = rawBody
      }

      else -> {
        label = nativeString("System")
        body = rawBody
      }
    }
    if (body.isBlank()) return null
    val keySuffix = message.entryId ?: message.idempotencyKey ?: "${message.timestampMs ?: "missing"}:$index"
    return ChatTimelineItem.SystemNotice(
      key = "system-notice:$keySuffix",
      label = label,
      body = body,
    )
  }

  return message.takeIf { it.content.isNotEmpty() }?.let(ChatTimelineItem::Message)
}

// Results belong to their invocation even when commentary separates the two.
// Keep their display at the original call instead of manufacturing a second Tool row.
private class TranscriptTool(
  var activity: ChatToolActivity,
  var runId: String?,
  var pending: Boolean,
  var lastFailureMessageIndex: Int,
)

private class TranscriptMessageTools {
  val displayedTools = mutableListOf<TranscriptTool>()

  // A mixed result carrier shares ownership with the call displayed earlier.
  val relatedTools = mutableListOf<TranscriptTool>()
}

private fun projectTranscriptToolActivity(messages: List<ChatMessage>): List<TranscriptMessageTools> {
  val projected = messages.map { TranscriptMessageTools() }
  val calls = mutableMapOf<String, MutableMap<String?, TranscriptTool>>()
  var turnRunId: String? = null
  messages.forEachIndexed { messageIndex, message ->
    if (message.turnBoundary || message.isForwardedBoundary()) {
      calls.clear()
      turnRunId = null
    }
    // A later turn may reuse a harness-local call ID.
    if (message.transcriptMarker != null) {
      calls.clear()
      turnRunId = null
    } else if (message.role.equals("user", ignoreCase = true)) {
      val continuesRun = turnRunId != null && message.steerTargetRunId == turnRunId
      if (!continuesRun) {
        // Known runs can finish after a newer prompt. Only unattributed calls are
        // fenced by an ordinary user turn; explicit reset/hidden boundaries clear all.
        calls.values.forEach { it.remove(null) }
        turnRunId = message.runId
      }
    }
    message.content.forEach { content ->
      val tool = content.toolActivity?.let { raw -> raw.copy(activity = message.activity?.firstOrNull { it.toolCallId == raw.toolCallId }, activityPrepared = message.activity != null) } ?: return@forEach
      val result = content.type.equals("toolResult", ignoreCase = true)
      val candidates = if (result) tool.toolCallId?.let(calls::get) else null
      val owner =
        if (message.runId != null) {
          candidates?.get(message.runId) ?: candidates
            ?.entries
            ?.singleOrNull()
            ?.takeIf { it.key == null }
            ?.value
        } else {
          candidates?.values?.singleOrNull()
        }
      if (owner != null) {
        if (owner.runId == null && message.runId != null) {
          val lookup = checkNotNull(candidates)
          lookup.remove(null)
          owner.runId = message.runId
          lookup[message.runId] = owner
        }
        owner.activity = mergeToolActivity(owner.activity, tool)
        // A received result settles the call even when its display text is empty.
        owner.pending = false
        if (tool.isError) owner.lastFailureMessageIndex = messageIndex
        projected[messageIndex].relatedTools.add(owner)
      } else {
        // ID-only result envelopes have no standalone UI. Keep meaningful unnamed
        // output and failures, and keep empty named calls (they may still be running).
        val emptyOrphan =
          result && tool.name == "tool" && tool.detail.isNullOrBlank() &&
            tool.result.isNullOrBlank() && !tool.isError && tool.arguments.isNullOrEmpty()
        if (!emptyOrphan) {
          val projection = TranscriptTool(tool, message.runId, !result && tool.result == null, if (tool.isError) messageIndex else -1)
          projected[messageIndex].displayedTools.add(projection)
          projected[messageIndex].relatedTools.add(projection)
          if (!result) tool.toolCallId?.let { calls.getOrPut(it) { mutableMapOf() }[message.runId] = projection }
        }
      }
    }
  }
  return projected
}

private fun mergeToolActivity(
  previous: ChatToolActivity,
  next: ChatToolActivity,
): ChatToolActivity =
  previous.copy(
    name = previous.name.takeUnless { it == "tool" } ?: next.name,
    detail = previous.detail ?: next.detail,
    result = next.result ?: previous.result,
    isError = previous.isError || next.isError,
    arguments = previous.arguments ?: next.arguments,
    activity = if (next.activityPrepared) next.activity else previous.activity,
    activityPrepared = next.activityPrepared || previous.activityPrepared,
  )

private fun coalesceToolActivity(parts: List<TranscriptTool>): List<ChatToolActivity> {
  val merged = linkedMapOf<Triple<String?, String?, Int>, ChatToolActivity>()
  parts.forEachIndexed { index, part ->
    val key = Triple(part.runId, part.activity.toolCallId, if (part.activity.toolCallId == null) index else -1)
    val previous = merged[key]
    merged[key] =
      if (previous == null) {
        part.activity
      } else {
        mergeToolActivity(previous, part.activity)
      }
  }
  return merged.values.toList()
}

private fun ChatMessage.startsToolScope(): Boolean = role.equals("user", ignoreCase = true) || turnBoundary || isForwardedBoundary() || transcriptMarker != null

internal fun ChatMessage.toolScopeKey(): String = idempotencyKey ?: entryId ?: id

private fun coalescedToolKeys(
  parts: List<TranscriptTool>,
  source: String,
): List<String> = parts.mapIndexed { index, part -> "${part.runId.orEmpty()}:${part.activity.toolCallId ?: "anonymous:$source:$index"}" }.distinct()

private fun settledToolKeys(
  parts: List<TranscriptTool>,
  source: String,
): Set<String> =
  parts
    .mapIndexedNotNull { index, part ->
      if (part.pending) null else "${part.runId.orEmpty()}:${part.activity.toolCallId ?: "anonymous:$source:$index"}"
    }.toSet()

private fun toolScopes(messages: List<ChatMessage>): List<String> {
  var scope = "root"
  val runs = mutableMapOf<String, String>()
  return messages.map { message ->
    if (message.startsToolScope()) {
      scope = message.steerTargetRunId?.let(runs::get) ?: message.toolScopeKey()
      if (message.transcriptMarker != null || message.turnBoundary || message.isForwardedBoundary()) runs.clear()
    }
    message.runId?.let { runs.getOrPut(it) { scope } } ?: scope
  }
}
