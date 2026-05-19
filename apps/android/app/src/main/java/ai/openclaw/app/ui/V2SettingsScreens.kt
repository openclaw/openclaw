package ai.openclaw.app.ui

import ai.openclaw.app.BuildConfig
import ai.openclaw.app.GatewayAgentSummary
import ai.openclaw.app.GatewayCronJobSummary
import ai.openclaw.app.GatewayUsageProviderSummary
import ai.openclaw.app.LocationMode
import ai.openclaw.app.MainViewModel
import ai.openclaw.app.NotificationPackageFilterMode
import ai.openclaw.app.chat.ChatPendingToolCall
import ai.openclaw.app.ui.design.ClawDetailRow
import ai.openclaw.app.ui.design.ClawIconBadge
import ai.openclaw.app.ui.design.ClawListPanel
import ai.openclaw.app.ui.design.ClawPanel
import ai.openclaw.app.ui.design.ClawPrimaryButton
import ai.openclaw.app.ui.design.ClawScaffold
import ai.openclaw.app.ui.design.ClawSecondaryButton
import ai.openclaw.app.ui.design.ClawSegmentedControl
import ai.openclaw.app.ui.design.ClawStatus
import ai.openclaw.app.ui.design.ClawStatusPill
import ai.openclaw.app.ui.design.ClawTextBadge
import ai.openclaw.app.ui.design.ClawTextField
import ai.openclaw.app.ui.design.ClawTheme
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.automirrored.filled.ScreenShare
import androidx.compose.material.icons.automirrored.filled.VolumeUp
import androidx.compose.material.icons.filled.Bolt
import androidx.compose.material.icons.filled.CameraAlt
import androidx.compose.material.icons.filled.Cloud
import androidx.compose.material.icons.filled.GraphicEq
import androidx.compose.material.icons.filled.Info
import androidx.compose.material.icons.filled.LocationOn
import androidx.compose.material.icons.filled.Lock
import androidx.compose.material.icons.filled.Mic
import androidx.compose.material.icons.filled.Notifications
import androidx.compose.material.icons.filled.Palette
import androidx.compose.material.icons.filled.Person
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material.icons.filled.Storage
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.Surface
import androidx.compose.material3.Switch
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
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp

internal enum class V2SettingsRoute {
  Home,
  Profile,
  Voice,
  Agents,
  Approvals,
  CronJobs,
  Usage,
  Skills,
  NodesDevices,
  Channels,
  Dreaming,
  Canvas,
  Notifications,
  PhoneCapabilities,
  Gateway,
  Appearance,
  Health,
  About,
}

@Composable
internal fun V2SettingsDetailScreen(
  viewModel: MainViewModel,
  route: V2SettingsRoute,
  onBack: () -> Unit,
) {
  when (route) {
    V2SettingsRoute.Home -> Unit
    V2SettingsRoute.Profile -> V2ProfileSettingsScreen(viewModel = viewModel, onBack = onBack)
    V2SettingsRoute.Voice -> V2VoiceSettingsScreen(viewModel = viewModel, onBack = onBack)
    V2SettingsRoute.Agents -> V2AgentsSettingsScreen(viewModel = viewModel, onBack = onBack)
    V2SettingsRoute.Approvals -> V2ApprovalsSettingsScreen(viewModel = viewModel, onBack = onBack)
    V2SettingsRoute.CronJobs -> V2CronJobsSettingsScreen(viewModel = viewModel, onBack = onBack)
    V2SettingsRoute.Usage -> V2UsageSettingsScreen(viewModel = viewModel, onBack = onBack)
    V2SettingsRoute.Skills -> V2SkillsSettingsScreen(viewModel = viewModel, onBack = onBack)
    V2SettingsRoute.NodesDevices -> V2NodesDevicesSettingsScreen(viewModel = viewModel, onBack = onBack)
    V2SettingsRoute.Channels -> V2ChannelsSettingsScreen(viewModel = viewModel, onBack = onBack)
    V2SettingsRoute.Dreaming -> V2DreamingSettingsScreen(viewModel = viewModel, onBack = onBack)
    V2SettingsRoute.Canvas -> V2CanvasSettingsScreen(viewModel = viewModel, onBack = onBack)
    V2SettingsRoute.Notifications -> V2NotificationSettingsScreen(viewModel = viewModel, onBack = onBack)
    V2SettingsRoute.PhoneCapabilities -> V2PhoneCapabilitiesScreen(viewModel = viewModel, onBack = onBack)
    V2SettingsRoute.Gateway -> V2GatewaySettingsScreen(viewModel = viewModel, onBack = onBack)
    V2SettingsRoute.Appearance -> V2AppearanceSettingsScreen(onBack = onBack)
    V2SettingsRoute.Health -> V2HealthLogsSettingsScreen(viewModel = viewModel, onBack = onBack)
    V2SettingsRoute.About -> V2AboutSettingsScreen(viewModel = viewModel, onBack = onBack)
  }
}

