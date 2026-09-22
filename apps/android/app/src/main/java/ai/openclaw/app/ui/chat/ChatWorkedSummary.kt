package ai.openclaw.app.ui.chat

import ai.openclaw.app.chat.ChatMessage
import ai.openclaw.app.i18n.nativeString
import ai.openclaw.app.ui.design.ClawTheme
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.unit.dp

internal data class PreparedChatWorkSpan(
  val start: Int,
  val endExclusive: Int,
  val workRowIndexes: List<Int>,
  val preservedRowIndexes: List<Int>,
  val key: String,
  val durationMs: Long?,
  val inLatestTurn: Boolean,
  val inLatestRunChain: Boolean,
  val turnIndex: Int,
  /** Shared by a continuation chain; an active descendant exposes its ancestors. */
  val runLastTurnIndexes: Map<String, Int>,
)

/** Prepare completed-work partitions once; live updates only select these row indexes. */
internal fun prepareCompletedWorkSpans(
  rows: List<ChatTimelineItem>,
  messages: List<ChatMessage>,
  sessionKey: String,
  mainSessionKey: String,
): List<PreparedChatWorkSpan> {
  val key = sessionKey.trim().lowercase()
  val sessionParts = key.split(':')
  val agentSession = sessionParts.size >= 3 && sessionParts[0] == "agent" && sessionParts[1].isNotBlank()
  val main = key == "main" || key == mainSessionKey.trim().lowercase() || (agentSession && sessionParts.size == 3 && sessionParts[2] == "main")
  val dashboard = agentSession && sessionParts.size == 4 && sessionParts[2] == "dashboard" && sessionParts[3].isNotBlank()
  if (!main && !dashboard) return emptyList()
  val turns = mutableListOf<MutableList<ChatTimelineItem>>()
  rows.forEach { item ->
    val startsTurn =
      when (item) {
        is ChatTimelineItem.Message -> {
          item.turnBoundary ||
            item.message.role
              .trim()
              .equals("user", ignoreCase = true) || item.message.isForwardedBoundary()
        }

        is ChatTimelineItem.CompletedTools -> {
          item.turnBoundary
        }

        is ChatTimelineItem.SystemDivider, is ChatTimelineItem.SystemNotice -> {
          true
        }

        else -> {
          false
        }
      }
    if (turns.isEmpty() || startsTurn) turns.add(mutableListOf())
    turns.last().add(item)
  }
  val sourceMessages = messages.associateBy { it.entryId ?: it.idempotencyKey ?: it.id }
  val sourcePositions = messages.withIndex().associate { it.value.id to it.index }

  fun source(item: ChatTimelineItem): ChatMessage? =
    when (item) {
      is ChatTimelineItem.Message -> item.message
      is ChatTimelineItem.CompletedTools -> sourceMessages[item.key]
      else -> null
    }

  fun knownRunIds(item: ChatTimelineItem): Set<String> =
    when (item) {
      is ChatTimelineItem.Message -> item.knownRunIds
      is ChatTimelineItem.CompletedTools -> item.knownRunIds
      else -> emptySet()
    }

  fun replyRunId(item: ChatTimelineItem.Message): String? = item.message.runId ?: item.knownRunIds.singleOrNull()

  fun isOutput(item: ChatTimelineItem): Boolean =
    when (item) {
      is ChatTimelineItem.CompletedTools -> {
        true
      }

      is ChatTimelineItem.Message -> {
        item.message.role
          .trim()
          .equals("assistant", ignoreCase = true) && !item.message.isForwardedBoundary()
      }

      else -> {
        false
      }
    }

  fun hasMedia(message: ChatMessage) = message.content.any { it.toolActivity == null && it.type != "text" }

  fun hasReplyContent(message: ChatMessage) = hasMedia(message) || message.content.any { it.type == "text" && !it.text.isNullOrBlank() }

  fun hasUnresolvedWork(item: ChatTimelineItem): Boolean =
    when (item) {
      is ChatTimelineItem.CompletedTools -> item.hasUnresolvedTools
      is ChatTimelineItem.Message -> item.message.isError || item.hasUnresolvedTools
      else -> false
    }

  fun isCompletedReply(item: ChatTimelineItem): Boolean = item is ChatTimelineItem.Message && isOutput(item) && hasReplyContent(item.message) && item.message.phase != "commentary" && !hasUnresolvedWork(item)

  fun isWork(item: ChatTimelineItem): Boolean = isOutput(item) && (item !is ChatTimelineItem.Message || (!hasMedia(item.message) && item.message.phase != "final_answer"))
  // Steering messages continue an existing run; they are not completed-turn boundaries.
  val runTurns = mutableMapOf<String, Int>()
  val continuations = mutableMapOf<Int, Int>()
  val preceding = mutableMapOf<Int, Int>()
  val tails = mutableMapOf<Int, Int>()
  turns.forEachIndexed { index, turn ->
    val user =
      (turn.firstOrNull() as? ChatTimelineItem.Message)?.message?.takeIf {
        it.role.equals("user", ignoreCase = true)
      }
    user?.runId?.let { runTurns.putIfAbsent(it, index) }
    var previous = user?.steerTargetRunId?.let(runTurns::get) ?: return@forEachIndexed
    if (previous >= index) return@forEachIndexed
    val ancestors = mutableListOf<Int>()
    while (previous in tails) {
      ancestors.add(previous)
      previous = tails.getValue(previous)
    }
    continuations[previous] = index
    preceding[index] = previous
    tails[previous] = index
    ancestors.forEach { tails[it] = index }
  }
  val finalIndexes =
    turns.mapIndexed { index, turn ->
      if (index in continuations) {
        -1
      } else {
        turn.indexOfLast(::isCompletedReply)
      }
    }
  val terminalReplies =
    turns
      .mapIndexed { index, turn ->
        turn.getOrNull(finalIndexes[index]) as? ChatTimelineItem.Message
      }.toMutableList()
  for (index in turns.lastIndex - 1 downTo 0) {
    if (terminalReplies[index] == null) continuations[index]?.let { terminalReplies[index] = terminalReplies[it] }
  }
  val latestRunChain = mutableSetOf<Int>()
  var latestIndex = turns.lastIndex
  while (latestIndex >= 0 && latestRunChain.add(latestIndex)) latestIndex = preceding[latestIndex] ?: break
  val chainRoots = IntArray(turns.size)
  val mutableChainRuns = mutableMapOf<Int, MutableMap<String, Int>>()
  turns.forEachIndexed { index, turn ->
    val root = preceding[index]?.let { chainRoots[it] } ?: index
    chainRoots[index] = root
    turn.forEach { item ->
      knownRunIds(item).forEach { runId -> mutableChainRuns.getOrPut(root) { mutableMapOf() }[runId] = index }
    }
  }
  val chainRuns = mutableChainRuns.mapValues { (_, runs) -> runs.toMap() }
  return buildList {
    var offset = 0
    turns.forEachIndexed { turnIndex, turn ->
      val turnOffset = offset
      offset += turn.size
      val finalIndex = finalIndexes[turnIndex]
      val terminal = terminalReplies[turnIndex] ?: return@forEachIndexed
      var start = if (finalIndex >= 0) finalIndex else turn.lastIndex
      var end = start
      if (!isOutput(turn[start])) {
        return@forEachIndexed
      }
      while (start > 0 && isOutput(turn[start - 1])) start--
      val terminalPosition = sourcePositions.getValue(terminal.message.id)
      val replyPositions =
        turn
          .take(if (finalIndex >= 0) finalIndex + 1 else turn.size)
          .mapNotNull { item ->
            (item as? ChatTimelineItem.Message)?.takeIf(::isCompletedReply)?.let { reply ->
              replyRunId(reply)?.let { it to sourcePositions.getValue(reply.message.id) }
            }
          }.toMap()
          .toMutableMap()
      replyRunId(terminal)?.let { replyPositions[it] = terminalPosition }
      while (end < turn.lastIndex && isOutput(turn[end + 1])) {
        if (knownRunIds(turn[end + 1]).any { it !in replyPositions }) break
        end++
      }
      val work = mutableListOf<Int>()
      val answers = mutableListOf<Int>()
      for (index in start..end) {
        val item = turn[index]
        val message = source(item)
        val owners = knownRunIds(item)
        val sourcePosition = message?.let { sourcePositions.getValue(it.id) } ?: -1
        val replyPosition = owners.mapNotNull(replyPositions::get).minOrNull() ?: terminalPosition
        val unresolvedPosition = if (item is ChatTimelineItem.CompletedTools) maxOf(sourcePosition, item.lastFailureMessageIndex) else sourcePosition
        val unansweredWork = hasUnresolvedWork(item) && unresolvedPosition >= replyPosition
        val replylessRun = owners.any { it !in replyPositions }
        if (index != finalIndex && isWork(item) && !unansweredWork && !replylessRun) work.add(turnOffset + index) else answers.add(turnOffset + index)
      }
      if (work.isEmpty()) {
        return@forEachIndexed
      }
      val continuationBoundary = continuations[turnIndex]?.let { turns[it].firstOrNull() } as? ChatTimelineItem.Message
      val identity = if (finalIndex >= 0) terminal.message else continuationBoundary?.message ?: terminal.message
      val key = identity.entryId ?: identity.idempotencyKey ?: identity.id
      val boundary = turn.firstOrNull() as? ChatTimelineItem.Message
      val startTime =
        boundary
          ?.takeIf {
            it.message.role
              .trim()
              .equals("user", ignoreCase = true)
          }?.message
          ?.timestampMs ?: source(rows[work.first()])?.timestampMs
      val endTime = (work.mapNotNull { source(rows[it])?.timestampMs } + listOfNotNull(terminal.message.timestampMs)).maxOrNull()
      val duration = if (startTime != null && endTime != null && terminal.message.timestampMs?.let { it > startTime } == true) endTime - startTime else null
      add(
        PreparedChatWorkSpan(
          start = turnOffset + start,
          endExclusive = turnOffset + end + 1,
          workRowIndexes = work,
          preservedRowIndexes = answers,
          key = key,
          durationMs = duration,
          inLatestTurn = turnIndex == turns.lastIndex,
          inLatestRunChain = turnIndex in latestRunChain,
          turnIndex = turnIndex,
          runLastTurnIndexes = chainRuns[chainRoots[turnIndex]].orEmpty(),
        ),
      )
    }
  }
}

