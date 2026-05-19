package ai.openclaw.app.ui

import ai.openclaw.app.BuildConfig
import ai.openclaw.app.GatewayNodesDevicesSummary
import ai.openclaw.app.GatewaySkillSummary
import ai.openclaw.app.HomeDestination
import ai.openclaw.app.MainViewModel
import ai.openclaw.app.ui.chat.V2ChatScreen
import ai.openclaw.app.ui.design.ClawDesignTheme
import ai.openclaw.app.ui.design.ClawEmptyState
import ai.openclaw.app.ui.design.ClawPanel
import ai.openclaw.app.ui.design.ClawPrimaryButton
import ai.openclaw.app.ui.design.ClawScaffold
import ai.openclaw.app.ui.design.ClawTheme
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ExitToApp
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.automirrored.filled.ScreenShare
import androidx.compose.material.icons.filled.Cloud
import androidx.compose.material.icons.filled.Lock
import androidx.compose.material.icons.filled.Mic
import androidx.compose.material.icons.filled.Notifications
import androidx.compose.material.icons.filled.Palette
import androidx.compose.material.icons.filled.Person
import androidx.compose.material.icons.filled.Search
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material.icons.filled.Storage
import androidx.compose.material.icons.outlined.AccessTime
import androidx.compose.material.icons.outlined.ChatBubbleOutline
import androidx.compose.material.icons.outlined.Inventory2
import androidx.compose.material.icons.outlined.MicNone
import androidx.compose.material.icons.outlined.Settings
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

private enum class V2Tab(
  val key: String,
  val label: String,
) {
  Overview(key = "overview", label = "Home"),
  Chat(key = "chat", label = "Chat"),
  Voice(key = "voice", label = "Voice"),
  Sessions(key = "sessions", label = "Sessions"),
  Settings(key = "settings", label = "Settings"),
  ProvidersModels(key = "providers-models", label = "Providers"),
}

@Composable
fun V2ShellScreen(
  viewModel: MainViewModel,
  modifier: Modifier = Modifier,
) {
  ClawDesignTheme {
    var activeTab by rememberSaveable { mutableStateOf(V2Tab.Overview) }
    var commandOpen by rememberSaveable { mutableStateOf(false) }
    val requestedHomeDestination by viewModel.requestedHomeDestination.collectAsState()

    LaunchedEffect(requestedHomeDestination) {
      val destination = requestedHomeDestination ?: return@LaunchedEffect
      activeTab =
        when (destination) {
          HomeDestination.Connect -> V2Tab.Overview
          HomeDestination.Chat -> V2Tab.Chat
          HomeDestination.Voice -> V2Tab.Voice
          HomeDestination.Screen -> V2Tab.Chat
          HomeDestination.Settings -> V2Tab.Settings
        }
      viewModel.clearRequestedHomeDestination()
    }

    LaunchedEffect(activeTab) {
      viewModel.setVoiceScreenActive(activeTab == V2Tab.Voice)
    }

    BackHandler(enabled = activeTab != V2Tab.Overview) {
      activeTab = V2Tab.Overview
    }

    BackHandler(enabled = commandOpen) {
      commandOpen = false
    }

    Box(modifier = modifier.fillMaxSize()) {
      when (activeTab) {
        V2Tab.Overview ->
          V2OverviewScreen(
            viewModel = viewModel,
            onSelectTab = { activeTab = it },
            onOpenCommand = { commandOpen = true },
          )
        V2Tab.Chat ->
          V2ChatShellScreen(
            viewModel = viewModel,
            onBack = { activeTab = V2Tab.Overview },
            onVoice = { activeTab = V2Tab.Voice },
          )
        V2Tab.Voice -> V2VoiceShellScreen(viewModel = viewModel)
        V2Tab.ProvidersModels ->
          V2ProvidersModelsScreen(
            viewModel = viewModel,
            onBack = { activeTab = V2Tab.Overview },
            onAddProvider = { activeTab = V2Tab.Settings },
          )
        V2Tab.Sessions ->
          V2SessionsScreen(
            viewModel = viewModel,
            onOpenCommand = { commandOpen = true },
            onOpenChat = { activeTab = V2Tab.Chat },
          )
        V2Tab.Settings -> V2SettingsShellScreen(viewModel = viewModel, onOpenCommand = { commandOpen = true })
      }

      if (commandOpen) {
        V2CommandPalette(
          viewModel = viewModel,
          onDismiss = { commandOpen = false },
          onOpenChat = {
            activeTab = V2Tab.Chat
            commandOpen = false
          },
          onOpenVoice = {
            activeTab = V2Tab.Voice
            commandOpen = false
          },
          onOpenSessions = {
            activeTab = V2Tab.Sessions
            commandOpen = false
          },
          onOpenProviders = {
            activeTab = V2Tab.ProvidersModels
            commandOpen = false
          },
          onOpenSettings = {
            activeTab = V2Tab.Settings
            commandOpen = false
          },
          onOpenSession = { sessionKey ->
            viewModel.switchChatSession(sessionKey)
            activeTab = V2Tab.Chat
            commandOpen = false
          },
        )
      }
    }
  }
}