@Composable
private fun V2UsageSettingsScreen(
  viewModel: MainViewModel,
  onBack: () -> Unit,
) {
  val usageSummary by viewModel.usageSummary.collectAsState()
  val usageRefreshing by viewModel.usageRefreshing.collectAsState()
  val usageErrorText by viewModel.usageErrorText.collectAsState()
  val isConnected by viewModel.isConnected.collectAsState()
  val providerCount = usageSummary.providers.size
  val issueCount = usageSummary.providers.count { it.error != null }

  LaunchedEffect(isConnected) {
    if (isConnected) {
      viewModel.refreshUsage()
    }
  }

  V2SettingsDetailFrame(title = "Usage", subtitle = "Provider limits and quota health.", icon = Icons.Default.Storage, onBack = onBack) {
    V2SettingsMetricPanel(
      rows =
        listOf(
          V2SettingsMetric("Providers", providerCount.toString()),
          V2SettingsMetric("Issues", issueCount.toString()),
          V2SettingsMetric("Updated", formatUsageUpdated(usageSummary.updatedAtMs)),
        ),
    )
    Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
      ClawSecondaryButton(text = if (usageRefreshing) "Refreshing" else "Refresh", onClick = viewModel::refreshUsage, enabled = isConnected && !usageRefreshing, modifier = Modifier.weight(1f))
    }
    usageErrorText?.let { errorText ->
      ClawPanel {
        Text(text = errorText, style = ClawTheme.type.body, color = ClawTheme.colors.warning)
      }
    }
    when {
      !isConnected ->
        ClawPanel {
          Text(text = "Connect the gateway to load usage.", style = ClawTheme.type.body, color = ClawTheme.colors.textMuted)
        }
      usageSummary.providers.isEmpty() ->
        ClawPanel {
          Column(verticalArrangement = Arrangement.spacedBy(3.dp)) {
            Text(text = "No usage data yet.", style = ClawTheme.type.section, color = ClawTheme.colors.text)
            Text(text = "Provider limits will appear here when your gateway reports them.", style = ClawTheme.type.body, color = ClawTheme.colors.textMuted)
          }
        }
      else -> V2UsageProvidersPanel(providers = usageSummary.providers)
    }
  }
}

@Composable
private fun V2CronJobsSettingsScreen(
  viewModel: MainViewModel,
  onBack: () -> Unit,
) {
  val cronStatus by viewModel.cronStatus.collectAsState()
  val cronJobs by viewModel.cronJobs.collectAsState()
  val cronRefreshing by viewModel.cronRefreshing.collectAsState()
  val cronSaving by viewModel.cronSaving.collectAsState()
  val cronErrorText by viewModel.cronErrorText.collectAsState()
  val isConnected by viewModel.isConnected.collectAsState()
  var showEditor by remember { mutableStateOf(false) }
  var jobName by remember { mutableStateOf("") }
  var jobMessage by remember { mutableStateOf("") }
  var scheduleKind by remember { mutableStateOf("Every") }
  var scheduleValue by remember { mutableStateOf("1h") }

  LaunchedEffect(isConnected) {
    if (isConnected) {
      viewModel.refreshCronJobs()
    }
  }

  V2SettingsDetailFrame(title = "Cron Jobs", subtitle = "Scheduled OpenClaw work from your gateway.", icon = Icons.Default.Bolt, onBack = onBack) {
    V2SettingsMetricPanel(
      rows =
        listOf(
          V2SettingsMetric("Status", if (cronStatus.enabled) "Enabled" else "Off"),
          V2SettingsMetric("Jobs", cronStatus.jobs.toString()),
          V2SettingsMetric("Next Wake", formatCronWake(cronStatus.nextWakeAtMs)),
        ),
    )
    Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
      ClawSecondaryButton(text = if (cronRefreshing) "Refreshing" else "Refresh", onClick = viewModel::refreshCronJobs, enabled = isConnected && !cronRefreshing, modifier = Modifier.weight(1f))
      ClawPrimaryButton(text = if (showEditor) "Close" else "New Job", onClick = { showEditor = !showEditor }, enabled = isConnected, modifier = Modifier.weight(1f))
    }
    if (showEditor) {
      V2CronJobEditorPanel(
        name = jobName,
        onNameChange = { jobName = it },
        message = jobMessage,
        onMessageChange = { jobMessage = it },
        scheduleKind = scheduleKind,
        onScheduleKindChange = {
          scheduleKind = it
          scheduleValue =
            when (it) {
              "Once" -> "+30m"
              "Cron" -> "0 9 * * *"
              else -> "1h"
            }
        },
        scheduleValue = scheduleValue,
        onScheduleValueChange = { scheduleValue = it },
        saving = cronSaving,
        onSave = {
          viewModel.createCronJob(
            name = jobName,
            message = jobMessage,
            scheduleKind = scheduleKind,
            scheduleValue = scheduleValue,
          )
        },
      )
    }
    cronErrorText?.let { errorText ->
      ClawPanel {
        Text(text = errorText, style = ClawTheme.type.body, color = ClawTheme.colors.warning)
      }
    }
    when {
      !isConnected ->
        ClawPanel {
          Text(text = "Connect the gateway to load cron jobs.", style = ClawTheme.type.body, color = ClawTheme.colors.textMuted)
        }
      cronJobs.isEmpty() ->
        ClawPanel {
          Column(verticalArrangement = Arrangement.spacedBy(3.dp)) {
            Text(text = "No scheduled jobs.", style = ClawTheme.type.section, color = ClawTheme.colors.text)
            Text(text = "Create recurring OpenClaw work here or from the WebUI.", style = ClawTheme.type.body, color = ClawTheme.colors.textMuted)
          }
        }
      else -> V2CronJobsPanel(jobs = cronJobs)
    }
  }
}