internal fun workedSummaryLabel(durationMs: Long?): String {
  if (durationMs == null || durationMs <= 0) return nativeString("Worked")
  // Same rounding and two nonzero units as web formatDurationCompact.
  var remaining = if (durationMs < 1000) durationMs else ((durationMs + 500) / 1000) * 1000
  val parts = mutableListOf<String>()
  for ((scale, suffix) in listOf(86_400_000L to "d", 3_600_000L to "h", 60_000L to "m", 1000L to "s", 1L to "ms")) {
    val value = remaining / scale
    remaining %= scale
    if (value > 0) parts.add("$value$suffix")
    if (parts.size == 2) break
  }
  return nativeString("Worked for \$duration", parts.joinToString(" "))
}

@Composable
internal fun ChatWorkedSummary(
  item: ChatTimelineItem.WorkedSummary,
  onToggle: () -> Unit,
) {
  val color = ClawTheme.colors.textMuted
  Column(modifier = Modifier.fillMaxWidth()) {
    Row(
      modifier =
        Modifier
          .fillMaxWidth()
          .semantics { stateDescription = if (item.expanded) nativeString("Expanded") else nativeString("Collapsed") }
          .clickable(role = Role.Button, onClick = onToggle)
          .padding(vertical = 12.dp),
      horizontalArrangement = Arrangement.spacedBy(6.dp),
      verticalAlignment = Alignment.CenterVertically,
    ) {
      Text(workedSummaryLabel(item.durationMs), style = ClawTheme.type.body, color = color)
      Icon(
        if (item.expanded) Icons.Default.KeyboardArrowDown else Icons.AutoMirrored.Filled.KeyboardArrowRight,
        contentDescription = null,
        tint = color,
        modifier = Modifier.size(16.dp),
      )
    }
    HorizontalDivider(color = ClawTheme.colors.border)
  }
}
