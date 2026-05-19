package ai.openclaw.app.ui

import ai.openclaw.app.BuildConfig
import ai.openclaw.app.GatewayAgentSummary
import ai.openclaw.app.LocationMode
import ai.openclaw.app.MainViewModel
import ai.openclaw.app.NotificationPackageFilterMode
import ai.openclaw.app.ui.design.ClawPanel
import ai.openclaw.app.ui.design.ClawPrimaryButton
import ai.openclaw.app.ui.design.ClawScaffold
import ai.openclaw.app.ui.design.ClawSecondaryButton
import ai.openclaw.app.ui.design.ClawSegmentedControl
import ai.openclaw.app.ui.design.ClawStatus
import ai.openclaw.app.ui.design.ClawStatusPill
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
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.ScreenShare
import androidx.compose.material.icons.automirrored.filled.VolumeUp
import androidx.compose.material.icons.filled.Bolt
import androidx.compose.material.icons.filled.CameraAlt
import androidx.compose.material.icons.filled.Cloud
import androidx.compose.material.icons.filled.Info
import androidx.compose.material.icons.filled.LocationOn
import androidx.compose.material.icons.filled.Mic
import androidx.compose.material.icons.filled.Notifications
import androidx.compose.material.icons.filled.Palette
import androidx.compose.material.icons.filled.Person
import androidx.compose.material.icons.filled.Settings
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
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp

internal enum class V2SettingsRoute {
  Home,
  Profile,
  Voice,
  Agents,
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
    V2SettingsRoute.Notifications -> V2NotificationSettingsScreen(viewModel = viewModel, onBack = onBack)
    V2SettingsRoute.PhoneCapabilities -> V2PhoneCapabilitiesScreen(viewModel = viewModel, onBack = onBack)
    V2SettingsRoute.Gateway -> V2GatewaySettingsScreen(viewModel = viewModel, onBack = onBack)
    V2SettingsRoute.Appearance -> V2AppearanceSettingsScreen(onBack = onBack)
    V2SettingsRoute.Health -> V2HealthSettingsScreen(viewModel = viewModel, onBack = onBack)
    V2SettingsRoute.About -> V2AboutSettingsScreen(onBack = onBack)
  }
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
  val micStatusText by viewModel.micStatusText.collectAsState()
  val talkModeStatusText by viewModel.talkModeStatusText.collectAsState()

  V2SettingsDetailFrame(title = "Voice", subtitle = "Control talk, dictation, and playback.", icon = Icons.Default.Mic, onBack = onBack) {
    V2SettingsTogglePanel(
      rows =
        listOf(
          V2SettingsToggleRow("Speaker", if (speakerEnabled) "Assistant replies play aloud." else "Assistant speech is muted.", Icons.AutoMirrored.Filled.VolumeUp, speakerEnabled, viewModel::setSpeakerEnabled),
          V2SettingsToggleRow("Dictation", micStatusText, Icons.Default.Mic, micEnabled, viewModel::setMicEnabled),
          V2SettingsToggleRow("Realtime Talk", talkModeStatusText, Icons.Default.Bolt, talkModeEnabled, viewModel::setTalkModeEnabled),
        ),
    )
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
private fun V2HealthSettingsScreen(
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

  V2SettingsDetailFrame(title = "Health", subtitle = "Current app, Gateway, chat, and voice status.", icon = Icons.Default.Settings, onBack = onBack) {
    V2HealthRow(title = "Gateway", value = statusText, healthy = isConnected)
    V2HealthRow(title = "Phone Node", value = if (isNodeConnected) "Online" else "Waiting", healthy = isNodeConnected)
    V2HealthRow(title = "Chat", value = if (chatHealthOk) "Ready" else "Needs connection", healthy = chatHealthOk)
    V2HealthRow(title = "Models", value = "${modelCount.size} available", healthy = modelCount.isNotEmpty())
    V2HealthRow(title = "Voice", value = talkStatus, healthy = talkStatus.lowercase() != "off")
    V2HealthRow(title = "Runs", value = if (pendingRunCount > 0) "$pendingRunCount active" else "Idle", healthy = true)
  }
}

@Composable
private fun V2AboutSettingsScreen(onBack: () -> Unit) {
  V2SettingsDetailFrame(title = "About", subtitle = "OpenClaw for Android.", icon = Icons.Default.Info, onBack = onBack) {
    V2SettingsMetricPanel(
      rows =
        listOf(
          V2SettingsMetric("Version", BuildConfig.VERSION_NAME),
          V2SettingsMetric("Build", BuildConfig.VERSION_CODE.toString()),
          V2SettingsMetric("Channel", "Play"),
        ),
    )
    ClawPanel {
      Text(text = "OpenClaw turns this phone into a clean mobile command surface for your sessions, voice, providers, and Gateway.", style = ClawTheme.type.body, color = ClawTheme.colors.textMuted)
    }
  }
}

@Composable
private fun V2SettingsDetailFrame(
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

private data class V2SettingsMetric(
  val title: String,
  val value: String,
)

@Composable
private fun V2AgentsPanel(
  agents: List<GatewayAgentSummary>,
  defaultAgentId: String?,
) {
  ClawPanel(contentPadding = PaddingValues(horizontal = 0.dp, vertical = 0.dp)) {
    Column {
      agents.forEachIndexed { index, agent ->
        V2AgentListRow(agent = agent, isDefault = agent.id == defaultAgentId)
        if (index != agents.lastIndex) {
          HorizontalDivider(color = ClawTheme.colors.border, thickness = 1.dp)
        }
      }
    }
  }
}

@Composable
private fun V2AgentListRow(
  agent: GatewayAgentSummary,
  isDefault: Boolean,
) {
  Row(
    modifier = Modifier.fillMaxWidth().padding(horizontal = 10.dp, vertical = 7.dp),
    verticalAlignment = Alignment.CenterVertically,
    horizontalArrangement = Arrangement.spacedBy(9.dp),
  ) {
    Surface(modifier = Modifier.size(30.dp), shape = CircleShape, color = ClawTheme.colors.surfacePressed, border = BorderStroke(1.dp, ClawTheme.colors.border)) {
      Box(contentAlignment = Alignment.Center) {
        Text(text = agentBadge(agent), style = ClawTheme.type.label, color = ClawTheme.colors.text, maxLines = 1)
      }
    }
    Column(modifier = Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(1.dp)) {
      Text(text = agent.name?.takeIf { it.isNotBlank() } ?: agent.id, style = ClawTheme.type.body, color = ClawTheme.colors.text, maxLines = 1, overflow = TextOverflow.Ellipsis)
      Text(text = if (isDefault) "Default assistant" else "Ready", style = ClawTheme.type.caption, color = ClawTheme.colors.textMuted, maxLines = 1)
    }
    ClawStatusPill(text = if (isDefault) "Default" else "Ready", status = ClawStatus.Success)
  }
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
    modifier = Modifier.fillMaxWidth().padding(horizontal = 10.dp, vertical = 6.dp),
    verticalAlignment = Alignment.CenterVertically,
    horizontalArrangement = Arrangement.spacedBy(9.dp),
  ) {
    Icon(imageVector = row.icon, contentDescription = null, modifier = Modifier.size(15.dp), tint = ClawTheme.colors.text)
    Column(modifier = Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(1.dp)) {
      Text(text = row.title, style = ClawTheme.type.body, color = ClawTheme.colors.text, maxLines = 1)
      Text(text = row.subtitle, style = ClawTheme.type.caption, color = ClawTheme.colors.textMuted, maxLines = 2, overflow = TextOverflow.Ellipsis)
    }
    Switch(checked = row.checked, onCheckedChange = row.onCheckedChange)
  }
}

@Composable
private fun V2SettingsMetricPanel(rows: List<V2SettingsMetric>) {
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
private fun V2HealthRow(
  title: String,
  value: String,
  healthy: Boolean,
) {
  ClawPanel(contentPadding = PaddingValues(horizontal = 10.dp, vertical = 8.dp)) {
    Row(modifier = Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
      Box(modifier = Modifier.size(7.dp).clip(CircleShape).background(if (healthy) ClawTheme.colors.success else ClawTheme.colors.warning))
      Column(modifier = Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
        Text(text = title, style = ClawTheme.type.section, color = ClawTheme.colors.text)
        Text(text = value, style = ClawTheme.type.body, color = ClawTheme.colors.textMuted, maxLines = 2, overflow = TextOverflow.Ellipsis)
      }
      ClawStatusPill(text = if (healthy) "OK" else "Check", status = if (healthy) ClawStatus.Success else ClawStatus.Warning)
    }
  }
}

@Composable
private fun V2SettingsBackButton(onClick: () -> Unit) {
  Surface(onClick = onClick, modifier = Modifier.size(30.dp), shape = CircleShape, color = Color.Transparent, contentColor = ClawTheme.colors.text) {
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