@Composable
private fun V2OverviewScreen(
  viewModel: MainViewModel,
  onSelectTab: (V2Tab) -> Unit,
  onOpenCommand: () -> Unit,
) {
  val isConnected by viewModel.isConnected.collectAsState()
  val sessions by viewModel.chatSessions.collectAsState()
  val pendingRunCount by viewModel.pendingRunCount.collectAsState()
  val models by viewModel.modelCatalog.collectAsState()
  val providers by viewModel.modelAuthProviders.collectAsState()
  val readyProviderCount = providers.count { modelProviderReady(it.status) }

  LaunchedEffect(isConnected) {
    if (isConnected) {
      viewModel.refreshChatSessions(limit = 20)
      viewModel.refreshModelCatalog()
    }
  }

  ClawScaffold(contentPadding = PaddingValues(start = 20.dp, top = 14.dp, end = 20.dp, bottom = 20.dp)) {
    Box(modifier = Modifier.fillMaxSize()) {
      LazyColumn(verticalArrangement = Arrangement.spacedBy(10.dp), contentPadding = PaddingValues(bottom = 82.dp)) {
        item {
          Row(
            modifier = Modifier.fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(9.dp),
          ) {
            Text(
              text = "O P E N C L A W",
              style = ClawTheme.type.title.copy(fontSize = 18.sp, lineHeight = 23.sp),
              color = ClawTheme.colors.text,
              modifier = Modifier.weight(1f),
            )
            V2PlainIconButton(icon = Icons.Default.Search, contentDescription = "Search", onClick = onOpenCommand)
            V2OverviewAvatar(text = "OC")
          }
        }

        item {
          V2SectionLabel(title = "MODULES")
        }

        item {
          V2ModuleList(
            rows =
              listOf(
                V2ModuleRow("Chat", null, null, Icons.Outlined.ChatBubbleOutline, V2Tab.Chat),
                V2ModuleRow("Sessions", null, null, Icons.Outlined.AccessTime, V2Tab.Sessions),
                V2ModuleRow("Voice", null, null, Icons.Outlined.MicNone, V2Tab.Voice),
                V2ModuleRow(
                  title = "Providers & Models",
                  subtitle = null,
                  metadata =
                    when {
                      !isConnected -> "Offline"
                      readyProviderCount > 0 -> "$readyProviderCount ready"
                      models.isNotEmpty() -> "${models.size} models"
                      else -> "Setup"
                    },
                  icon = Icons.Outlined.Inventory2,
                  tab = V2Tab.ProvidersModels,
                ),
                V2ModuleRow("Settings", null, null, Icons.Outlined.Settings, V2Tab.Settings),
              ),
            onSelectTab = onSelectTab,
          )
        }

        item {
          V2SectionLabel(
            title = "Recent Sessions",
            action = {
              Text(text = "View all", style = ClawTheme.type.caption, color = ClawTheme.colors.textMuted)
            },
          )
        }

        if (sessions.isEmpty()) {
          item {
            ClawEmptyState(
              title = "No recent sessions",
              body = "Start a chat and your active OpenClaw conversations will appear here.",
              action = { ClawPrimaryButton(text = "Start Chat", onClick = { onSelectTab(V2Tab.Chat) }) },
            )
          }
        } else {
          item {
            V2RecentSessionList(
              rows =
                sessions.take(5).map { session ->
                  V2RecentSessionListItem(
                    key = session.key,
                    title = displaySessionTitle(session.displayName),
                    subtitle = if (pendingRunCount > 0) "Assistant working" else "OpenClaw session",
                    metadata = session.updatedAtMs?.let(::relativeSessionTime) ?: "",
                  )
                },
              onOpen = { sessionKey ->
                viewModel.switchChatSession(sessionKey)
                onSelectTab(V2Tab.Chat)
              },
            )
          }
        }
      }
      V2OverviewChatButton(onClick = { onSelectTab(V2Tab.Chat) }, modifier = Modifier.align(Alignment.BottomEnd).padding(bottom = 8.dp))
    }
  }
}