@Composable
private fun V2CronJobEditorPanel(
  name: String,
  onNameChange: (String) -> Unit,
  message: String,
  onMessageChange: (String) -> Unit,
  scheduleKind: String,
  onScheduleKindChange: (String) -> Unit,
  scheduleValue: String,
  onScheduleValueChange: (String) -> Unit,
  saving: Boolean,
  onSave: () -> Unit,
) {
  ClawPanel {
    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
      Text(text = "New Job", style = ClawTheme.type.section, color = ClawTheme.colors.text)
      ClawTextField(value = name, onValueChange = onNameChange, placeholder = "Name")
      ClawTextField(value = message, onValueChange = onMessageChange, placeholder = "Message OpenClaw should run", minLines = 3)
      ClawSegmentedControl(
        options = listOf("Every", "Once", "Cron"),
        selected = scheduleKind,
        onSelect = onScheduleKindChange,
        modifier = Modifier.fillMaxWidth(),
      )
      ClawTextField(value = scheduleValue, onValueChange = onScheduleValueChange, placeholder = cronSchedulePlaceholder(scheduleKind))
      ClawPrimaryButton(text = if (saving) "Saving" else "Save Job", onClick = onSave, enabled = !saving, modifier = Modifier.fillMaxWidth())
    }
  }
}

private fun cronSchedulePlaceholder(scheduleKind: String): String =
  when (scheduleKind) {
    "Once" -> "+30m or 2026-05-19T18:00:00Z"
    "Cron" -> "0 9 * * *"
    else -> "15m, 1h, or 1d"
  }

@Composable
private fun V2AgentsSettingsScreen(
  viewModel: MainViewModel,
  onBack: () -> Unit,
) {
  val agents by viewModel.gatewayAgents.collectAsState()
  val defaultAgentId by viewModel.gatewayDefaultAgentId.collectAsState()
  val isConnected by viewModel.isConnected.collectAsState()

  LaunchedEffect(isConnected) {
    if (isConnected) {
      viewModel.refreshAgents()
    }
  }

  V2SettingsDetailFrame(title = "Agents", subtitle = "Choose and inspect the assistants available on this gateway.", icon = Icons.Default.Person, onBack = onBack) {
    V2SettingsMetricPanel(
      rows =
        listOf(
          V2SettingsMetric("Available", agents.size.toString()),
          V2SettingsMetric("Default", defaultAgentName(agents, defaultAgentId)),
        ),
    )
    when {
      !isConnected ->
        ClawPanel {
          Text(text = "Connect the gateway to load agents.", style = ClawTheme.type.body, color = ClawTheme.colors.textMuted)
        }
      agents.isEmpty() ->
        ClawPanel {
          Text(text = "No agents loaded yet.", style = ClawTheme.type.body, color = ClawTheme.colors.textMuted)
        }
      else -> V2AgentsPanel(agents = agents, defaultAgentId = defaultAgentId)
    }
  }
}

@Composable
private fun V2ApprovalsSettingsScreen(
  viewModel: MainViewModel,
  onBack: () -> Unit,
) {
  val pendingToolCalls by viewModel.chatPendingToolCalls.collectAsState()
  val pendingRunCount by viewModel.pendingRunCount.collectAsState()
  val waitingCount = pendingToolCalls.count { it.isError != true }
  val issueCount = pendingToolCalls.count { it.isError == true }

  V2SettingsDetailFrame(title = "Approvals", subtitle = "Review actions that need your attention.", icon = Icons.Default.Lock, onBack = onBack) {
    V2SettingsMetricPanel(
      rows =
        listOf(
          V2SettingsMetric("Pending", waitingCount.toString()),
          V2SettingsMetric("Issues", issueCount.toString()),
          V2SettingsMetric("Active Runs", pendingRunCount.toString()),
        ),
    )
    if (pendingToolCalls.isEmpty()) {
      ClawPanel {
        Column(verticalArrangement = Arrangement.spacedBy(3.dp)) {
          Text(text = "Nothing needs approval.", style = ClawTheme.type.section, color = ClawTheme.colors.text)
          Text(text = "OpenClaw will show action requests here when a session pauses for review.", style = ClawTheme.type.body, color = ClawTheme.colors.textMuted)
        }
      }
    } else {
      V2ApprovalsPanel(toolCalls = pendingToolCalls)
    }
  }
}

@Composable
private fun V2ProfileSettingsScreen(
  viewModel: MainViewModel,
  onBack: () -> Unit,
) {
  val displayName by viewModel.displayName.collectAsState()
  var draft by remember(displayName) { mutableStateOf(displayName.ifBlank { "OpenClaw" }) }

  V2SettingsDetailFrame(title = "Profile", subtitle = "How this phone appears to OpenClaw.", icon = Icons.Default.Person, onBack = onBack) {
    ClawPanel {
      Column(verticalArrangement = Arrangement.spacedBy(9.dp)) {
        ClawTextField(value = draft, onValueChange = { draft = it }, placeholder = "Device name")
        ClawPrimaryButton(text = "Save Profile", onClick = { viewModel.setDisplayName(draft) }, enabled = draft.isNotBlank())
      }
    }
  }
}

