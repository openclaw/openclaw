package ai.openclaw.app.ui.chat

import ai.openclaw.app.chat.ChatMessage
import ai.openclaw.app.currentAppLanguage
import ai.openclaw.app.i18n.nativeString
import ai.openclaw.app.ui.design.ClawTheme
import ai.openclaw.app.ui.localizedUppercase
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.lerp
import androidx.compose.ui.semantics.ProgressBarRangeInfo
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.progressBarRangeInfo
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

@Composable
internal fun ChatContextPopoverContent(
  contextUsage: ChatContextUsage,
  messages: List<ChatMessage>,
) {
  val summary = chatContextSummary(contextUsage)
  val runStats =
    buildList {
      add(nativeString("Input") to formatContextUsageTokens(contextUsage.inputTokens))
      add(nativeString("Output") to formatContextUsageTokens(contextUsage.outputTokens))
      contextUsage.estimatedCostUsd?.takeIf { it.isFinite() && it >= 0.0 }?.let {
        add(nativeString("Est. cost") to formatContextEstimatedCost(it))
      }
    }
  // The session snapshot owns run totals; this breakdown describes the latest actual model call.
  val cost = latestChatMessageCost(messages)
  val costTotal = cost?.total?.takeIf { it.isFinite() && it >= 0.0 }
  val costStats =
    cost
      ?.let { cost ->
        listOf(
          nativeString("Input") to cost.input,
          nativeString("Output") to cost.output,
          nativeString("Cache read") to cost.cacheRead,
          nativeString("Cache write") to cost.cacheWrite,
        ).mapNotNull { (label, value) ->
          value?.takeIf { it.isFinite() && it >= 0.0 }?.let { label to formatContextEstimatedCost(it) }
        }
      }.orEmpty()

  Column(
    modifier = Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(14.dp),
  ) {
    FlowRow(
      modifier = Modifier.fillMaxWidth(),
      horizontalArrangement = Arrangement.SpaceBetween,
      verticalArrangement = Arrangement.spacedBy(4.dp),
      itemVerticalAlignment = Alignment.CenterVertically,
    ) {
      ContextSectionLabel(nativeString("Context window"))
      Text(
        text = summary?.detail ?: nativeString("Unknown"),
        style = ClawTheme.type.caption.copy(fontSize = 13.sp, lineHeight = 18.sp, fontWeight = FontWeight.SemiBold, fontFeatureSettings = "tnum"),
        textAlign = TextAlign.End,
        color = ClawTheme.colors.text,
      )
    }
    summary?.let {
      val color = chatContextColor(it)
      Box(
        modifier =
          Modifier
            .padding(top = 8.dp, bottom = 10.dp)
            .fillMaxWidth()
            .height(5.dp)
            .clip(RoundedCornerShape(percent = 50))
            .background(ClawTheme.colors.textMuted.copy(alpha = 0.22f))
            .semantics {
              contentDescription = nativeString("\$label: \$value", nativeString("Context window"), it.detail)
              progressBarRangeInfo = ProgressBarRangeInfo(it.fraction, 0f..1f)
            },
      ) {
        Box(Modifier.fillMaxHeight().fillMaxWidth(it.fraction).background(color))
      }
    }
    HorizontalDivider(color = ClawTheme.colors.border.copy(alpha = 0.72f))
    ContextSectionLabel(nativeString("Latest run tokens"), Modifier.padding(top = 14.dp))
    ContextInlineStats(runStats, Modifier.padding(top = 8.dp))
    if (costStats.isNotEmpty() || costTotal != null) {
      HorizontalDivider(modifier = Modifier.padding(top = 14.dp), color = ClawTheme.colors.border.copy(alpha = 0.72f))
      ContextSectionLabel(
        if (costStats.isEmpty()) nativeString("Latest model call") else nativeString("Cost by type"),
        Modifier.padding(top = 14.dp),
      )
      ContextInlineStats(
        costStats.ifEmpty { listOf(nativeString("Est. cost") to formatContextEstimatedCost(costTotal)) },
        Modifier.padding(top = 8.dp),
      )
    }
  }
}

@Composable
private fun ContextSectionLabel(
  label: String,
  modifier: Modifier = Modifier,
) {
  Text(
    text = localizedUppercase(label, currentAppLanguage().languageTag),
    modifier = modifier,
    style = ClawTheme.type.captionSmall.copy(fontWeight = FontWeight.Bold, letterSpacing = 0.88.sp),
    color = ClawTheme.colors.textMuted,
  )
}

@Composable
private fun ContextInlineStats(
  stats: List<Pair<String, String>>,
  modifier: Modifier = Modifier,
) {
  FlowRow(
    modifier = modifier.fillMaxWidth(),
    horizontalArrangement = Arrangement.spacedBy(6.dp),
    verticalArrangement = Arrangement.spacedBy(4.dp),
  ) {
    stats.forEachIndexed { index, (label, value) ->
      Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
        Text(
          text = label,
          modifier = Modifier.alignByBaseline(),
          style = ClawTheme.type.caption,
          color = ClawTheme.colors.textMuted,
        )
        Text(
          text = value,
          modifier = Modifier.alignByBaseline(),
          style = ClawTheme.type.caption.copy(fontWeight = FontWeight.SemiBold, fontFeatureSettings = "tnum"),
          color = ClawTheme.colors.text,
        )
        if (index < stats.lastIndex) {
          Text(
            text = nativeString("·"),
            modifier = Modifier.alignByBaseline().padding(start = 2.dp),
            style = ClawTheme.type.caption,
            color = ClawTheme.colors.textMuted,
          )
        }
      }
    }
  }
}

@Composable
internal fun chatContextColor(summary: ChatContextSummary?) =
  if (summary == null || summary.approximate || summary.fraction < 0.85f) {
    ClawTheme.colors.textMuted
  } else {
    lerp(ClawTheme.colors.warning, ClawTheme.colors.danger, ((summary.fraction - 0.85f) / 0.1f).coerceIn(0f, 1f))
  }