private data class V2ModuleRow(
  val title: String,
  val subtitle: String?,
  val metadata: String?,
  val icon: ImageVector,
  val tab: V2Tab,
)

@Composable
private fun V2OverviewChatButton(
  onClick: () -> Unit,
  modifier: Modifier = Modifier,
) {
  Surface(
    onClick = onClick,
    modifier = modifier.height(34.dp),
    shape = RoundedCornerShape(ClawTheme.radii.pill),
    color = ClawTheme.colors.primary,
    contentColor = ClawTheme.colors.primaryText,
  ) {
    Row(
      modifier = Modifier.padding(horizontal = 13.dp),
      verticalAlignment = Alignment.CenterVertically,
      horizontalArrangement = Arrangement.spacedBy(7.dp),
    ) {
      Icon(imageVector = Icons.Outlined.ChatBubbleOutline, contentDescription = null, modifier = Modifier.size(14.dp))
      Text(text = "Chat", style = ClawTheme.type.title.copy(fontSize = 18.sp, lineHeight = 23.sp))
    }
  }
}

@Composable
private fun V2OverviewAvatar(text: String) {
  Surface(
    modifier = Modifier.size(28.dp),
    shape = CircleShape,
    color = ClawTheme.colors.surfaceRaised,
    contentColor = ClawTheme.colors.text,
    border = BorderStroke(1.dp, ClawTheme.colors.border),
  ) {
    Box(contentAlignment = Alignment.Center) {
      Text(text = text.take(2).uppercase(), style = ClawTheme.type.label)
    }
  }
}

@Composable
private fun V2SectionLabel(
  title: String,
  action: (@Composable () -> Unit)? = null,
) {
  Row(
    modifier = Modifier.fillMaxWidth(),
    verticalAlignment = Alignment.CenterVertically,
    horizontalArrangement = Arrangement.SpaceBetween,
  ) {
    Text(text = title.uppercase(), style = ClawTheme.type.caption.copy(fontSize = 12.5.sp, lineHeight = 16.sp), color = ClawTheme.colors.textMuted)
    action?.invoke()
  }
}

@Composable
private fun V2ModuleList(
  rows: List<V2ModuleRow>,
  onSelectTab: (V2Tab) -> Unit,
) {
  ClawPanel(contentPadding = PaddingValues(horizontal = 8.dp, vertical = 1.dp)) {
    Column(verticalArrangement = Arrangement.spacedBy(0.dp)) {
      rows.forEachIndexed { index, row ->
        V2ModuleListRow(row = row, onClick = { onSelectTab(row.tab) })
        if (index != rows.lastIndex) {
          HorizontalDivider(color = ClawTheme.colors.border, thickness = 1.dp)
        }
      }
    }
  }
}