@Composable
private fun V2VoiceSettingsScreen(
  viewModel: MainViewModel,
  onBack: () -> Unit,
) {
  val speakerEnabled by viewModel.speakerEnabled.collectAsState()
  val micEnabled by viewModel.micEnabled.collectAsState()
  val talkModeEnabled by viewModel.talkModeEnabled.collectAsState()

  V2SettingsDetailFrame(title = "Talk Provider Setup", subtitle = "Configure voice, transport, and playback.", icon = Icons.Default.Mic, onBack = onBack) {
    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
      V2VoiceSetupPanel(
        voiceActive = micEnabled || talkModeEnabled,
      )
      Text(text = "Audio Test", style = ClawTheme.type.section, color = ClawTheme.colors.text)
      Text(text = "Check that OpenClaw can speak clearly on this phone.", style = ClawTheme.type.body, color = ClawTheme.colors.textMuted)
      V2SettingsWaveformPanel(active = speakerEnabled)
      V2VoiceSetupActionRow(
        title = if (speakerEnabled) "Mute speaker" else "Enable speaker",
        subtitle = if (speakerEnabled) "Replies play aloud" else "Assistant speech muted",
        icon = Icons.AutoMirrored.Filled.VolumeUp,
        statusText = if (speakerEnabled) "On" else "Muted",
        ready = speakerEnabled,
        onClick = { viewModel.setSpeakerEnabled(!speakerEnabled) },
      )
      ClawPrimaryButton(text = "Save Voice Setup", onClick = onBack, modifier = Modifier.fillMaxWidth(), icon = Icons.Default.GraphicEq)
    }
  }
}

@Composable
private fun V2VoiceSetupPanel(
  voiceActive: Boolean,
) {
  Column(verticalArrangement = Arrangement.spacedBy(9.dp)) {
    V2VoiceSetupActionRow(
      title = "Realtime Provider",
      subtitle = "Gateway voice relay",
      icon = Icons.Default.GraphicEq,
      statusText = if (voiceActive) "Live" else "Ready",
      ready = true,
    )
    V2VoiceSetupActionRow(
      title = "Voice",
      subtitle = "Voice input",
      icon = Icons.Default.Mic,
      statusText = "Configured",
      ready = true,
    )
    V2VoiceSetupActionRow(
      title = "Transport",
      subtitle = "Socket relay",
      icon = Icons.Default.Bolt,
      statusText = "Configured",
      ready = true,
    )
  }
}

@Composable
private fun V2VoiceSetupActionRow(
  title: String,
  subtitle: String,
  icon: ImageVector,
  statusText: String,
  ready: Boolean,
  onClick: (() -> Unit)? = null,
) {
  val rowModifier = Modifier.fillMaxWidth().heightIn(min = 68.dp)
  Surface(
    onClick = onClick ?: {},
    enabled = onClick != null,
    modifier = rowModifier,
    shape = RoundedCornerShape(ClawTheme.radii.panel),
    color = ClawTheme.colors.surface,
    contentColor = ClawTheme.colors.text,
    border = BorderStroke(1.dp, ClawTheme.colors.border),
  ) {
    Row(
      modifier = Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 10.dp),
      verticalAlignment = Alignment.CenterVertically,
      horizontalArrangement = Arrangement.spacedBy(11.dp),
    ) {
      Surface(
        modifier = Modifier.size(38.dp),
        shape = CircleShape,
        color = ClawTheme.colors.canvas,
        contentColor = ClawTheme.colors.text,
        border = BorderStroke(1.dp, ClawTheme.colors.borderStrong),
      ) {
        Box(contentAlignment = Alignment.Center) {
          Icon(imageVector = icon, contentDescription = null, modifier = Modifier.size(19.dp))
        }
      }
      Column(modifier = Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
        Text(text = title, style = ClawTheme.type.section, color = ClawTheme.colors.text, maxLines = 1, overflow = TextOverflow.Ellipsis)
        Text(text = subtitle, style = ClawTheme.type.body, color = ClawTheme.colors.textMuted, maxLines = 1, overflow = TextOverflow.Ellipsis)
      }
      Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(7.dp)) {
        Box(
          modifier =
            Modifier
              .size(7.dp)
              .background(if (ready) ClawTheme.colors.success else ClawTheme.colors.textSubtle, CircleShape),
        )
        Text(text = statusText, style = ClawTheme.type.body, color = ClawTheme.colors.textMuted, maxLines = 1)
        Icon(imageVector = Icons.AutoMirrored.Filled.KeyboardArrowRight, contentDescription = null, modifier = Modifier.size(20.dp), tint = ClawTheme.colors.textMuted)
      }
    }
  }
}

@Composable
private fun V2SettingsWaveformPanel(active: Boolean) {
  Surface(
    modifier = Modifier.fillMaxWidth().height(76.dp),
    shape = RoundedCornerShape(ClawTheme.radii.panel),
    color = ClawTheme.colors.surface,
    contentColor = ClawTheme.colors.text,
    border = BorderStroke(1.dp, ClawTheme.colors.border),
  ) {
    Row(
      modifier = Modifier.fillMaxWidth().padding(horizontal = 18.dp),
      verticalAlignment = Alignment.CenterVertically,
      horizontalArrangement = Arrangement.spacedBy(5.dp),
    ) {
      Icon(imageVector = Icons.Default.PlayArrow, contentDescription = null, modifier = Modifier.size(24.dp), tint = ClawTheme.colors.text)
      Row(modifier = Modifier.weight(1f), horizontalArrangement = Arrangement.SpaceEvenly, verticalAlignment = Alignment.CenterVertically) {
        listOf(6, 12, 18, 11, 28, 34, 18, 10, 8, 24, 38, 31, 12, 8, 18, 30, 40, 22, 12, 8, 20, 29, 16, 8).forEachIndexed { index, height ->
          Box(
            modifier =
              Modifier
                .size(width = 2.dp, height = (if (active) height else 7 + index % 4 * 4).dp)
                .background(if (active) ClawTheme.colors.text else ClawTheme.colors.textSubtle, RoundedCornerShape(999.dp)),
          )
        }
      }
    }
  }
}

