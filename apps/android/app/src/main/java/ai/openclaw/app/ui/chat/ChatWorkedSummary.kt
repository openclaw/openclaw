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

// Match web assistantGroupIsForwardedBoundary: attribution labels do not establish turn ownership.

/** Mirror web collapseCompletedTurnWork: only the contiguous work preceding a final reply folds. */
internal fun ChatTimeline.withCompletedWorkGroups(
  messages: List<ChatMessage>,
  runWorking: Boolean,
  expandedKeys: Set<String>,
  sessionKey: String,
): ChatTimeline {
  val sessionParts = sessionKey.trim().lowercase().split(':')
  if (sessionParts.size != 4 || sessionParts[0] != "agent" || sessionParts[1].isBlank() ||
    sessionParts[2] != "dashboard" || sessionParts[3].isBlank()
  ) {
    return this
  }
  val chronological = items.asReversed()
  val turns = mutableListOf<MutableList<ChatTimelineItem>>()
  chronological.forEach { item ->
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

        else -> {
          false
        }
      }
    if (turns.isEmpty() || startsTurn) turns.add(mutableListOf())
    turns.last().add(item)
  }
  val timestamps = messages.associate { (it.entryId ?: it.idempotencyKey ?: it.id) to it.timestampMs }

  fun timestamp(item: ChatTimelineItem): Long? =
    when (item) {
      is ChatTimelineItem.Message -> item.message.timestampMs
      is ChatTimelineItem.CompletedTools -> timestamps[item.key]
      else -> null
    }

  fun isWork(item: ChatTimelineItem): Boolean =
    when (item) {
      is ChatTimelineItem.CompletedTools -> {
        true
      }

      is ChatTimelineItem.Message -> {
        item.message.role
          .trim()
          .equals("assistant", ignoreCase = true) &&
          !item.message.isForwardedBoundary() &&
          // Tool activity is rendered separately; retain canonical content for full-message reads.
          item.message.content.all { it.toolActivity != null || it.type == "text" }
      }

      else -> {
        false
      }
    }
  // Steering messages continue an existing run; they are not completed-turn boundaries.
  val runTurns = mutableMapOf<String, Int>()
  val steeringTurns = linkedMapOf<String, MutableList<Int>>()
  turns.forEachIndexed { index, turn ->
    val user =
      (turn.firstOrNull() as? ChatTimelineItem.Message)?.message?.takeIf {
        it.role.equals("user", ignoreCase = true)
      }
    user?.runId?.let { runTurns.putIfAbsent(it, index) }
    user?.steerTargetRunId?.let { steeringTurns.getOrPut(it) { mutableListOf() }.add(index) }
  }
  val continuations = mutableMapOf<Int, Int>()
  val preceding = mutableMapOf<Int, Int>()
  steeringTurns.forEach { (runId, indexes) ->
    var previous = runTurns[runId] ?: return@forEach
    indexes.forEach { index ->
      if (index > previous) {
        continuations[previous] = index
        preceding[index] = previous
        previous = index
      }
    }
  }
  val finalIndexes =
    turns.mapIndexed { index, turn ->
      if (index in continuations) {
        -1
      } else {
        turn.indexOfLast {
          it is ChatTimelineItem.Message && it.message.role.equals("assistant", ignoreCase = true) && !it.message.isForwardedBoundary()
        }
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
  val liveTurns = mutableSetOf<Int>()
  if (runWorking) {
    var index = turns.lastIndex
    while (index >= 0 && liveTurns.add(index)) index = preceding[index] ?: break
  }
  val rendered =
    buildList {
      turns.forEachIndexed { turnIndex, turn ->
        val live =
          turnIndex in liveTurns ||
            turn.any {
              it is ChatTimelineItem.StreamingAssistant || it is ChatTimelineItem.PendingTools || it == ChatTimelineItem.Thinking
            }
        val finalIndex = finalIndexes[turnIndex]
        val terminal = terminalReplies[turnIndex]
        val end = if (finalIndex >= 0) finalIndex else turn.size
        var start = end
        while (start > 0 && isWork(turn[start - 1])) start--
        if (live || terminal == null || start == end) {
          addAll(turn)
        } else {
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
              ?.timestampMs ?: timestamp(turn[start])
          val endTime = terminal.message.timestampMs
          val duration = if (startTime != null && endTime != null && endTime > startTime) endTime - startTime else null
          addAll(turn.take(start))
          add(ChatTimelineItem.WorkedSummary(key, duration, key in expandedKeys))
          if (key in expandedKeys) addAll(turn.subList(start, end))
          addAll(turn.drop(end))
        }
      }
    }.asReversed()
  return copy(
    items = rendered,
    readAnchorIndex = rendered.indexOfFirst { it is ChatTimelineItem.Message && it.message.id == latestUserMessageId }.takeIf { it >= 0 } ?: latestContentIndex,
  )
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