@Composable
private fun V2ModuleListRow(
  row: V2ModuleRow,
  onClick: () -> Unit,
) {
  Surface(color = Color.Transparent, contentColor = ClawTheme.colors.text) {
    Row(
      modifier =
        Modifier
          .fillMaxWidth()
          .clip(RoundedCornerShape(ClawTheme.radii.row))
          .clickable(onClick = onClick)
          .padding(vertical = 4.dp),
      verticalAlignment = Alignment.CenterVertically,
      horizontalArrangement = Arrangement.spacedBy(9.dp),
    ) {
      Icon(imageVector = row.icon, contentDescription = null, modifier = Modifier.size(15.dp), tint = ClawTheme.colors.text)
      Text(
        text = row.title,
        style = ClawTheme.type.body,
        color = ClawTheme.colors.text,
        modifier = Modifier.weight(1f),
        maxLines = 1,
        overflow = TextOverflow.Ellipsis,
      )
      row.metadata?.let {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(5.dp)) {
          Box(modifier = Modifier.size(4.5.dp).clip(CircleShape).background(statusDotColor(it)))
          Text(text = it, style = ClawTheme.type.caption.copy(fontSize = 12.5.sp, lineHeight = 16.sp), color = ClawTheme.colors.textMuted, maxLines = 1)
        }
      }
      Icon(
        imageVector = Icons.AutoMirrored.Filled.KeyboardArrowRight,
        contentDescription = "Open ${row.title}",
        modifier = Modifier.size(14.dp),
        tint = ClawTheme.colors.textMuted,
      )
    }
  }
}

@Composable
private fun V2RecentSessionRow(
  title: String,
  subtitle: String,
  metadata: String,
  onClick: () -> Unit,
) {
  V2RecentSessionRowContent(title = title, subtitle = subtitle, metadata = metadata, onClick = onClick)
}

private data class V2RecentSessionListItem(
  val key: String,
  val title: String,
  val subtitle: String,
  val metadata: String,
)

@Composable
private fun V2RecentSessionList(
  rows: List<V2RecentSessionListItem>,
  onOpen: (String) -> Unit,
) {
  ClawPanel(contentPadding = PaddingValues(horizontal = 8.dp, vertical = 0.dp)) {
    Column {
      rows.forEachIndexed { index, row ->
        V2RecentSessionRowContent(
          title = row.title,
          subtitle = row.subtitle,
          metadata = row.metadata,
          onClick = { onOpen(row.key) },
        )
        if (index != rows.lastIndex) {
          HorizontalDivider(color = ClawTheme.colors.border, thickness = 1.dp)
        }
      }
    }
  }
}

@Composable
private fun V2RecentSessionRowContent(
  title: String,
  subtitle: String,
  metadata: String,
  onClick: () -> Unit,
) {
  Surface(color = ClawTheme.colors.canvas, contentColor = ClawTheme.colors.text) {
    Row(
      modifier =
        Modifier
          .fillMaxWidth()
          .clip(RoundedCornerShape(ClawTheme.radii.row))
          .clickable(onClick = onClick)
          .padding(vertical = 5.dp),
      verticalAlignment = Alignment.CenterVertically,
      horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
      Surface(
        modifier = Modifier.size(24.dp),
        shape = CircleShape,
        color = ClawTheme.colors.canvas,
        border = BorderStroke(1.dp, ClawTheme.colors.borderStrong),
      ) {
        Box(contentAlignment = Alignment.Center) {
          Icon(imageVector = Icons.Outlined.ChatBubbleOutline, contentDescription = null, modifier = Modifier.size(12.dp), tint = ClawTheme.colors.text)
        }
      }
      Column(modifier = Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(1.dp)) {
        Text(text = title, style = ClawTheme.type.body, color = ClawTheme.colors.text, maxLines = 1)
        Text(text = subtitle, style = ClawTheme.type.caption.copy(fontSize = 12.5.sp, lineHeight = 16.sp), color = ClawTheme.colors.textSubtle, maxLines = 1)
      }
      Text(text = metadata, style = ClawTheme.type.caption.copy(fontSize = 12.5.sp, lineHeight = 16.sp), color = ClawTheme.colors.textMuted)
      Icon(
        imageVector = Icons.AutoMirrored.Filled.KeyboardArrowRight,
        contentDescription = "Open session",
        modifier = Modifier.size(14.dp),
        tint = ClawTheme.colors.textMuted,
      )
    }
  }
}