@Composable
private fun V2NotificationSettingsScreen(
  viewModel: MainViewModel,
  onBack: () -> Unit,
) {
  val enabled by viewModel.notificationForwardingEnabled.collectAsState()
  val mode by viewModel.notificationForwardingMode.collectAsState()
  val packages by viewModel.notificationForwardingPackages.collectAsState()
  val quietEnabled by viewModel.notificationForwardingQuietHoursEnabled.collectAsState()
  val quietStart by viewModel.notificationForwardingQuietStart.collectAsState()
  val quietEnd by viewModel.notificationForwardingQuietEnd.collectAsState()
  val maxEventsPerMinute by viewModel.notificationForwardingMaxEventsPerMinute.collectAsState()
  val modeLabel = if (mode == NotificationPackageFilterMode.Blocklist) "Blocklist" else "Allowlist"

  V2SettingsDetailFrame(title = "Notifications", subtitle = "Choose what reaches OpenClaw.", icon = Icons.Default.Notifications, onBack = onBack) {
    V2SettingsTogglePanel(
      rows =
        listOf(
          V2SettingsToggleRow("Forward Notifications", if (enabled) "OpenClaw can receive selected alerts." else "Alerts stay on this phone.", Icons.Default.Notifications, enabled, viewModel::setNotificationForwardingEnabled),
          V2SettingsToggleRow("Quiet Hours", "$quietStart to $quietEnd", Icons.Default.Bolt, quietEnabled) { checked ->
            viewModel.setNotificationForwardingQuietHours(enabled = checked, start = quietStart, end = quietEnd)
          },
        ),
    )
    V2SettingsMetricPanel(
      rows =
        listOf(
          V2SettingsMetric("Policy", modeLabel),
          V2SettingsMetric("Selected Apps", packages.size.toString()),
          V2SettingsMetric("Rate Limit", "$maxEventsPerMinute/min"),
        ),
    )
    ClawPanel {
      Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(text = "Forwarding Mode", style = ClawTheme.type.section, color = ClawTheme.colors.text)
        ClawSegmentedControl(
          options = listOf("Blocklist", "Allowlist"),
          selected = modeLabel,
          onSelect = { selected ->
            viewModel.setNotificationForwardingMode(if (selected == "Allowlist") NotificationPackageFilterMode.Allowlist else NotificationPackageFilterMode.Blocklist)
          },
        )
      }
    }
  }
}

@Composable
private fun V2PhoneCapabilitiesScreen(
  viewModel: MainViewModel,
  onBack: () -> Unit,
) {
  val cameraEnabled by viewModel.cameraEnabled.collectAsState()
  val locationMode by viewModel.locationMode.collectAsState()
  val locationPreciseEnabled by viewModel.locationPreciseEnabled.collectAsState()
  val preventSleep by viewModel.preventSleep.collectAsState()
  val canvasDebugStatusEnabled by viewModel.canvasDebugStatusEnabled.collectAsState()

  V2SettingsDetailFrame(title = "Phone Capabilities", subtitle = "Choose what this phone can share.", icon = Icons.AutoMirrored.Filled.ScreenShare, onBack = onBack) {
    V2SettingsTogglePanel(
      rows =
        listOf(
          V2SettingsToggleRow("Camera", "Allow camera tools when requested.", Icons.Default.CameraAlt, cameraEnabled, viewModel::setCameraEnabled),
          V2SettingsToggleRow("Precise Location", "Share precise location while location is enabled.", Icons.Default.LocationOn, locationPreciseEnabled, viewModel::setLocationPreciseEnabled),
          V2SettingsToggleRow("Keep Awake", "Keep the node available during active work.", Icons.Default.Bolt, preventSleep, viewModel::setPreventSleep),
          V2SettingsToggleRow("Canvas Status", "Show screen-sharing debug state.", Icons.AutoMirrored.Filled.ScreenShare, canvasDebugStatusEnabled, viewModel::setCanvasDebugStatusEnabled),
        ),
    )
    ClawPanel {
      Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(text = "Location", style = ClawTheme.type.section, color = ClawTheme.colors.text)
        ClawSegmentedControl(
          options = listOf("Off", "While Using"),
          selected = if (locationMode == LocationMode.WhileUsing) "While Using" else "Off",
          onSelect = { selected -> viewModel.setLocationMode(if (selected == "While Using") LocationMode.WhileUsing else LocationMode.Off) },
        )
      }
    }
  }
}

