package ai.openclaw.app.ui

import ai.openclaw.app.HomeDestination
import ai.openclaw.app.MainViewModel
import ai.openclaw.app.ui.chat.V2ChatScreen
import ai.openclaw.app.ui.design.ClawAvatarMark
import ai.openclaw.app.ui.design.ClawDesignTheme
import ai.openclaw.app.ui.design.ClawEmptyState
import ai.openclaw.app.ui.design.ClawListItem
import ai.openclaw.app.ui.design.ClawPanel
import ai.openclaw.app.ui.design.ClawPrimaryButton
import ai.openclaw.app.ui.design.ClawScaffold
import ai.openclaw.app.ui.design.ClawTheme
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ExitToApp
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.filled.AccessTime
import androidx.compose.material.icons.filled.Apps
import androidx.compose.material.icons.filled.ChatBubble
import androidx.compose.material.icons.filled.Cloud
import androidx.compose.material.icons.filled.Code
import androidx.compose.material.icons.filled.Lock
import androidx.compose.material.icons.filled.Mic
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material.icons.filled.Notifications
import androidx.compose.material.icons.filled.Palette
import androidx.compose.material.icons.filled.Person
import androidx.compose.material.icons.filled.Search
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material.icons.filled.StarBorder
import androidx.compose.material.icons.filled.Storage
import androidx.compose.material.icons.outlined.AccessTime
import androidx.compose.material.icons.outlined.Apps
import androidx.compose.material.icons.outlined.BarChart
import androidx.compose.material.icons.outlined.CalendarMonth
import androidx.compose.material.icons.outlined.ChatBubbleOutline
import androidx.compose.material.icons.outlined.Code
import androidx.compose.material.icons.outlined.Hub
import androidx.compose.material.icons.outlined.Inventory2
import androidx.compose.material.icons.outlined.MicNone
import androidx.compose.material.icons.outlined.PersonOutline
import androidx.compose.material.icons.outlined.Settings
import androidx.compose.material.icons.outlined.Storage
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
}

@Composable
fun V2ShellScreen(
  viewModel: MainViewModel,
  modifier: Modifier = Modifier,
) {
  ClawDesignTheme {
    var activeTab by rememberSaveable { mutableStateOf(V2Tab.Overview) }
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

    Box(modifier = modifier.fillMaxSize()) {
      when (activeTab) {
        V2Tab.Overview -> V2OverviewScreen(viewModel = viewModel, onSelectTab = { activeTab = it })
        V2Tab.Chat ->
          V2ChatShellScreen(
            viewModel = viewModel,
            onBack = { activeTab = V2Tab.Overview },
            onVoice = { activeTab = V2Tab.Voice },
          )
        V2Tab.Voice -> V2VoiceShellScreen(viewModel = viewModel)
        V2Tab.Sessions ->
          V2SessionsScreen(
            viewModel = viewModel,
            onOpenChat = { activeTab = V2Tab.Chat },
          )
        V2Tab.Settings -> V2SettingsShellScreen(viewModel = viewModel)
      }
    }
  }
}