@Composable
private fun V2ChatShellScreen(
  viewModel: MainViewModel,
  onBack: () -> Unit,
  onVoice: () -> Unit,
) {
  ClawScaffold(contentPadding = PaddingValues(start = 0.dp, top = 8.dp, end = 0.dp, bottom = 8.dp)) {
    V2ChatScreen(viewModel = viewModel, onBack = onBack, onVoice = onVoice)
  }
}

@Composable
private fun V2VoiceShellScreen(viewModel: MainViewModel) {
  ClawScaffold(contentPadding = PaddingValues(start = 0.dp, top = 8.dp, end = 0.dp, bottom = 8.dp)) {
    V2VoiceScreen(viewModel = viewModel)
  }
}

@Composable
private fun V2SettingsShellScreen(
  viewModel: MainViewModel,
  onOpenCommand: () -> Unit,
) {
  val displayName by viewModel.displayName.collectAsState()
  val isConnected by viewModel.isConnected.collectAsState()
  val statusText by viewModel.statusText.collectAsState()
  val cameraEnabled by viewModel.cameraEnabled.collectAsState()
  val notificationForwardingEnabled by viewModel.notificationForwardingEnabled.collectAsState()
  val speakerEnabled by viewModel.speakerEnabled.collectAsState()
  val agents by viewModel.gatewayAgents.collectAsState()
  val pendingToolCalls by viewModel.chatPendingToolCalls.collectAsState()
  val cronStatus by viewModel.cronStatus.collectAsState()
  val usageSummary by viewModel.usageSummary.collectAsState()
  val skillsSummary by viewModel.skillsSummary.collectAsState()
  val nodesDevicesSummary by viewModel.nodesDevicesSummary.collectAsState()
  var route by rememberSaveable { mutableStateOf(V2SettingsRoute.Home) }

  LaunchedEffect(isConnected) {
    if (isConnected) {
      viewModel.refreshAgents()
      viewModel.refreshCronJobs()
      viewModel.refreshUsage()
      viewModel.refreshSkills()
      viewModel.refreshNodesDevices()
    }
  }

  BackHandler(enabled = route != V2SettingsRoute.Home) {
    route = V2SettingsRoute.Home
  }

  if (route != V2SettingsRoute.Home) {
    V2SettingsDetailScreen(viewModel = viewModel, route = route, onBack = { route = V2SettingsRoute.Home })
    return
  }

  ClawScaffold(contentPadding = PaddingValues(start = 20.dp, top = 14.dp, end = 20.dp, bottom = 20.dp)) {
    LazyColumn(verticalArrangement = Arrangement.spacedBy(13.dp)) {
      item {
        Row(
          modifier = Modifier.fillMaxWidth(),
          verticalAlignment = Alignment.CenterVertically,
          horizontalArrangement = Arrangement.spacedBy(9.dp),
        ) {
          Text(text = "Settings", style = ClawTheme.type.title.copy(fontSize = 16.sp, lineHeight = 20.sp), color = ClawTheme.colors.text, modifier = Modifier.weight(1f))
          V2SettingsSearchButton(onClick = onOpenCommand)
        }
      }

      item {
        V2ProfilePanel(displayName = displayName.ifBlank { "OpenClaw" })
      }

      item {
        V2SettingsGroup(
          rows =
            listOf(
              V2SettingsRow("Profile", displayName.ifBlank { "Local device" }, Icons.Default.Person, route = V2SettingsRoute.Profile),
              V2SettingsRow("Voice", if (speakerEnabled) "Speaker on" else "Speaker muted", Icons.Default.Mic, route = V2SettingsRoute.Voice),
              V2SettingsRow("Agents", if (agents.isEmpty()) "Load from gateway" else "${agents.size} available", Icons.Default.Person, status = agents.isNotEmpty(), route = V2SettingsRoute.Agents),
              V2SettingsRow("Approvals", approvalsSummary(pendingToolCalls.size), Icons.Default.Lock, status = approvalsStatus(pendingToolCalls.size), route = V2SettingsRoute.Approvals),
              V2SettingsRow("Cron Jobs", cronJobsSummary(cronStatus.jobs), Icons.Outlined.AccessTime, status = if (cronStatus.jobs > 0) cronStatus.enabled else null, route = V2SettingsRoute.CronJobs),
              V2SettingsRow("Usage", usageSummaryText(usageSummary.providers.size), Icons.Default.Storage, status = if (usageSummary.providers.isNotEmpty()) true else null, route = V2SettingsRoute.Usage),
              V2SettingsRow("Skills", skillsSummaryText(skillsSummary.skills), Icons.Default.Settings, status = skillsStatus(skillsSummary.skills), route = V2SettingsRoute.Skills),
              V2SettingsRow("Nodes & Devices", nodesDevicesSummaryText(nodesDevicesSummary), Icons.Default.Cloud, status = nodesDevicesStatus(nodesDevicesSummary), route = V2SettingsRoute.NodesDevices),
              V2SettingsRow("Canvas", "Screen surface", Icons.AutoMirrored.Filled.ScreenShare, status = isConnected, route = V2SettingsRoute.Canvas),
              V2SettingsRow("Notifications", if (notificationForwardingEnabled) "Smart delivery" else "Off", Icons.Default.Notifications, route = V2SettingsRoute.Notifications),
              V2SettingsRow("Phone Capabilities", if (cameraEnabled) "Camera enabled" else "Locked", Icons.Default.Lock, status = !cameraEnabled, route = V2SettingsRoute.PhoneCapabilities),
              V2SettingsRow("Gateway", gatewaySummary(statusText, isConnected), Icons.Default.Cloud, status = isConnected, route = V2SettingsRoute.Gateway),
              V2SettingsRow("Appearance", "Dark", Icons.Default.Palette, route = V2SettingsRoute.Appearance),
              V2SettingsRow("Health", "Diagnostics", Icons.Default.Settings, status = isConnected, route = V2SettingsRoute.Health),
              V2SettingsRow("About", "Version and update", Icons.Default.Storage, route = V2SettingsRoute.About),
            ),
          onOpen = { route = it },
        )
      }

      item {
        V2SettingsGroup(
          rows = listOf(V2SettingsRow("Sign Out", "Disconnect", Icons.AutoMirrored.Filled.ExitToApp)),
          onOpen = { },
          onAction = { viewModel.disconnect() },
        )
      }

      item {
        Column(
          modifier = Modifier.fillMaxWidth().padding(top = 14.dp),
          horizontalAlignment = Alignment.CenterHorizontally,
          verticalArrangement = Arrangement.spacedBy(3.dp),
        ) {
          Text(text = "OpenClaw ${BuildConfig.VERSION_NAME} (${BuildConfig.VERSION_CODE})", style = ClawTheme.type.caption.copy(fontSize = 12.5.sp, lineHeight = 16.sp), color = ClawTheme.colors.textMuted)
          Row(horizontalArrangement = Arrangement.spacedBy(5.dp), verticalAlignment = Alignment.CenterVertically) {
            Text(
              text = if (isConnected) "All systems operational" else "Gateway not connected",
              style = ClawTheme.type.caption.copy(fontSize = 12.5.sp, lineHeight = 16.sp),
              color = ClawTheme.colors.textSubtle,
            )
            Box(modifier = Modifier.size(4.5.dp).clip(CircleShape).background(if (isConnected) ClawTheme.colors.success else ClawTheme.colors.textSubtle))
          }
        }
      }
    }
  }
}