@Composable
private fun V2GatewaySettingsScreen(
  viewModel: MainViewModel,
  onBack: () -> Unit,
) {
  val isConnected by viewModel.isConnected.collectAsState()
  val isNodeConnected by viewModel.isNodeConnected.collectAsState()
  val statusText by viewModel.statusText.collectAsState()
  val serverName by viewModel.serverName.collectAsState()
  val remoteAddress by viewModel.remoteAddress.collectAsState()

  V2SettingsDetailFrame(title = "Gateway", subtitle = "Connection between this phone and OpenClaw.", icon = Icons.Default.Cloud, onBack = onBack) {
    V2SettingsMetricPanel(
      rows =
        listOf(
          V2SettingsMetric("Connection", if (isConnected) "Connected" else "Offline"),
          V2SettingsMetric("Node", if (isNodeConnected) "Online" else "Not paired"),
          V2SettingsMetric("Gateway", serverName?.takeIf { it.isNotBlank() } ?: "Home Gateway"),
          V2SettingsMetric("Address", remoteAddress?.takeIf { it.isNotBlank() } ?: "Not available"),
          V2SettingsMetric("Status", statusText),
        ),
    )
    Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
      ClawPrimaryButton(text = "Reconnect", onClick = viewModel::refreshGatewayConnection, modifier = Modifier.weight(1f))
      ClawSecondaryButton(text = "Disconnect", onClick = viewModel::disconnect, modifier = Modifier.weight(1f))
    }
  }
}

@Composable
private fun V2AppearanceSettingsScreen(onBack: () -> Unit) {
  V2SettingsDetailFrame(title = "Appearance", subtitle = "A calm, high-contrast OpenClaw interface.", icon = Icons.Default.Palette, onBack = onBack) {
    V2SettingsMetricPanel(
      rows =
        listOf(
          V2SettingsMetric("Theme", "Dark"),
          V2SettingsMetric("Contrast", "High"),
          V2SettingsMetric("Typography", "Readable"),
        ),
    )
    ClawPanel {
      Text(text = "The v2 app uses a fixed premium dark theme so it stays consistent across devices.", style = ClawTheme.type.body, color = ClawTheme.colors.textMuted)
    }
  }
}

@Composable
private fun V2AboutSettingsScreen(
  viewModel: MainViewModel,
  onBack: () -> Unit,
) {
  val isConnected by viewModel.isConnected.collectAsState()
  val serverName by viewModel.serverName.collectAsState()
  val gatewayVersion by viewModel.gatewayVersion.collectAsState()
  val updateAvailable by viewModel.gatewayUpdateAvailable.collectAsState()
  val latestVersion = updateAvailable?.latestVersion?.takeIf { it.isNotBlank() }
  val currentGatewayVersion = updateAvailable?.currentVersion?.takeIf { it.isNotBlank() } ?: gatewayVersion

  V2SettingsDetailFrame(title = "About", subtitle = "OpenClaw for Android.", icon = Icons.Default.Info, onBack = onBack) {
    V2SettingsMetricPanel(
      rows =
        listOf(
          V2SettingsMetric("Android App", BuildConfig.VERSION_NAME),
          V2SettingsMetric("Build", BuildConfig.VERSION_CODE.toString()),
          V2SettingsMetric("Channel", "Play"),
          V2SettingsMetric("Gateway", currentGatewayVersion ?: "Not connected"),
        ),
    )
    ClawPanel(contentPadding = PaddingValues(horizontal = 0.dp, vertical = 0.dp)) {
      Column {
        V2AboutStatusRow(title = "Gateway", value = serverName?.takeIf { it.isNotBlank() } ?: "Home Gateway", healthy = isConnected)
        HorizontalDivider(color = ClawTheme.colors.border, thickness = 1.dp)
        V2AboutStatusRow(title = "Runtime", value = currentGatewayVersion ?: "Waiting", healthy = currentGatewayVersion != null)
        HorizontalDivider(color = ClawTheme.colors.border, thickness = 1.dp)
        V2AboutStatusRow(
          title = "Update",
          value = latestVersion?.let { "v$it available" } ?: "Up to date",
          healthy = latestVersion == null,
        )
      }
    }
    ClawPanel {
      Text(text = aboutUpdateText(latestVersion = latestVersion), style = ClawTheme.type.body, color = ClawTheme.colors.textMuted)
    }
  }
}