@Composable
private fun V2OverviewScreen(
  viewModel: MainViewModel,
  onSelectTab: (V2Tab) -> Unit,
) {
  val isConnected by viewModel.isConnected.collectAsState()
  val statusText by viewModel.statusText.collectAsState()
  val sessions by viewModel.chatSessions.collectAsState()
  val pendingRunCount by viewModel.pendingRunCount.collectAsState()

  LaunchedEffect(isConnected) {
    if (isConnected) {
      viewModel.refreshChatSessions(limit = 20)
    }
  }

  ClawScaffold(contentPadding = PaddingValues(start = 20.dp, top = 18.dp, end = 20.dp, bottom = 24.dp)) {
    Box(modifier = Modifier.fillMaxSize()) {
      LazyColumn(verticalArrangement = Arrangement.spacedBy(12.dp), contentPadding = PaddingValues(bottom = 96.dp)) {
        item {
          Row(
            modifier = Modifier.fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(12.dp),
          ) {
            Text(
              text = "O P E N C L A W",
              style = ClawTheme.type.title.copy(fontSize = 13.2.sp, lineHeight = 17.sp),
              color = ClawTheme.colors.text,
              modifier = Modifier.weight(1f),
            )
            V2PlainIconButton(icon = Icons.Default.Search, contentDescription = "Search", onClick = {})
            ClawAvatarMark(text = "OC")
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
                V2ModuleRow("Channels", null, null, Icons.Outlined.Apps, V2Tab.Settings),
                V2ModuleRow(
                  title = "Providers & Models",
                  subtitle = null,
                  metadata = if (isConnected) "5 active" else "Offline",
                  icon = Icons.Outlined.Inventory2,
                  tab = V2Tab.Settings,
                ),
                V2ModuleRow("Agents", null, if (isConnected) "3 active" else null, Icons.Outlined.PersonOutline, V2Tab.Settings),
                V2ModuleRow("Skills", null, if (isConnected) "24 ready" else null, Icons.Outlined.Code, V2Tab.Settings),
                V2ModuleRow("Nodes", null, if (isConnected) "7 online" else null, Icons.Outlined.Hub, V2Tab.Settings),
                V2ModuleRow("Cron Jobs", null, if (isConnected) "8 scheduled" else null, Icons.Outlined.CalendarMonth, V2Tab.Settings),
                V2ModuleRow("Usage", null, null, Icons.Outlined.BarChart, V2Tab.Settings),
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
      V2OverviewChatButton(onClick = { onSelectTab(V2Tab.Chat) }, modifier = Modifier.align(Alignment.BottomEnd).padding(bottom = 10.dp))
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
    modifier = modifier.height(42.dp),
    shape = RoundedCornerShape(ClawTheme.radii.pill),
    color = ClawTheme.colors.primary,
    contentColor = ClawTheme.colors.primaryText,
  ) {
    Row(
      modifier = Modifier.padding(horizontal = 15.dp),
      verticalAlignment = Alignment.CenterVertically,
      horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
      Icon(imageVector = Icons.Outlined.ChatBubbleOutline, contentDescription = null, modifier = Modifier.size(16.dp))
      Text(text = "Chat", style = ClawTheme.type.title.copy(fontSize = 12.8.sp, lineHeight = 16.sp))
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
    Text(text = title.uppercase(), style = ClawTheme.type.caption, color = ClawTheme.colors.textMuted)
    action?.invoke()
  }
}

@Composable
private fun V2ModuleList(
  rows: List<V2ModuleRow>,
  onSelectTab: (V2Tab) -> Unit,
) {
  ClawPanel(contentPadding = PaddingValues(horizontal = 8.dp, vertical = 2.dp)) {
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
  ClawListItem(
    title = row.title,
    subtitle = row.subtitle,
    leading = {
      Icon(imageVector = row.icon, contentDescription = null, modifier = Modifier.size(18.dp), tint = ClawTheme.colors.text)
    },
    trailing = {
      Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        row.metadata?.let {
          Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            Box(modifier = Modifier.size(6.dp).clip(CircleShape).background(statusDotColor(it)))
            Text(text = it, style = ClawTheme.type.caption, color = ClawTheme.colors.textMuted, maxLines = 1)
          }
        }
        Icon(
          imageVector = Icons.AutoMirrored.Filled.KeyboardArrowRight,
          contentDescription = "Open ${row.title}",
          modifier = Modifier.size(18.dp),
          tint = ClawTheme.colors.textMuted,
        )
      }
    },
    onClick = onClick,
  )
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
  ClawPanel(contentPadding = PaddingValues(horizontal = 10.dp, vertical = 1.dp)) {
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
  Surface(onClick = onClick, color = ClawTheme.colors.canvas, contentColor = ClawTheme.colors.text) {
    Row(
      modifier = Modifier.fillMaxWidth().padding(vertical = 8.dp),
      verticalAlignment = Alignment.CenterVertically,
      horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
      Surface(
        modifier = Modifier.size(31.dp),
        shape = CircleShape,
        color = ClawTheme.colors.canvas,
        border = BorderStroke(1.dp, ClawTheme.colors.borderStrong),
      ) {
        Box(contentAlignment = Alignment.Center) {
          Icon(imageVector = Icons.Outlined.ChatBubbleOutline, contentDescription = null, modifier = Modifier.size(16.dp), tint = ClawTheme.colors.text)
        }
      }
      Column(modifier = Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
        Text(text = title, style = ClawTheme.type.body, color = ClawTheme.colors.text, maxLines = 1)
        Text(text = subtitle, style = ClawTheme.type.caption, color = ClawTheme.colors.textSubtle, maxLines = 1)
      }
      Text(text = metadata, style = ClawTheme.type.caption, color = ClawTheme.colors.textMuted)
      Icon(
        imageVector = Icons.AutoMirrored.Filled.KeyboardArrowRight,
        contentDescription = "Open session",
        modifier = Modifier.size(18.dp),
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
private fun V2SettingsShellScreen(viewModel: MainViewModel) {
  val displayName by viewModel.displayName.collectAsState()
  val isConnected by viewModel.isConnected.collectAsState()
  val statusText by viewModel.statusText.collectAsState()
  val remoteAddress by viewModel.remoteAddress.collectAsState()
  val cameraEnabled by viewModel.cameraEnabled.collectAsState()
  val notificationForwardingEnabled by viewModel.notificationForwardingEnabled.collectAsState()
  val speakerEnabled by viewModel.speakerEnabled.collectAsState()

  ClawScaffold(contentPadding = PaddingValues(start = 20.dp, top = 18.dp, end = 20.dp, bottom = 24.dp)) {
    LazyColumn(verticalArrangement = Arrangement.spacedBy(18.dp)) {
      item {
        Row(
          modifier = Modifier.fillMaxWidth(),
          verticalAlignment = Alignment.CenterVertically,
          horizontalArrangement = Arrangement.spacedBy(12.dp),
        ) {
          Text(text = "Settings", style = ClawTheme.type.display, color = ClawTheme.colors.text, modifier = Modifier.weight(1f))
          V2PlainIconButton(icon = Icons.Default.Search, contentDescription = "Search settings", onClick = {})
        }
      }

      item {
        V2ProfilePanel(displayName = displayName.ifBlank { "OpenClaw" })
      }

      item {
        V2SettingsGroup(
          rows =
            listOf(
              V2SettingsRow("Profile", displayName.ifBlank { "Local device" }, Icons.Default.Person),
              V2SettingsRow("Voice", if (speakerEnabled) "Speaker on" else "Speaker muted", Icons.Default.Mic),
              V2SettingsRow("Notifications", if (notificationForwardingEnabled) "Smart delivery" else "Off", Icons.Default.Notifications),
              V2SettingsRow("Privacy", if (cameraEnabled) "Camera enabled" else "Locked", Icons.Default.Lock, status = !cameraEnabled),
              V2SettingsRow("Gateway", gatewaySummary(statusText, isConnected), Icons.Default.Cloud, status = isConnected),
              V2SettingsRow("Appearance", "Dark", Icons.Default.Palette),
              V2SettingsRow("Advanced", remoteAddress?.takeIf { it.isNotBlank() } ?: "Diagnostics", Icons.Default.Settings),
            ),
        )
      }

      item {
        V2SettingsGroup(rows = listOf(V2SettingsRow("Sign Out", "Disconnect", Icons.AutoMirrored.Filled.ExitToApp)))
      }

      item {
        Column(
          modifier = Modifier.fillMaxWidth().padding(top = 20.dp),
          horizontalAlignment = Alignment.CenterHorizontally,
          verticalArrangement = Arrangement.spacedBy(4.dp),
        ) {
          Text(text = "OpenClaw", style = ClawTheme.type.caption, color = ClawTheme.colors.textMuted)
          Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
            Text(
              text = if (isConnected) "All systems operational" else "Gateway not connected",
              style = ClawTheme.type.caption,
              color = ClawTheme.colors.textSubtle,
            )
            Box(modifier = Modifier.size(6.dp).clip(CircleShape).background(if (isConnected) ClawTheme.colors.success else ClawTheme.colors.textSubtle))
          }
        }
      }
    }
  }
}

private data class V2SettingsRow(
  val title: String,
  val value: String,
  val icon: ImageVector,
  val status: Boolean? = null,
)

@Composable
private fun V2ProfilePanel(displayName: String) {
  ClawPanel(contentPadding = PaddingValues(horizontal = 18.dp, vertical = 18.dp)) {
    Row(
      modifier = Modifier.fillMaxWidth(),
      verticalAlignment = Alignment.CenterVertically,
      horizontalArrangement = Arrangement.spacedBy(16.dp),
    ) {
      Surface(
        modifier = Modifier.size(68.dp),
        shape = CircleShape,
        color = ClawTheme.colors.surfacePressed,
        border = BorderStroke(1.dp, ClawTheme.colors.borderStrong),
      ) {
        Box(contentAlignment = Alignment.Center) {
          Text(
            text = displayName.firstOrNull()?.uppercase() ?: "O",
            style = ClawTheme.type.display,
            color = ClawTheme.colors.text,
            textAlign = TextAlign.Center,
          )
        }
      }
      Column(modifier = Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Text(text = displayName, style = ClawTheme.type.title, color = ClawTheme.colors.text, maxLines = 1)
        Text(text = "OpenClaw mobile", style = ClawTheme.type.body, color = ClawTheme.colors.textMuted, maxLines = 1)
      }
      Icon(
        imageVector = Icons.AutoMirrored.Filled.KeyboardArrowRight,
        contentDescription = "Open profile",
        modifier = Modifier.size(26.dp),
        tint = ClawTheme.colors.text,
      )
    }
  }
}

@Composable
private fun V2SettingsGroup(rows: List<V2SettingsRow>) {
  ClawPanel(contentPadding = PaddingValues(horizontal = 0.dp, vertical = 0.dp)) {
    Column {
      rows.forEachIndexed { index, row ->
        V2SettingsListRow(row = row)
        if (index != rows.lastIndex) {
          HorizontalDivider(color = ClawTheme.colors.border, thickness = 1.dp)
        }
      }
    }
  }
}

@Composable
private fun V2SettingsListRow(row: V2SettingsRow) {
  Row(
    modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 13.dp),
    verticalAlignment = Alignment.CenterVertically,
    horizontalArrangement = Arrangement.spacedBy(16.dp),
  ) {
    Icon(imageVector = row.icon, contentDescription = null, modifier = Modifier.size(24.dp), tint = ClawTheme.colors.text)
    Text(text = row.title, style = ClawTheme.type.section, color = ClawTheme.colors.text, modifier = Modifier.weight(1f), maxLines = 1)
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
      Text(text = row.value, style = ClawTheme.type.body, color = ClawTheme.colors.textMuted, maxLines = 1)
      row.status?.let { active ->
        Box(modifier = Modifier.size(7.dp).clip(CircleShape).background(if (active) ClawTheme.colors.success else ClawTheme.colors.textSubtle))
      }
      Icon(
        imageVector = Icons.AutoMirrored.Filled.KeyboardArrowRight,
        contentDescription = "Open ${row.title}",
        modifier = Modifier.size(24.dp),
        tint = ClawTheme.colors.text,
      )
    }
  }
}

@Composable
private fun V2PlainIconButton(
  icon: ImageVector,
  contentDescription: String,
  onClick: () -> Unit,
) {
  Surface(onClick = onClick, modifier = Modifier.size(34.dp), shape = CircleShape, color = Color.Transparent, contentColor = ClawTheme.colors.text) {
    Box(contentAlignment = Alignment.Center) {
      Icon(imageVector = icon, contentDescription = contentDescription, modifier = Modifier.size(22.dp))
    }
  }
}

@Composable
private fun V2OutlineIconButton(
  icon: ImageVector,
  contentDescription: String,
  onClick: () -> Unit,
) {
  Surface(
    onClick = onClick,
    modifier = Modifier.size(width = 54.dp, height = 42.dp),
    shape = RoundedCornerShape(ClawTheme.radii.control),
    color = Color.Transparent,
    contentColor = ClawTheme.colors.text,
    border = BorderStroke(1.dp, ClawTheme.colors.borderStrong),
  ) {
    Box(contentAlignment = Alignment.Center) {
      Icon(imageVector = icon, contentDescription = contentDescription, modifier = Modifier.size(24.dp))
    }
  }
}

@Composable
private fun V2FilterPill(
  text: String,
  icon: ImageVector? = null,
  active: Boolean = false,
  live: Boolean = false,
) {
  Surface(
    shape = RoundedCornerShape(ClawTheme.radii.control),
    color = if (active) ClawTheme.colors.surfaceRaised else Color.Transparent,
    contentColor = ClawTheme.colors.text,
    border = BorderStroke(1.dp, if (active) ClawTheme.colors.borderStrong else ClawTheme.colors.border),
  ) {
    Row(
      modifier = Modifier.padding(horizontal = 10.dp, vertical = 7.dp),
      verticalAlignment = Alignment.CenterVertically,
      horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
      icon?.let { Icon(imageVector = it, contentDescription = null, modifier = Modifier.size(18.dp), tint = ClawTheme.colors.text) }
      Text(text = text, style = ClawTheme.type.label, color = ClawTheme.colors.text, maxLines = 1)
      if (live) {
        Box(modifier = Modifier.size(7.dp).clip(CircleShape).background(ClawTheme.colors.success))
      }
    }
  }
}

@Composable
private fun V2SessionRow(
  title: String,
  subtitle: String,
  metadata: String,
  active: Boolean,
  onClick: () -> Unit,
) {
  Surface(onClick = onClick, color = ClawTheme.colors.canvas, contentColor = ClawTheme.colors.text) {
    Column {
      Row(
        modifier = Modifier.fillMaxWidth().padding(vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(14.dp),
      ) {
        Surface(
          modifier = Modifier.size(48.dp),
          shape = CircleShape,
          color = Color.Transparent,
          border = BorderStroke(1.dp, ClawTheme.colors.borderStrong),
        ) {
          Box(contentAlignment = Alignment.Center) {
            Icon(
              imageVector = if (active) Icons.Default.StarBorder else Icons.Default.ChatBubble,
              contentDescription = null,
              modifier = Modifier.size(24.dp),
              tint = ClawTheme.colors.text,
            )
          }
        }

        Column(modifier = Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(6.dp)) {
          Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(
              text = title,
              style = ClawTheme.type.body,
              color = ClawTheme.colors.text,
              modifier = Modifier.weight(1f),
              maxLines = 1,
              overflow = TextOverflow.Ellipsis,
            )
            if (active) {
              Box(modifier = Modifier.size(7.dp).clip(CircleShape).background(ClawTheme.colors.success))
            }
          }
          Text(text = subtitle, style = ClawTheme.type.caption, color = ClawTheme.colors.textMuted, maxLines = 1)
          Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            V2MiniTag(text = "Workspace")
            V2MiniTag(text = if (active) "Active" else "OpenClaw")
          }
        }

        Column(horizontalAlignment = Alignment.End, verticalArrangement = Arrangement.spacedBy(12.dp)) {
          Icon(imageVector = Icons.Default.MoreVert, contentDescription = "Session options", modifier = Modifier.size(22.dp), tint = ClawTheme.colors.textMuted)
          Text(text = metadata, style = ClawTheme.type.caption, color = ClawTheme.colors.textMuted, maxLines = 1)
        }
      }
      HorizontalDivider(color = ClawTheme.colors.border, thickness = 1.dp)
    }
  }
}

@Composable
private fun V2MiniTag(text: String) {
  Surface(
    shape = RoundedCornerShape(5.dp),
    color = Color.Transparent,
    border = BorderStroke(1.dp, ClawTheme.colors.border),
    contentColor = ClawTheme.colors.textMuted,
  ) {
    Text(text = text, modifier = Modifier.padding(horizontal = 7.dp, vertical = 3.dp), style = ClawTheme.type.caption, maxLines = 1)
  }
}

@Composable
private fun V2SessionsScreen(
  viewModel: MainViewModel,
  onOpenChat: () -> Unit,
) {
  val sessions by viewModel.chatSessions.collectAsState()
  val chatSessionKey by viewModel.chatSessionKey.collectAsState()
  val isConnected by viewModel.isConnected.collectAsState()

  LaunchedEffect(isConnected) {
    if (isConnected) {
      viewModel.refreshChatSessions(limit = 200)
    }
  }

  ClawScaffold(contentPadding = PaddingValues(start = 20.dp, top = 18.dp, end = 20.dp, bottom = 24.dp)) {
    LazyColumn(verticalArrangement = Arrangement.spacedBy(14.dp)) {
      item {
        Row(
          modifier = Modifier.fillMaxWidth(),
          verticalAlignment = Alignment.CenterVertically,
          horizontalArrangement = Arrangement.spacedBy(12.dp),
        ) {
          Text(text = "Sessions", style = ClawTheme.type.display, color = ClawTheme.colors.text, modifier = Modifier.weight(1f))
          V2PlainIconButton(icon = Icons.Default.Search, contentDescription = "Search sessions", onClick = {})
          V2PlainIconButton(icon = Icons.Default.MoreVert, contentDescription = "Session options", onClick = {})
        }
      }

      item {
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
          V2FilterPill(text = "Recent", icon = Icons.Default.AccessTime, active = true)
          V2FilterPill(text = "Live", icon = Icons.Default.Mic, active = false, live = true)
          V2FilterPill(text = "Pinned", icon = Icons.Default.StarBorder, active = false)
        }
      }

      item {
        Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
          Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            V2FilterPill(text = "Channel")
            V2FilterPill(text = "Agent")
          }
          V2OutlineIconButton(icon = Icons.Default.Storage, contentDescription = "Session layout", onClick = {})
        }
      }

      item {
        Text(text = "Sort: Recent", style = ClawTheme.type.body, color = ClawTheme.colors.textMuted)
      }

      if (sessions.isEmpty()) {
        item {
          ClawEmptyState(
            title = "No sessions yet",
            body = "Start a new conversation and it will show up here.",
            action = { ClawPrimaryButton(text = "Start Chat", onClick = onOpenChat) },
          )
        }
      } else {
        items(sessions, key = { it.key }) { session ->
          val active = session.key == chatSessionKey
          V2SessionRow(
            title = displaySessionTitle(session.displayName),
            subtitle = if (active) "Current session" else "OpenClaw session",
            metadata = session.updatedAtMs?.let(::relativeSessionTime) ?: "now",
            active = active,
            onClick = {
              viewModel.switchChatSession(session.key)
              onOpenChat()
            },
          )
        }
      }

      item {
        Spacer(modifier = Modifier.height(16.dp))
      }
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
