package ai.openclaw.app.ui

import ai.openclaw.app.GatewayHealthLogsSummary
import ai.openclaw.app.GatewayLogEntry
import ai.openclaw.app.MainViewModel
import ai.openclaw.app.ui.design.ClawPanel
import ai.openclaw.app.ui.design.ClawSecondaryButton
import ai.openclaw.app.ui.design.ClawStatus
import ai.openclaw.app.ui.design.ClawStatusPill
import ai.openclaw.app.ui.design.ClawStatusRow
import ai.openclaw.app.ui.design.ClawTheme
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp

/** Settings health screen for gateway/node status and recent gateway logs. */
@Composable
internal fun HealthLogsSettingsScreen(
  viewModel: MainViewModel,
  onBack: () -> Unit,
) {
  val isConnected by viewModel.isConnected.collectAsState()
  val isNodeConnected by viewModel.isNodeConnected.collectAsState()
  val chatHealthOk by viewModel.chatHealthOk.collectAsState()
  val statusText by viewModel.statusText.collectAsState()
  val modelCount by viewModel.modelCatalog.collectAsState()
  val pendingRunCount by viewModel.pendingRunCount.collectAsState()
  val talkStatus by viewModel.talkModeStatusText.collectAsState()
  val logsSummary by viewModel.healthLogsSummary.collectAsState()
  val logsRefreshing by viewModel.healthLogsRefreshing.collectAsState()
  val logsErrorText by viewModel.healthLogsErrorText.collectAsState()
  var selectedLogEntry by remember { mutableStateOf<GatewayLogEntry?>(null) }

  LaunchedEffect(isConnected) {
    if (isConnected) {
      // Load logs when the gateway becomes available; manual refresh covers
      // later updates so this screen does not poll.
      viewModel.refreshHealthLogs()
    }
  }

  selectedLogEntry?.let { entry ->
    GatewayLogDetailSettingsScreen(entry = entry, onBack = { selectedLogEntry = null })
    return
  }

  SettingsDetailFrame(
    title = "Health",
    subtitle = "Gateway status, phone node readiness, and recent log stream.",
    icon = Icons.Default.Settings,
    onBack = onBack,
  ) {
    SettingsMetricPanel(
      rows =
        listOf(
          SettingsMetric("Gateway", if (isConnected) "Online" else "Offline"),
          SettingsMetric("Node", if (isNodeConnected) "Online" else "Waiting"),
          SettingsMetric("Models", modelCount.size.toString()),
          SettingsMetric("Logs", logsSummary.entries.size.toString()),
        ),
    )
    HealthStatusPanel(
      gateway = statusText,
      node = if (isNodeConnected) "Online" else "Waiting",
      chat = if (chatHealthOk) "Ready" else "Needs connection",
      models = "${modelCount.size} available",
      voice = talkStatus,
      runs = if (pendingRunCount > 0) "$pendingRunCount active" else "Idle",
      isConnected = isConnected,
      isNodeConnected = isNodeConnected,
      chatHealthOk = chatHealthOk,
      modelsReady = modelCount.isNotEmpty(),
      voiceReady = talkStatus.lowercase() != "off",
    )
    Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
      ClawSecondaryButton(
        text = if (logsRefreshing) "Refreshing" else "Refresh Logs",
        onClick = viewModel::refreshHealthLogs,
        enabled = isConnected && !logsRefreshing,
        modifier = Modifier.weight(1f),
      )
    }
    logsErrorText?.let { error ->
      ClawPanel {
        Text(text = error, style = ClawTheme.type.body, color = ClawTheme.colors.warning)
      }
    }
    GatewayLogsPanel(isConnected = isConnected, summary = logsSummary, onLogClick = { selectedLogEntry = it })
  }
}

@Composable
private fun GatewayLogDetailSettingsScreen(
  entry: GatewayLogEntry,
  onBack: () -> Unit,
) {
  BackHandler(onBack = onBack)
  SettingsDetailFrame(
    title = "Log Entry",
    subtitle = "Readable gateway log detail.",
    icon = Icons.Default.Settings,
    onBack = onBack,
  ) {
    SettingsMetricPanel(
      rows =
        listOf(
          SettingsMetric("Time", compactLogTime(entry.time)),
          SettingsMetric("Level", entry.level?.uppercase() ?: "LOG"),
          SettingsMetric("Subsystem", entry.subsystem ?: "Unknown"),
        ),
    )
    ClawPanel {
      Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Text(text = "Message", style = ClawTheme.type.section, color = ClawTheme.colors.text)
        Text(text = entry.message, style = ClawTheme.type.body, color = ClawTheme.colors.text)
      }
    }
    ClawPanel {
      Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Text(text = "Raw", style = ClawTheme.type.section, color = ClawTheme.colors.text)
        Text(
          text = entry.raw.take(4_000),
          style = ClawTheme.type.caption,
          color = ClawTheme.colors.textMuted,
        )
      }
    }
  }
}