@Composable
private fun V2AboutStatusRow(
  title: String,
  value: String,
  healthy: Boolean,
) {
  Row(
    modifier = Modifier.fillMaxWidth().padding(horizontal = 10.dp, vertical = 7.dp),
    verticalAlignment = Alignment.CenterVertically,
    horizontalArrangement = Arrangement.spacedBy(9.dp),
  ) {
    Column(modifier = Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(1.dp)) {
      Text(text = title, style = ClawTheme.type.body, color = ClawTheme.colors.text, maxLines = 1)
      Text(text = value, style = ClawTheme.type.caption, color = ClawTheme.colors.textMuted, maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
    ClawStatusPill(text = if (healthy) "OK" else "Check", status = if (healthy) ClawStatus.Success else ClawStatus.Warning)
  }
}

private fun aboutUpdateText(latestVersion: String?): String =
  if (latestVersion == null) {
    "OpenClaw turns this phone into a clean mobile command surface for sessions, voice, providers, and Gateway."
  } else {
    "A Gateway update is available. Run the update from the Web UI or CLI when you are ready."
  }

@Composable
internal fun V2SettingsDetailFrame(
  title: String,
  subtitle: String,
  icon: ImageVector,
  onBack: () -> Unit,
  content: @Composable () -> Unit,
) {
  ClawScaffold(contentPadding = PaddingValues(start = 20.dp, top = 14.dp, end = 20.dp, bottom = 20.dp)) {
    LazyColumn(verticalArrangement = Arrangement.spacedBy(10.dp)) {
      item {
        Row(modifier = Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(9.dp)) {
          V2SettingsBackButton(onClick = onBack)
          Text(text = title, style = ClawTheme.type.title, color = ClawTheme.colors.text, modifier = Modifier.weight(1f), maxLines = 1, overflow = TextOverflow.Ellipsis)
          V2SettingsIconMark(icon = icon)
        }
      }
      item {
        Text(text = subtitle, style = ClawTheme.type.body, color = ClawTheme.colors.textMuted)
      }
      item {
        content()
      }
      item {
        Spacer(modifier = Modifier.height(12.dp))
      }
    }
  }
}

private data class V2SettingsToggleRow(
  val title: String,
  val subtitle: String,
  val icon: ImageVector,
  val checked: Boolean,
  val onCheckedChange: (Boolean) -> Unit,
)

internal data class V2SettingsMetric(
  val title: String,
  val value: String,
)

@Composable
private fun V2ApprovalsPanel(toolCalls: List<ChatPendingToolCall>) {
  ClawListPanel(items = toolCalls) { toolCall ->
    V2ApprovalListRow(toolCall = toolCall)
  }
}

@Composable
private fun V2ApprovalListRow(toolCall: ChatPendingToolCall) {
  val hasIssue = toolCall.isError == true
  ClawDetailRow(
    title = approvalActionName(toolCall.name),
    subtitle = approvalSubtitle(toolCall, hasIssue),
    leading = { ClawIconBadge(icon = Icons.Default.Lock) },
    trailing = { ClawStatusPill(text = if (hasIssue) "Issue" else "Review", status = if (hasIssue) ClawStatus.Warning else ClawStatus.Success) },
  )
}

@Composable
private fun V2CronJobsPanel(jobs: List<GatewayCronJobSummary>) {
  ClawListPanel(items = jobs) { job ->
    V2CronJobListRow(job = job)
  }
}

@Composable
private fun V2UsageProvidersPanel(providers: List<GatewayUsageProviderSummary>) {
  ClawListPanel(items = providers) { provider ->
    V2UsageProviderListRow(provider = provider)
  }
}

@Composable
private fun V2UsageProviderListRow(provider: GatewayUsageProviderSummary) {
  val hasIssue = provider.error != null
  ClawDetailRow(
    title = provider.displayName,
    subtitle = usageProviderSubtitle(provider),
    leading = { ClawTextBadge(text = provider.displayName.firstOrNull()?.uppercase() ?: "U") },
    trailing = { ClawStatusPill(text = if (hasIssue) "Issue" else "OK", status = if (hasIssue) ClawStatus.Warning else ClawStatus.Success) },
  )
}

@Composable
private fun V2CronJobListRow(job: GatewayCronJobSummary) {
  ClawDetailRow(
    title = job.name,
    subtitle = cronJobSubtitle(job),
    leading = { ClawIconBadge(icon = Icons.Default.Bolt) },
    trailing = { ClawStatusPill(text = cronJobStatusText(job), status = cronJobStatus(job)) },
  )
}

@Composable
private fun V2AgentsPanel(
  agents: List<GatewayAgentSummary>,
  defaultAgentId: String?,
) {
  ClawListPanel(items = agents) { agent ->
    V2AgentListRow(agent = agent, isDefault = agent.id == defaultAgentId)
  }
}

@Composable
private fun V2AgentListRow(
  agent: GatewayAgentSummary,
  isDefault: Boolean,
) {
  ClawDetailRow(
    title = agent.name?.takeIf { it.isNotBlank() } ?: agent.id,
    subtitle = if (isDefault) "Default assistant" else "Ready",
    leading = { ClawTextBadge(text = agentBadge(agent)) },
    trailing = { ClawStatusPill(text = if (isDefault) "Default" else "Ready", status = ClawStatus.Success) },
  )
}

private fun defaultAgentName(
  agents: List<GatewayAgentSummary>,
  defaultAgentId: String?,
): String {
  val defaultId = defaultAgentId?.trim().orEmpty()
  val agent = agents.firstOrNull { it.id == defaultId } ?: agents.firstOrNull()
  return agent?.name?.takeIf { it.isNotBlank() } ?: agent?.id ?: "None"
}

private fun agentBadge(agent: GatewayAgentSummary): String {
  agent.emoji
    ?.trim()
    ?.takeIf { it.isNotEmpty() }
    ?.let { return it }
  val source = agent.name?.takeIf { it.isNotBlank() } ?: agent.id
  return source
    .split(' ', '-', '_')
    .filter { it.isNotBlank() }
    .take(2)
    .mapNotNull { it.firstOrNull()?.uppercaseChar()?.toString() }
    .joinToString("")
    .ifBlank { "A" }
}

private fun approvalActionName(name: String): String {
  val cleaned =
    name
      .replace('.', ' ')
      .replace('_', ' ')
      .replace('-', ' ')
      .trim()
  return cleaned
    .split(' ')
    .filter { it.isNotBlank() }
    .joinToString(" ") { word -> word.replaceFirstChar { it.uppercaseChar() } }
    .ifBlank { "Action Request" }
}

private fun approvalSubtitle(
  toolCall: ChatPendingToolCall,
  hasIssue: Boolean,
): String {
  if (hasIssue) return "Needs attention"
  val ageMs = (System.currentTimeMillis() - toolCall.startedAtMs).coerceAtLeast(0L)
  val minutes = ageMs / 60_000L
  return if (minutes < 1) "Waiting for review" else "Waiting ${minutes}m"
}

private fun cronJobSubtitle(job: GatewayCronJobSummary): String = "${job.scheduleLabel} · ${formatCronWake(job.nextRunAtMs)} · ${job.promptPreview}"

private fun usageProviderSubtitle(provider: GatewayUsageProviderSummary): String {
  provider.error?.let { return it }
  val window = provider.windows.maxByOrNull { it.usedPercent }
  val quota = window?.let { "${(100.0 - it.usedPercent).coerceIn(0.0, 100.0).toInt()}% left ${it.label}" }
  return listOfNotNull(provider.plan, quota).joinToString(" · ").ifBlank { "No limits reported" }
}

private fun formatUsageUpdated(updatedAtMs: Long?): String {
  val updated = updatedAtMs ?: return "Never"
  val deltaMs = (System.currentTimeMillis() - updated).coerceAtLeast(0L)
  val minutes = deltaMs / 60_000L
  val hours = minutes / 60L
  return when {
    minutes < 1 -> "Now"
    hours < 1 -> "${minutes}m"
    hours < 24 -> "${hours}h"
    else -> "${hours / 24L}d"
  }
}

private fun cronJobStatusText(job: GatewayCronJobSummary): String {
  if (!job.enabled) return "Off"
  return when (job.lastRunStatus?.lowercase()) {
    "error" -> "Issue"
    "ok" -> "OK"
    "skipped" -> "Skipped"
    else -> "Ready"
  }
}

private fun cronJobStatus(job: GatewayCronJobSummary): ClawStatus {
  if (!job.enabled) return ClawStatus.Neutral
  return when (job.lastRunStatus?.lowercase()) {
    "error" -> ClawStatus.Danger
    "skipped" -> ClawStatus.Warning
    else -> ClawStatus.Success
  }
}

private fun formatCronWake(timeMs: Long?): String {
  val target = timeMs ?: return "None"
  val deltaMs = target - System.currentTimeMillis()
  if (deltaMs <= 0) return "Due"
  val minutes = deltaMs / 60_000L
  val hours = minutes / 60L
  val days = hours / 24L
  return when {
    days > 0 -> "${days}d"
    hours > 0 -> "${hours}h"
    minutes > 0 -> "${minutes}m"
    else -> "Soon"
  }
}

@Composable
private fun V2SettingsTogglePanel(rows: List<V2SettingsToggleRow>) {
  ClawPanel(contentPadding = PaddingValues(horizontal = 0.dp, vertical = 0.dp)) {
    Column {
      rows.forEachIndexed { index, row ->
        V2SettingsToggleListRow(row)
        if (index != rows.lastIndex) {
          HorizontalDivider(color = ClawTheme.colors.border, thickness = 1.dp)
        }
      }
    }
  }
}

@Composable
private fun V2SettingsToggleListRow(row: V2SettingsToggleRow) {
  Row(
    modifier = Modifier.fillMaxWidth().heightIn(min = 52.dp).padding(horizontal = 10.dp, vertical = 6.dp),
    verticalAlignment = Alignment.CenterVertically,
    horizontalArrangement = Arrangement.spacedBy(9.dp),
  ) {
    Icon(imageVector = row.icon, contentDescription = null, modifier = Modifier.size(19.dp), tint = ClawTheme.colors.text)
    Column(modifier = Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(1.dp)) {
      Text(text = row.title, style = ClawTheme.type.body, color = ClawTheme.colors.text, maxLines = 1)
      Text(text = row.subtitle, style = ClawTheme.type.caption, color = ClawTheme.colors.textMuted, maxLines = 2, overflow = TextOverflow.Ellipsis)
    }
    Switch(checked = row.checked, onCheckedChange = row.onCheckedChange)
  }
}

@Composable
internal fun V2SettingsMetricPanel(rows: List<V2SettingsMetric>) {
  ClawPanel(contentPadding = PaddingValues(horizontal = 0.dp, vertical = 0.dp)) {
    Column {
      rows.forEachIndexed { index, row ->
        Row(modifier = Modifier.fillMaxWidth().padding(horizontal = 10.dp, vertical = 6.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
          Text(text = row.title, style = ClawTheme.type.body, color = ClawTheme.colors.text, modifier = Modifier.weight(1f), maxLines = 1)
          Text(text = row.value, style = ClawTheme.type.caption, color = ClawTheme.colors.textMuted, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
        if (index != rows.lastIndex) {
          HorizontalDivider(color = ClawTheme.colors.border, thickness = 1.dp)
        }
      }
    }
  }
}

@Composable
private fun V2SettingsBackButton(onClick: () -> Unit) {
  Surface(onClick = onClick, modifier = Modifier.size(ClawTheme.spacing.touchTarget), shape = CircleShape, color = Color.Transparent, contentColor = ClawTheme.colors.text) {
    Box(contentAlignment = Alignment.Center) {
      Icon(imageVector = Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back", modifier = Modifier.size(18.dp))
    }
  }
}

@Composable
private fun V2SettingsIconMark(icon: ImageVector) {
  Surface(
    modifier = Modifier.size(30.dp),
    shape = CircleShape,
    color = ClawTheme.colors.surfaceRaised,
    border = BorderStroke(1.dp, ClawTheme.colors.border),
    contentColor = ClawTheme.colors.text,
  ) {
    Box(contentAlignment = Alignment.Center) {
      Icon(imageVector = icon, contentDescription = null, modifier = Modifier.size(15.dp))
    }
  }
}
