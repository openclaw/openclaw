package ai.openclaw.app.ui

import ai.openclaw.app.GatewayDreamDiaryEntry
import ai.openclaw.app.GatewayDreamingSummary
import ai.openclaw.app.MainViewModel
import ai.openclaw.app.i18n.nativeString
import ai.openclaw.app.i18n.resolveNativeText
import ai.openclaw.app.ui.design.ClawListPanel
import ai.openclaw.app.ui.design.ClawStatusRow
import ai.openclaw.app.ui.design.ClawTheme
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp

/** Settings screen for gateway dreaming state and recent dream diary entries. */
@Composable
internal fun DreamingSettingsScreen(
  viewModel: MainViewModel,
  onBack: () -> Unit,
) {
  val state by viewModel.dreamingState.collectAsState()
  val isConnected by viewModel.isConnected.collectAsState()

  SettingsRefreshOnConnect(isConnected) { viewModel.refreshDreaming() }

  SettingsDetailFrame(
    subtitle = nativeString("Memory consolidation and dream diary."),
    route = SettingsRoute.Dreaming,
    onBack = onBack,
  ) {
    SettingsRefreshControls(isConnected, state.refreshing, state.errorText, viewModel::refreshDreaming)
    SettingsSummaryContent(state, isConnected, nativeString("Connect the gateway to load dreaming.")) { summary ->
      SettingsMetricPanel(
        rows =
          listOf(
            SettingsMetric(nativeString("Status"), if (summary.enabled) nativeString("On") else nativeString("Off")),
            SettingsMetric(nativeString("Waiting"), summary.shortTermCount.toString()),
            SettingsMetric(nativeString("Signals"), summary.totalSignalCount.toString()),
            SettingsMetric(nativeString("Next Cycle"), formatDreamingNextRun(summary.nextRunAtMs)),
          ),
      )
      DreamingPanel(summary = summary)
    }
  }
}

@Composable
private fun DreamingPanel(summary: GatewayDreamingSummary) {
  Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
    val healthRows =
      listOf(
        HealthStatus(nativeString("Memory Store"), if (summary.storeHealthy) nativeString("Healthy") else nativeString("Needs attention"), summary.storeHealthy),
        HealthStatus(nativeString("Signal Index"), if (summary.phaseSignalHealthy) nativeString("Healthy") else nativeString("Needs attention"), summary.phaseSignalHealthy),
        HealthStatus(nativeString("Promoted"), nativeString("\${summary.promotedToday} today · \${summary.promotedTotal} total", summary.promotedToday, summary.promotedTotal), true),
      )
    ClawListPanel(items = healthRows, contentPadding = PaddingValues(0.dp), dividerColor = ClawTheme.colors.border) { row ->
      ClawStatusRow(title = row.title, value = row.value, healthy = row.healthy)
    }
    DreamDiaryPanel(summary = summary)
  }
}

@Composable
private fun DreamDiaryPanel(summary: GatewayDreamingSummary) {
  Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
    Text(text = nativeString("DIARY"), style = ClawTheme.type.caption, color = ClawTheme.colors.textMuted)
    if (!summary.diaryFound) {
      SettingsMessagePanel(
        title = nativeString("No dream diary yet."),
        text = nativeString("Entries appear after a dreaming cycle writes a narrative summary."),
      )
      return
    }
    if (summary.diaryEntries.isEmpty()) {
      SettingsMessagePanel(text = nativeString("The diary is waiting for its first entry."))
      return
    }
    ClawListPanel(items = summary.diaryEntries, contentPadding = PaddingValues(0.dp), dividerColor = ClawTheme.colors.border) { entry ->
      DreamDiaryRow(entry = entry)
    }
  }
}

@Composable
private fun DreamDiaryRow(entry: GatewayDreamDiaryEntry) {
  Row(
    modifier = Modifier.fillMaxWidth().padding(horizontal = 10.dp, vertical = 7.dp),
    verticalAlignment = Alignment.Top,
    horizontalArrangement = Arrangement.spacedBy(9.dp),
  ) {
    Surface(
      modifier = Modifier.size(30.dp),
      shape = CircleShape,
      color = ClawTheme.colors.surfacePressed,
      border = BorderStroke(1.dp, ClawTheme.colors.border),
    ) {
      Box(contentAlignment = Alignment.Center) {
        Text(text = "D", style = ClawTheme.type.label, color = ClawTheme.colors.text)
      }
    }
    Column(modifier = Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(1.dp)) {
      Text(
        text = entry.date.resolveNativeText(),
        style = ClawTheme.type.body,
        color = ClawTheme.colors.text,
        maxLines = 1,
        overflow = TextOverflow.Ellipsis,
      )
      Text(text = entry.text, style = ClawTheme.type.caption, color = ClawTheme.colors.textMuted, maxLines = 2, overflow = TextOverflow.Ellipsis)
    }
  }
}

/** Formats the next dreaming cycle as a compact relative label. */
private fun formatDreamingNextRun(nextRunAtMs: Long?): String {
  val next = nextRunAtMs ?: return nativeString("Not scheduled")
  val deltaMinutes = ((next - System.currentTimeMillis()) / 60_000L).coerceAtLeast(0L)
  val hours = deltaMinutes / 60L
  return when {
    hours >= 24L -> nativeString("In \${hours / 24L}d", hours / 24L)
    hours >= 1L -> nativeString("In \${hours}h", hours)
    deltaMinutes >= 1L -> nativeString("In \${deltaMinutes}m", deltaMinutes)
    else -> nativeString("Soon")
  }
}
