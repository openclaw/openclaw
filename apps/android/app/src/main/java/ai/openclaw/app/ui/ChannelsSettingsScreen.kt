package ai.openclaw.app.ui

import ai.openclaw.app.GatewayChannelSummary
import ai.openclaw.app.GatewayChannelsSummary
import ai.openclaw.app.MainViewModel
import ai.openclaw.app.i18n.nativeString
import ai.openclaw.app.ui.design.ClawListItem
import ai.openclaw.app.ui.design.ClawListPanel
import ai.openclaw.app.ui.design.ClawStatus
import ai.openclaw.app.ui.design.ClawStatusPill
import ai.openclaw.app.ui.design.ClawTextBadge
import ai.openclaw.app.ui.design.badgeInitials
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue

/** Settings screen for gateway channel readiness and account status. */
@Composable
internal fun ChannelsSettingsScreen(
  viewModel: MainViewModel,
  onBack: () -> Unit,
) {
  val state by viewModel.channelsState.collectAsState()
  val isConnected by viewModel.isConnected.collectAsState()

  SettingsRefreshOnConnect(isConnected) { viewModel.refreshChannels() }

  SettingsDetailFrame(
    subtitle = nativeString("Messaging surfaces connected to this gateway."),
    route = SettingsRoute.Channels,
    onBack = onBack,
  ) {
    SettingsRefreshControls(isConnected, state.refreshing, state.errorText, viewModel::refreshChannels)
    SettingsSummaryContent(state, isConnected, nativeString("Connect the gateway to load channels.")) { summary ->
      val channels = summary.channels
      SettingsMetricPanel(
        rows =
          listOf(
            SettingsMetric(nativeString("Channels"), channels.size.toString()),
            SettingsMetric(nativeString("Connected"), channels.count { it.connected }.toString()),
            SettingsMetric(nativeString("Configured"), channels.count { it.configured }.toString()),
            SettingsMetric(nativeString("Issues"), channels.count { it.error != null }.toString()),
          ),
      )
      if (summary.partial || summary.warnings.isNotEmpty()) {
        // Partial scans still contain useful rows; keep them visible beside the warning.
        SettingsMessagePanel(text = channelsWarningText(summary))
      }
      if (channels.isEmpty()) {
        SettingsMessagePanel(
          title = nativeString("No channels found."),
          text = nativeString("Telegram, WhatsApp, email, and other channels appear here after setup."),
        )
      } else {
        ClawListPanel(items = channels) { channel -> ChannelRow(channel) }
      }
    }
  }
}

@Composable
private fun ChannelRow(channel: GatewayChannelSummary) {
  val (statusText, status) =
    when {
      channel.error != null -> nativeString("Issue") to ClawStatus.Danger
      channel.connected -> nativeString("Connected") to ClawStatus.Success
      channel.running -> nativeString("Running") to ClawStatus.Success
      channel.linked || channel.configured -> nativeString("Ready") to ClawStatus.Neutral
      channel.enabled -> nativeString("Setup") to ClawStatus.Warning
      else -> nativeString("Off") to ClawStatus.Neutral
    }
  ClawListItem(
    title = channel.label,
    subtitle = channelSubtitle(channel),
    leading = { ClawTextBadge(text = badgeInitials(channel.label, fallback = "C")) },
    trailing = { ClawStatusPill(text = statusText, status = status) },
  )
}

private fun channelSubtitle(channel: GatewayChannelSummary): String {
  val accounts =
    when (channel.accountCount) {
      0 -> null
      1 -> nativeString("1 account")
      else -> nativeString("\${channel.accountCount} accounts", channel.accountCount)
    }
  val lifecycle =
    when {
      channel.connected -> nativeString("Connected")
      channel.running -> nativeString("Running")
      channel.linked -> nativeString("Linked")
      channel.configured -> nativeString("Configured")
      channel.enabled -> nativeString("Enabled")
      else -> nativeString("Off")
    }
  return listOfNotNull(accounts, lifecycle, channel.error).joinToString(" · ")
}

/** Chooses the first gateway warning or a generic partial-scan message. */
private fun channelsWarningText(summary: GatewayChannelsSummary): String = summary.warnings.firstOrNull()?.takeIf { it.isNotBlank() } ?: nativeString("Some channel status checks did not complete.")