private fun approvalsSummary(count: Int): String =
  when (count) {
    0 -> "No pending approvals"
    1 -> "1 pending"
    else -> "$count pending"
  }

private fun approvalsStatus(count: Int): Boolean? = if (count > 0) true else null

private fun cronJobsSummary(count: Int): String =
  when (count) {
    0 -> "No scheduled jobs"
    1 -> "1 scheduled"
    else -> "$count scheduled"
  }

private fun usageSummaryText(count: Int): String =
  when (count) {
    0 -> "No provider usage"
    1 -> "1 provider"
    else -> "$count providers"
  }

private fun skillsSummaryText(skills: List<GatewaySkillSummary>): String {
  val ready = skills.count { !it.disabled && it.eligible && it.missingCount == 0 }
  return if (skills.isEmpty()) "No skills" else "$ready/${skills.size} ready"
}

private fun skillsStatus(skills: List<GatewaySkillSummary>): Boolean? =
  when {
    skills.isEmpty() -> null
    skills.any { it.blockedByAllowlist || (!it.disabled && (!it.eligible || it.missingCount > 0)) } -> false
    else -> true
  }

private fun nodesDevicesSummaryText(summary: GatewayNodesDevicesSummary): String {
  val online = summary.nodes.count { it.connected }
  val devices = summary.pairedDevices.size
  return when {
    summary.pendingDevices.isNotEmpty() -> "${summary.pendingDevices.size} pending"
    summary.nodes.isNotEmpty() -> "$online/${summary.nodes.size} online"
    devices > 0 -> "$devices paired"
    else -> "No devices"
  }
}