@Composable
private fun HealthStatusPanel(
  gateway: String,
  node: String,
  chat: String,
  models: String,
  voice: String,
  runs: String,
  isConnected: Boolean,
  isNodeConnected: Boolean,
  chatHealthOk: Boolean,
  modelsReady: Boolean,
  voiceReady: Boolean,
) {
  ClawPanel(contentPadding = PaddingValues(horizontal = 0.dp, vertical = 0.dp)) {
    Column {
      ClawStatusRow(title = "Gateway", value = gateway, healthy = isConnected)
      HorizontalDivider(color = ClawTheme.colors.border, thickness = 1.dp)
      ClawStatusRow(title = "Phone Node", value = node, healthy = isNodeConnected)
      HorizontalDivider(color = ClawTheme.colors.border, thickness = 1.dp)
      ClawStatusRow(title = "Chat", value = chat, healthy = chatHealthOk)
      HorizontalDivider(color = ClawTheme.colors.border, thickness = 1.dp)
      ClawStatusRow(title = "Models", value = models, healthy = modelsReady)
      HorizontalDivider(color = ClawTheme.colors.border, thickness = 1.dp)
      ClawStatusRow(title = "Voice", value = voice, healthy = voiceReady)
      HorizontalDivider(color = ClawTheme.colors.border, thickness = 1.dp)
      ClawStatusRow(title = "Runs", value = runs, healthy = true)
    }
  }
}

@Composable
private fun GatewayLogsPanel(
  isConnected: Boolean,
  summary: GatewayHealthLogsSummary,
  onLogClick: (GatewayLogEntry) -> Unit,
) {
  Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
    Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
      Text(text = "RECENT LOGS", style = ClawTheme.type.caption, color = ClawTheme.colors.textMuted)
      summary.fileName?.let { fileName ->
        Text(text = fileName, style = ClawTheme.type.caption, color = ClawTheme.colors.textSubtle, maxLines = 1, overflow = TextOverflow.Ellipsis)
      }
    }
    when {
      !isConnected ->
        ClawPanel {
          Text(text = "Connect the gateway to load recent logs.", style = ClawTheme.type.body, color = ClawTheme.colors.textMuted)
        }
      summary.entries.isEmpty() ->
        ClawPanel {
          Text(text = "No recent log entries.", style = ClawTheme.type.body, color = ClawTheme.colors.textMuted)
        }
      else ->
        ClawPanel(contentPadding = PaddingValues(horizontal = 0.dp, vertical = 0.dp)) {
          val entries = summary.entries.takeLast(12)
          Column {
            entries.forEachIndexed { index, entry ->
              GatewayLogRow(entry = entry, onClick = { onLogClick(entry) })
              if (index != entries.lastIndex) {
                HorizontalDivider(color = ClawTheme.colors.border, thickness = 1.dp)
              }
            }
          }
        }
    }
    if (summary.truncated) {
      Text(text = "Showing the latest log chunk.", style = ClawTheme.type.caption, color = ClawTheme.colors.textSubtle)
    }
  }
}

@Composable
private fun GatewayLogRow(
  entry: GatewayLogEntry,
  onClick: () -> Unit,
) {
  Row(
    modifier =
      Modifier
        .fillMaxWidth()
        .clickable(onClickLabel = "Open log entry", onClick = onClick)
        .padding(horizontal = 10.dp, vertical = 7.dp),
    verticalAlignment = Alignment.Top,
    horizontalArrangement = Arrangement.spacedBy(9.dp),
  ) {
    Text(text = compactLogTime(entry.time), style = ClawTheme.type.caption, color = ClawTheme.colors.textSubtle, modifier = Modifier.weight(0.72f), maxLines = 1)
    Column(modifier = Modifier.weight(2.7f), verticalArrangement = Arrangement.spacedBy(1.dp)) {
      Text(text = entry.message, style = ClawTheme.type.caption, color = ClawTheme.colors.text, maxLines = 2, overflow = TextOverflow.Ellipsis)
      entry.subsystem?.let { subsystem ->
        Text(text = subsystem, style = ClawTheme.type.caption, color = ClawTheme.colors.textSubtle, maxLines = 1, overflow = TextOverflow.Ellipsis)
      }
    }
    ClawStatusPill(text = entry.level?.uppercase() ?: "LOG", status = logLevelStatus(entry.level))
    Icon(
      imageVector = Icons.AutoMirrored.Filled.KeyboardArrowRight,
      contentDescription = null,
      tint = ClawTheme.colors.textSubtle,
    )
  }
}

private fun compactLogTime(value: String?): String {
  val raw = value?.trim().orEmpty()
  if (raw.isEmpty()) return "--:--"
  // Gateway log timestamps may be ISO strings or already-compact fragments;
  // keep only the HH:mm portion when present.
  val time =
    raw
      .substringAfter('T', raw)
      .substringBefore('.')
      .substringBefore('+')
      .substringBefore('Z')
  return time.takeIf { it.length >= 5 }?.take(5) ?: raw.take(5)
}

private fun logLevelStatus(level: String?): ClawStatus =
  when (level?.lowercase()) {
    "error", "fatal" -> ClawStatus.Danger
    "warn" -> ClawStatus.Warning
    "info" -> ClawStatus.Success
    else -> ClawStatus.Neutral
  }
