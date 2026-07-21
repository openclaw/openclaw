package ai.openclaw.app.ui.chat

import ai.openclaw.app.R
import ai.openclaw.app.chat.ChatSessionEntry
import ai.openclaw.app.ui.design.ClawTheme
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import java.util.Locale

internal data class TurnRecap(
  val runtimeMs: Long,
  val outputTokens: Long?,
)

internal data class TurnRecapTokenFormat(
  val singular: Boolean,
  val count: String,
)

/**
 * [baselineEndedAt] is the session row's endedAt when the working indicator appeared: the
 * previous run's terminal stamp, or null once the run-start patch cleared it. Only a row whose
 * endedAt moved past that baseline belongs to the run this pane watched. [settled] freezes the
 * first recap so a later background, cron, or other-device run cannot rewrite the displayed row.
 */
private data class TurnRecapWatch(
  var watching: Boolean,
  /** False until a session row was observed; without a baseline, a later terminal is ambiguous. */
  var baselineKnown: Boolean,
  var baselineEndedAt: Long?,
  /** A stamp changed while the claw was still up, so later stamps cannot be attributed safely. */
  var absorbedTerminal: Boolean,
  /** First idle render after the indicator cleared; canceled queued sends must expire promptly. */
  var settleStartedAt: Long?,
  val settled: TurnRecap?,
)

/**
 * Session rows have no run identity. The watched terminal normally arrives moments after the
 * indicator clears, so an unresolved watch expires after this window instead of matching an
 * unrelated later completion. An unrelated completion inside the window remains an accepted,
 * cosmetic ambiguity until the gateway supplies a terminal-row run id.
 */
internal const val TURN_RECAP_SETTLE_WINDOW_MS = 30_000L

internal class TurnRecapResolver(
  private val nowMs: () -> Long = System::currentTimeMillis,
) {
  private val watches = mutableMapOf<String, TurnRecapWatch>()

  /**
   * Watches while the indicator is visible, then resolves the first fresh terminal row. Only a
   * clean `done` with runtime data produces a recap; every other fresh terminal consumes quietly.
   */
  fun resolve(
    sessionKey: String,
    indicatorVisible: Boolean,
    row: ChatSessionEntry?,
  ): TurnRecap? {
    val watch = watches[sessionKey]
    val rowEndedAt = row?.endedAt
    if (indicatorVisible) {
      if (watch == null || !watch.watching) {
        watches[sessionKey] =
          TurnRecapWatch(
            watching = true,
            baselineKnown = row != null,
            baselineEndedAt = rowEndedAt,
            absorbedTerminal = false,
            settleStartedAt = null,
            settled = null,
          )
      } else if (!watch.baselineKnown) {
        if (row != null) {
          watch.baselineKnown = true
          watch.baselineEndedAt = rowEndedAt
        }
      } else if (rowEndedAt != null && rowEndedAt != watch.baselineEndedAt) {
        watch.baselineEndedAt = rowEndedAt
        watch.absorbedTerminal = true
      }
      return null
    }
    if (watch == null) return null
    watch.watching = false
    watch.settled?.let { return it }
    if (watch.absorbedTerminal || !watch.baselineKnown) {
      // Attribution is ambiguous, so fail quiet instead of freezing another run's numbers.
      watches.remove(sessionKey)
      return null
    }
    if (watch.settleStartedAt == null) {
      watch.settleStartedAt = nowMs()
    } else if (nowMs() - checkNotNull(watch.settleStartedAt) > TURN_RECAP_SETTLE_WINDOW_MS) {
      watches.remove(sessionKey)
      return null
    }
    val isStale =
      rowEndedAt == null ||
        (watch.baselineEndedAt != null && rowEndedAt <= checkNotNull(watch.baselineEndedAt))
    if (isStale) {
      // No watched terminal yet. Stamps never regress, so <= stays stale until the bounded expiry.
      return null
    }
    // Any fresh terminal concludes the watch. Waiting past a non-done terminal could attach a
    // later unrelated success to this turn.
    watches.remove(sessionKey)
    val runtimeMs = row.runtimeMs
    if (row.status != "done" || runtimeMs == null) return null
    val settled = TurnRecap(runtimeMs = runtimeMs, outputTokens = row.outputTokens)
    watches[sessionKey] = watch.copy(settled = settled)
    return settled
  }
}

@Composable
internal fun ChatTurnRecapRow(recap: TurnRecap) {
  val duration = formatLocalizedChatDurationCompact(recap.runtimeMs.coerceAtLeast(1_000L))
  val tokens =
    recap.outputTokens?.let { count ->
      val format = turnRecapTokenFormat(count)
      if (format.singular) {
        stringResource(R.string.chat_turn_recap_tokens_one)
      } else {
        stringResource(R.string.chat_turn_recap_tokens, format.count)
      }
    }
  Row(
    modifier = Modifier.fillMaxWidth().padding(horizontal = 10.dp, vertical = 4.dp),
    verticalAlignment = Alignment.CenterVertically,
    horizontalArrangement = Arrangement.spacedBy(7.dp),
  ) {
    WorkingClawIcon(runKey = "turn-recap", color = ClawTheme.colors.primary, parked = true)
    Text(
      text = stringResource(R.string.chat_turn_recap_done_in, duration),
      style = ClawTheme.type.caption,
      color = ClawTheme.colors.textMuted,
    )
    tokens?.let {
      Text(text = "·", style = ClawTheme.type.caption, color = ClawTheme.colors.textSubtle)
      Text(text = it, style = ClawTheme.type.caption, color = ClawTheme.colors.textMuted)
    }
  }
}

internal fun turnRecapTokenFormat(count: Long): TurnRecapTokenFormat = TurnRecapTokenFormat(singular = count == 1L, count = formatCompactTokenCount(count))

internal fun formatCompactTokenCount(count: Long): String {
  fun decimal(value: Double): String = String.format(Locale.US, "%.1f", value).removeSuffix(".0")
  return when {
    count >= 1_000_000L -> "${decimal(count / 1_000_000.0)}M"
    count >= 1_000L -> {
      val thousands = decimal(count / 1_000.0)
      if (thousands == "1000") "${decimal(count / 1_000_000.0)}M" else "${thousands}k"
    }
    else -> count.toString()
  }
}