private fun nodesDevicesStatus(summary: GatewayNodesDevicesSummary): Boolean? =
  when {
    summary.pendingDevices.isNotEmpty() -> false
    summary.nodes.any { it.connected } -> true
    summary.pairedDevices.isNotEmpty() -> true
    else -> null
  }

private data class V2SettingsRow(
  val title: String,
  val value: String,
  val icon: ImageVector,
  val status: Boolean? = null,
  val route: V2SettingsRoute? = null,
)

@Composable
private fun V2ProfilePanel(displayName: String) {
  ClawPanel(contentPadding = PaddingValues(horizontal = 10.dp, vertical = 8.dp)) {
    Row(
      modifier = Modifier.fillMaxWidth(),
      verticalAlignment = Alignment.CenterVertically,
      horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
      Surface(
        modifier = Modifier.size(32.dp),
        shape = CircleShape,
        color = ClawTheme.colors.surfacePressed,
        border = BorderStroke(1.dp, ClawTheme.colors.borderStrong),
      ) {
        Box(contentAlignment = Alignment.Center) {
          Text(
            text = displayName.firstOrNull()?.uppercase() ?: "O",
            style = ClawTheme.type.title.copy(fontSize = 14.sp, lineHeight = 17.sp),
            color = ClawTheme.colors.text,
            textAlign = TextAlign.Center,
          )
        }
      }
      Column(modifier = Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
        Text(text = displayName, style = ClawTheme.type.section, color = ClawTheme.colors.text, maxLines = 1)
        Text(text = "OpenClaw mobile", style = ClawTheme.type.caption.copy(fontSize = 12.5.sp, lineHeight = 16.sp), color = ClawTheme.colors.textMuted, maxLines = 1)
      }
      Icon(
        imageVector = Icons.AutoMirrored.Filled.KeyboardArrowRight,
        contentDescription = "Open profile",
        modifier = Modifier.size(15.dp),
        tint = ClawTheme.colors.text,
      )
    }
  }
}

@Composable
private fun V2SettingsGroup(
  rows: List<V2SettingsRow>,
  onOpen: (V2SettingsRoute) -> Unit,
  onAction: (() -> Unit)? = null,
) {
  ClawPanel(contentPadding = PaddingValues(horizontal = 0.dp, vertical = 0.dp)) {
    Column {
      rows.forEachIndexed { index, row ->
        V2SettingsListRow(
          row = row,
          onClick = {
            val rowRoute = row.route
            if (rowRoute == null) {
              onAction?.invoke()
            } else {
              onOpen(rowRoute)
            }
          },
        )
        if (index != rows.lastIndex) {
          HorizontalDivider(color = ClawTheme.colors.border, thickness = 1.dp)
        }
      }
    }
  }
}

