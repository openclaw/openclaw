package ai.openclaw.android.ui

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material3.Icon
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import ai.openclaw.android.MainViewModel
import ai.openclaw.android.system.SystemInfoState
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

@Composable
fun SystemInfoScreen(viewModel: MainViewModel) {
  val state by viewModel.systemInfoState.collectAsState()

  LaunchedEffect(Unit) { viewModel.refreshSystemInfo() }

  Column(
    modifier = Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = 20.dp, vertical = 14.dp),
    verticalArrangement = Arrangement.spacedBy(12.dp),
  ) {
    Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
      Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
        Text("RASPBERRY PI", style = mobileCaption1.copy(fontWeight = FontWeight.Bold, letterSpacing = 0.8.sp), color = mobileTextSecondary)
        Text(state.host ?: "Gateway", style = mobileTitle2, color = mobileText)
      }
      Surface(
        onClick = { viewModel.refreshSystemInfo() },
        shape = RoundedCornerShape(999.dp),
        color = mobileAccentSoft,
        border = BorderStroke(1.dp, mobileBorder),
      ) {
        Row(modifier = Modifier.padding(horizontal = 12.dp, vertical = 8.dp), horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
          Icon(Icons.Default.Refresh, contentDescription = null, tint = mobileAccent)
          Text(if (state.loading) "Refreshing" else "Refresh", style = mobileCaption1.copy(fontWeight = FontWeight.SemiBold), color = mobileAccent)
        }
      }
    }

    StatusSummaryCard(state)

    MetricGrid(
      listOf(
        MetricItem("IP", state.ip ?: "—"),
        MetricItem("Version", state.version ?: "—"),
        MetricItem("Platform", state.platform ?: "—"),
        MetricItem("Mode", state.mode ?: "—"),
        MetricItem("Latency", state.latencyMs?.let { "${it} ms" } ?: "—"),
        MetricItem("Sessions", state.sessionCount?.toString() ?: "—"),
        MetricItem("Channels", "${state.connectedChannelCount}/${state.channelCount}"),
        MetricItem("Heartbeat", state.heartbeatSeconds?.let { "${it}s" } ?: "—"),
      )
    )

    MetricGrid(
      listOf(
        MetricItem("CPU gateway", percent(state.cpuCoreRatio)),
        MetricItem("Event loop", percent(state.eventLoopUtilization)),
        MetricItem("RAM", "not exposed"),
        MetricItem("Temp", "not exposed"),
        MetricItem("Disk", "not exposed"),
        MetricItem("Load", state.degradedReasons.joinToString(", ").ifBlank { "normal" }),
      )
    )

    if (!state.errorText.isNullOrBlank()) {
      Surface(modifier = Modifier.fillMaxWidth(), color = Color.White, shape = RoundedCornerShape(14.dp), border = BorderStroke(1.dp, mobileDanger)) {
        Column(modifier = Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
          Text("STATUS ERROR", style = mobileCaption2.copy(letterSpacing = 0.6.sp), color = mobileDanger)
          Text(state.errorText!!, style = mobileCallout, color = mobileText)
        }
      }
    }
  }
}

@Composable
private fun StatusSummaryCard(state: SystemInfoState) {
  val ok = state.gatewayOk && !state.degraded
  val color = if (ok) mobileSuccess else if (state.gatewayOk) mobileWarning else mobileDanger
  val soft = if (ok) mobileSuccessSoft else if (state.gatewayOk) mobileWarningSoft else mobileDangerSoft
  Surface(modifier = Modifier.fillMaxWidth(), color = soft, shape = RoundedCornerShape(18.dp), border = BorderStroke(1.dp, color.copy(alpha = 0.35f))) {
    Column(modifier = Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
      Text(if (ok) "Gateway healthy" else if (state.gatewayOk) "Gateway reachable, degraded" else "Gateway offline", style = mobileTitle2.copy(fontWeight = FontWeight.Bold), color = color)
      Text("Last update: ${formatTime(state.lastUpdatedMs)}", style = mobileCaption1, color = mobileTextSecondary)
    }
  }
}

@Composable
private fun MetricGrid(items: List<MetricItem>) {
  Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
    items.chunked(2).forEach { row ->
      Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        row.forEach { item -> MetricCard(item, Modifier.weight(1f)) }
        if (row.size == 1) androidx.compose.foundation.layout.Spacer(modifier = Modifier.weight(1f))
      }
    }
  }
}

@Composable
private fun MetricCard(item: MetricItem, modifier: Modifier = Modifier) {
  Surface(modifier = modifier, color = Color.White, shape = RoundedCornerShape(16.dp), border = BorderStroke(1.dp, mobileBorder), shadowElevation = 0.dp) {
    Column(modifier = Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
      Text(item.label.uppercase(Locale.US), style = mobileCaption2.copy(letterSpacing = 0.5.sp), color = mobileTextSecondary)
      Text(item.value, style = mobileCallout.copy(fontWeight = FontWeight.SemiBold), color = mobileText)
    }
  }
}

private data class MetricItem(val label: String, val value: String)

private fun percent(value: Double?): String = value?.let { "%.0f%%".format(Locale.US, it * 100.0) } ?: "—"
private fun formatTime(value: Long?): String = value?.let { SimpleDateFormat("HH:mm:ss", Locale.US).format(Date(it)) } ?: "—"