@Composable
private fun V2SettingsListRow(
  row: V2SettingsRow,
  onClick: () -> Unit,
) {
  Row(
    modifier =
      Modifier
        .fillMaxWidth()
        .clip(RoundedCornerShape(ClawTheme.radii.row))
        .clickable(onClick = onClick)
        .padding(horizontal = 10.dp, vertical = 5.dp),
    verticalAlignment = Alignment.CenterVertically,
    horizontalArrangement = Arrangement.spacedBy(10.dp),
  ) {
    Icon(imageVector = row.icon, contentDescription = null, modifier = Modifier.size(15.dp), tint = ClawTheme.colors.text)
    Text(text = row.title, style = ClawTheme.type.body, color = ClawTheme.colors.text, modifier = Modifier.weight(1f), maxLines = 1)
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(5.dp)) {
      Text(text = row.value, style = ClawTheme.type.caption.copy(fontSize = 12.5.sp, lineHeight = 16.sp), color = ClawTheme.colors.textMuted, maxLines = 1)
      row.status?.let { active ->
        Box(modifier = Modifier.size(4.5.dp).clip(CircleShape).background(if (active) ClawTheme.colors.success else ClawTheme.colors.textSubtle))
      }
      Icon(
        imageVector = Icons.AutoMirrored.Filled.KeyboardArrowRight,
        contentDescription = "Open ${row.title}",
        modifier = Modifier.size(14.dp),
        tint = ClawTheme.colors.text,
      )
    }
  }
}

@Composable
private fun V2SettingsSearchButton(onClick: () -> Unit) {
  Surface(onClick = onClick, modifier = Modifier.size(30.dp), shape = CircleShape, color = Color.Transparent, contentColor = ClawTheme.colors.text) {
    Box(contentAlignment = Alignment.Center) {
      Icon(imageVector = Icons.Default.Search, contentDescription = "Search settings", modifier = Modifier.size(18.dp))
    }
  }
}

@Composable
private fun V2PlainIconButton(
  icon: ImageVector,
  contentDescription: String,
  onClick: () -> Unit,
) {
  Surface(onClick = onClick, modifier = Modifier.size(30.dp), shape = CircleShape, color = Color.Transparent, contentColor = ClawTheme.colors.text) {
    Box(contentAlignment = Alignment.Center) {
      Icon(imageVector = icon, contentDescription = contentDescription, modifier = Modifier.size(18.dp))
    }
  }
}

private fun relativeSessionTime(updatedAtMs: Long): String {
  val deltaMs = (System.currentTimeMillis() - updatedAtMs).coerceAtLeast(0L)
  val minutes = deltaMs / 60_000L
  if (minutes < 1) return "now"
  if (minutes < 60) return "${minutes}m"
  val hours = minutes / 60
  if (hours < 24) return "${hours}h"
  return "${hours / 24}d"
}

private fun displaySessionTitle(displayName: String?): String = displayName?.takeIf { it.isNotBlank() } ?: "Main session"

private fun statusDotColor(status: String): Color {
  val normalized = status.trim().lowercase()
  return when {
    normalized.contains("offline") || normalized.contains("not connected") -> Color(0xFFFF6B6B)
    normalized.contains("ready") || normalized.contains("active") || normalized.contains("online") -> Color(0xFF3EDB82)
    else -> Color(0xFF707070)
  }
}

private fun gatewaySummary(
  statusText: String,
  isConnected: Boolean,
): String {
  if (isConnected) return "Online and ready"
  val status = statusText.trim().lowercase()
  return when {
    status.contains("connecting") || status.contains("reconnecting") -> "Connecting..."
    status.contains("pairing") -> "Waiting for pairing"
    status.contains("auth") -> "Authentication needed"
    status.contains("certificate") || status.contains("tls") -> "Certificate review needed"
    else -> "Not connected"
  }
}
