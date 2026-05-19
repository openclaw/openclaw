package ai.openclaw.app.ui

import ai.openclaw.app.BuildConfig
import ai.openclaw.app.GatewayModelProviderSummary
import ai.openclaw.app.GatewayModelSummary
import ai.openclaw.app.HomeDestination
import ai.openclaw.app.MainViewModel
import ai.openclaw.app.providerDisplayName
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
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.ExitToApp
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.filled.AccessTime
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Apps
import androidx.compose.material.icons.filled.Cloud
import androidx.compose.material.icons.filled.Code
import androidx.compose.material.icons.filled.KeyboardArrowDown
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
  ProvidersModels(key = "providers-models", label = "Providers"),
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
        V2Tab.ProvidersModels ->
          V2ProvidersModelsScreen(
            viewModel = viewModel,
            onBack = { activeTab = V2Tab.Overview },
            onAddProvider = { activeTab = V2Tab.Settings },
          )
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
              style = ClawTheme.type.title.copy(fontSize = 11.4.sp, lineHeight = 14.sp),
              color = ClawTheme.colors.text,
              modifier = Modifier.weight(1f),
            )
            V2PlainIconButton(icon = Icons.Default.Search, contentDescription = "Search", onClick = {})
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
                V2ModuleRow("Channels", null, null, Icons.Outlined.Apps, V2Tab.Settings),
                V2ModuleRow(
                  title = "Providers & Models",
                  subtitle = null,
                  metadata = if (isConnected) "5 active" else "Offline",
                  icon = Icons.Outlined.Inventory2,
                  tab = V2Tab.ProvidersModels,
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
      Text(text = "Chat", style = ClawTheme.type.title.copy(fontSize = 10.8.sp, lineHeight = 13.sp))
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
      Text(text = text.take(2).uppercase(), style = ClawTheme.type.label.copy(fontSize = 9.4.sp, lineHeight = 12.sp))
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
    Text(text = title.uppercase(), style = ClawTheme.type.caption.copy(fontSize = 8.6.sp, lineHeight = 11.sp), color = ClawTheme.colors.textMuted)
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
        style = ClawTheme.type.body.copy(fontSize = 9.4.sp, lineHeight = 12.sp),
        color = ClawTheme.colors.text,
        modifier = Modifier.weight(1f),
        maxLines = 1,
        overflow = TextOverflow.Ellipsis,
      )
      row.metadata?.let {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(5.dp)) {
          Box(modifier = Modifier.size(4.5.dp).clip(CircleShape).background(statusDotColor(it)))
          Text(text = it, style = ClawTheme.type.caption.copy(fontSize = 8.1.sp, lineHeight = 10.5.sp), color = ClawTheme.colors.textMuted, maxLines = 1)
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
        Text(text = title, style = ClawTheme.type.body.copy(fontSize = 9.3.sp, lineHeight = 12.sp), color = ClawTheme.colors.text, maxLines = 1)
        Text(text = subtitle, style = ClawTheme.type.caption.copy(fontSize = 7.9.sp, lineHeight = 10.5.sp), color = ClawTheme.colors.textSubtle, maxLines = 1)
      }
      Text(text = metadata, style = ClawTheme.type.caption.copy(fontSize = 8.1.sp, lineHeight = 10.5.sp), color = ClawTheme.colors.textMuted)
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
private fun V2ProvidersModelsScreen(
  viewModel: MainViewModel,
  onBack: () -> Unit,
  onAddProvider: () -> Unit,
) {
  val isConnected by viewModel.isConnected.collectAsState()
  val models by viewModel.modelCatalog.collectAsState()
  val providers by viewModel.modelAuthProviders.collectAsState()
  val refreshing by viewModel.modelCatalogRefreshing.collectAsState()
  val errorText by viewModel.modelCatalogErrorText.collectAsState()
  val providerRows = providerRows(providers = providers, models = models)
  val modelGroups = sortedModelGroups(models)

  LaunchedEffect(isConnected) {
    if (isConnected) {
      viewModel.refreshModelCatalog()
    }
  }

  ClawScaffold(contentPadding = PaddingValues(start = 20.dp, top = 13.dp, end = 20.dp, bottom = 13.dp)) {
    Box(modifier = Modifier.fillMaxSize()) {
      LazyColumn(verticalArrangement = Arrangement.spacedBy(7.dp), contentPadding = PaddingValues(bottom = 52.dp)) {
        item {
          Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Row(
              modifier = Modifier.fillMaxWidth(),
              verticalAlignment = Alignment.CenterVertically,
              horizontalArrangement = Arrangement.SpaceBetween,
            ) {
              V2HeaderIconButton(icon = Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back", onClick = onBack)
              V2HeaderIconButton(icon = Icons.Default.Add, contentDescription = "Add provider", outlined = true, onClick = onAddProvider)
            }
            Column(verticalArrangement = Arrangement.spacedBy(3.dp)) {
              Text(text = "Providers & Models", style = ClawTheme.type.display.copy(fontSize = 14.8.sp, lineHeight = 18.sp), color = ClawTheme.colors.text, maxLines = 1)
              Text(
                text = "Connect and manage AI providers\nBrowse models and their capabilities.",
                style = ClawTheme.type.caption.copy(fontSize = 8.4.sp, lineHeight = 11.sp),
                color = ClawTheme.colors.textMuted,
              )
            }
          }
        }

        item {
          V2SectionLabel(title = "Providers")
        }

        item {
          if (!isConnected && providerRows.isEmpty()) {
            ClawEmptyState(title = "Gateway offline", body = "Connect your Gateway to load provider readiness and model catalog.")
          } else {
            V2ProviderList(rows = providerRows, refreshing = refreshing)
          }
        }

        errorText?.let { message ->
          item {
            ClawPanel {
              Text(text = message, style = ClawTheme.type.body, color = ClawTheme.colors.textMuted)
            }
          }
        }

        item {
          V2SectionLabel(title = "Model catalog")
        }

        if (modelGroups.isEmpty()) {
          item {
            V2ModelCatalogEmpty(
              title = if (refreshing) "Loading models" else "No models loaded",
              body = if (isConnected) "Refresh after configuring a provider on the Gateway." else "Connect the Gateway to browse models.",
            )
          }
        } else {
          items(modelGroups, key = { it.first }) { entry ->
            V2ModelGroup(provider = entry.first, models = entry.second)
          }
        }
      }
      V2ProviderAddButton(onClick = onAddProvider, modifier = Modifier.align(Alignment.BottomCenter))
    }
  }
}

private data class V2ProviderRow(
  val id: String,
  val name: String,
  val status: String,
  val ready: Boolean,
  val modelCount: Int,
)

private fun providerRows(
  providers: List<GatewayModelProviderSummary>,
  models: List<GatewayModelSummary>,
): List<V2ProviderRow> {
  val modelCounts = models.groupingBy { it.provider }.eachCount()
  val authRows =
    providers.map { provider ->
      val ready = modelProviderReady(provider.status)
      V2ProviderRow(
        id = provider.id,
        name = provider.displayName,
        status = if (ready) "Ready" else "Needs setup",
        ready = ready,
        modelCount = modelCounts[provider.id] ?: 0,
      )
    }
  val missingAuthRows =
    modelCounts.keys
      .filter { provider -> authRows.none { it.id == provider } }
      .map { provider ->
        V2ProviderRow(
          id = provider,
          name = providerDisplayName(provider),
          status = "Ready",
          ready = true,
          modelCount = modelCounts[provider] ?: 0,
        )
      }
  return (authRows + missingAuthRows).sortedWith(compareBy(::providerPriority, { it.name.lowercase() }))
}

private fun modelProviderReady(status: String): Boolean {
  val normalized = status.trim().lowercase()
  return normalized == "ok" || normalized == "ready" || normalized == "healthy" || normalized == "configured"
}

private fun sortedModelGroups(models: List<GatewayModelSummary>): List<Pair<String, List<GatewayModelSummary>>> =
  models
    .groupBy { it.provider }
    .entries
    .sortedWith(compareBy({ providerPriority(it.key) }, { providerDisplayName(it.key).lowercase() }))
    .map { it.key to it.value }

private fun providerPriority(row: V2ProviderRow): Int = providerPriority(row.id)

private fun providerPriority(provider: String): Int =
  when (provider.trim().lowercase()) {
    "openai" -> 0
    "anthropic" -> 1
    "google" -> 2
    "openrouter" -> 3
    "ollama", "ollama-local" -> 4
    "codex", "openai-codex" -> 5
    else -> 100
  }

@Composable
private fun V2ProviderList(
  rows: List<V2ProviderRow>,
  refreshing: Boolean,
) {
  ClawPanel(contentPadding = PaddingValues(horizontal = 0.dp, vertical = 0.dp)) {
    Column {
      if (rows.isEmpty()) {
        V2ProviderListRow(V2ProviderRow(id = "loading", name = "Provider catalog", status = if (refreshing) "Loading" else "No providers", ready = false, modelCount = 0))
      } else {
        val visibleRows = rows.take(5)
        visibleRows.forEachIndexed { index, row ->
          V2ProviderListRow(row)
          if (index != visibleRows.lastIndex) {
            HorizontalDivider(color = ClawTheme.colors.border, thickness = 1.dp)
          }
        }
      }
    }
  }
}

@Composable
private fun V2ProviderListRow(row: V2ProviderRow) {
  Row(modifier = Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 4.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
    V2ProviderBadge(text = row.name)
    Column(modifier = Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(1.dp)) {
      Text(text = row.name, style = ClawTheme.type.body.copy(fontSize = 9.2.sp, lineHeight = 11.8.sp), color = ClawTheme.colors.text, maxLines = 1)
      Text(text = if (row.modelCount > 0) "${row.modelCount} models" else "Provider setup", style = ClawTheme.type.caption.copy(fontSize = 7.8.sp, lineHeight = 10.sp), color = ClawTheme.colors.textMuted, maxLines = 1)
    }
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(5.dp)) {
      Box(modifier = Modifier.size(4.5.dp).clip(CircleShape).background(if (row.ready) ClawTheme.colors.success else ClawTheme.colors.warning))
      Text(text = row.status, style = ClawTheme.type.caption.copy(fontSize = 8.sp, lineHeight = 10.5.sp), color = ClawTheme.colors.textMuted, maxLines = 1)
      Icon(imageVector = Icons.AutoMirrored.Filled.KeyboardArrowRight, contentDescription = "Open ${row.name}", modifier = Modifier.size(14.dp), tint = ClawTheme.colors.text)
    }
  }
}

@Composable
private fun V2ProviderBadge(text: String) {
  Surface(modifier = Modifier.size(24.dp), shape = RoundedCornerShape(6.dp), color = ClawTheme.colors.surfacePressed, border = BorderStroke(1.dp, ClawTheme.colors.border)) {
    Box(contentAlignment = Alignment.Center) {
      Text(text = providerInitials(text), style = ClawTheme.type.section.copy(fontSize = 9.2.sp, lineHeight = 11.5.sp), color = ClawTheme.colors.text, textAlign = TextAlign.Center)
    }
  }
}

private fun providerInitials(value: String): String =
  value
    .split(' ', '-', '_')
    .filter { it.isNotBlank() }
    .take(2)
    .mapNotNull { it.firstOrNull()?.uppercaseChar()?.toString() }
    .joinToString("")
    .ifBlank { "AI" }

@Composable
private fun V2ModelCatalogEmpty(
  title: String,
  body: String,
) {
  ClawPanel(contentPadding = PaddingValues(horizontal = 11.dp, vertical = 10.dp)) {
    Column(modifier = Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(4.dp)) {
      Text(text = title, style = ClawTheme.type.section.copy(fontSize = 10.8.sp, lineHeight = 14.sp), color = ClawTheme.colors.text)
      Text(text = body, style = ClawTheme.type.caption.copy(fontSize = 8.8.sp, lineHeight = 12.sp), color = ClawTheme.colors.textMuted)
    }
  }
}

@Composable
private fun V2ModelGroup(
  provider: String,
  models: List<GatewayModelSummary>,
) {
  ClawPanel(contentPadding = PaddingValues(horizontal = 0.dp, vertical = 0.dp)) {
    Column {
      Row(modifier = Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 5.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        V2ProviderBadge(text = providerDisplayName(provider))
        Text(text = providerDisplayName(provider), style = ClawTheme.type.body.copy(fontSize = 9.5.sp, lineHeight = 12.sp), color = ClawTheme.colors.text, modifier = Modifier.weight(1f), maxLines = 1)
        V2MiniTag(text = "${models.size} models")
        Icon(imageVector = Icons.Default.KeyboardArrowDown, contentDescription = null, modifier = Modifier.size(13.dp), tint = ClawTheme.colors.textMuted)
      }
      HorizontalDivider(color = ClawTheme.colors.border, thickness = 1.dp)
      models.take(3).forEach { model ->
        V2ModelRow(model)
        HorizontalDivider(color = ClawTheme.colors.border, thickness = 1.dp)
      }
      if (models.size > 3) {
        Row(modifier = Modifier.fillMaxWidth().padding(horizontal = 10.dp, vertical = 6.dp), verticalAlignment = Alignment.CenterVertically) {
          Text(text = "View all models", style = ClawTheme.type.caption.copy(fontSize = 8.2.sp, lineHeight = 10.5.sp), color = ClawTheme.colors.textMuted, modifier = Modifier.weight(1f))
          Icon(imageVector = Icons.AutoMirrored.Filled.KeyboardArrowRight, contentDescription = null, modifier = Modifier.size(14.dp), tint = ClawTheme.colors.text)
        }
      }
    }
  }
}

@Composable
private fun V2ModelRow(model: GatewayModelSummary) {
  Row(modifier = Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 4.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
    Text(text = model.name, style = ClawTheme.type.mono.copy(fontSize = 8.2.sp, lineHeight = 10.5.sp), color = ClawTheme.colors.text, modifier = Modifier.weight(1f), maxLines = 1, overflow = TextOverflow.Ellipsis)
    modelCapabilityLabels(model).take(3).forEach { label ->
      V2MiniTag(text = label)
    }
    Box(modifier = Modifier.size(4.5.dp).clip(CircleShape).background(ClawTheme.colors.success))
  }
}

private fun modelCapabilityLabels(model: GatewayModelSummary): List<String> =
  buildList {
    if (model.supportsReasoning) add("Reasoning")
    if (model.supportsVision) add("Vision")
    if (model.supportsAudio) add("Voice")
    if (model.supportsDocuments) add("Docs")
    if ((model.contextTokens ?: 0L) >= 100_000L) add("Long context")
    if (isEmpty()) add("Fast")
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
          Text(text = "Settings", style = ClawTheme.type.title.copy(fontSize = 18.sp, lineHeight = 22.sp), color = ClawTheme.colors.text, modifier = Modifier.weight(1f))
          V2SettingsSearchButton(onClick = {})
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
          Text(text = "OpenClaw ${BuildConfig.VERSION_NAME} (${BuildConfig.VERSION_CODE})", style = ClawTheme.type.caption, color = ClawTheme.colors.textMuted)
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
  ClawPanel(contentPadding = PaddingValues(horizontal = 11.dp, vertical = 10.dp)) {
    Row(
      modifier = Modifier.fillMaxWidth(),
      verticalAlignment = Alignment.CenterVertically,
      horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
      Surface(
        modifier = Modifier.size(38.dp),
        shape = CircleShape,
        color = ClawTheme.colors.surfacePressed,
        border = BorderStroke(1.dp, ClawTheme.colors.borderStrong),
      ) {
        Box(contentAlignment = Alignment.Center) {
          Text(
            text = displayName.firstOrNull()?.uppercase() ?: "O",
            style = ClawTheme.type.title,
            color = ClawTheme.colors.text,
            textAlign = TextAlign.Center,
          )
        }
      }
      Column(modifier = Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
        Text(text = displayName, style = ClawTheme.type.section.copy(fontSize = 12.3.sp, lineHeight = 15.sp), color = ClawTheme.colors.text, maxLines = 1)
        Text(text = "OpenClaw mobile", style = ClawTheme.type.caption.copy(fontSize = 9.3.sp, lineHeight = 12.sp), color = ClawTheme.colors.textMuted, maxLines = 1)
      }
      Icon(
        imageVector = Icons.AutoMirrored.Filled.KeyboardArrowRight,
        contentDescription = "Open profile",
        modifier = Modifier.size(19.dp),
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
    modifier = Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 7.dp),
    verticalAlignment = Alignment.CenterVertically,
    horizontalArrangement = Arrangement.spacedBy(12.dp),
  ) {
    Icon(imageVector = row.icon, contentDescription = null, modifier = Modifier.size(18.dp), tint = ClawTheme.colors.text)
    Text(text = row.title, style = ClawTheme.type.body.copy(fontSize = 10.8.sp, lineHeight = 14.sp), color = ClawTheme.colors.text, modifier = Modifier.weight(1f), maxLines = 1)
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
      Text(text = row.value, style = ClawTheme.type.caption.copy(fontSize = 9.4.sp, lineHeight = 12.sp), color = ClawTheme.colors.textMuted, maxLines = 1)
      row.status?.let { active ->
        Box(modifier = Modifier.size(5.dp).clip(CircleShape).background(if (active) ClawTheme.colors.success else ClawTheme.colors.textSubtle))
      }
      Icon(
        imageVector = Icons.AutoMirrored.Filled.KeyboardArrowRight,
        contentDescription = "Open ${row.title}",
        modifier = Modifier.size(17.dp),
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

@Composable
private fun V2HeaderIconButton(
  icon: ImageVector,
  contentDescription: String,
  outlined: Boolean = false,
  onClick: () -> Unit,
) {
  Surface(
    onClick = onClick,
    modifier = Modifier.size(if (outlined) 28.dp else 30.dp),
    shape = CircleShape,
    color = Color.Transparent,
    contentColor = ClawTheme.colors.text,
    border = if (outlined) BorderStroke(1.dp, ClawTheme.colors.borderStrong) else null,
  ) {
    Box(contentAlignment = Alignment.Center) {
      Icon(imageVector = icon, contentDescription = contentDescription, modifier = Modifier.size(if (outlined) 15.dp else 19.dp))
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
    modifier = Modifier.size(width = 34.dp, height = 26.dp),
    shape = RoundedCornerShape(7.dp),
    color = Color.Transparent,
    contentColor = ClawTheme.colors.text,
    border = BorderStroke(1.dp, ClawTheme.colors.borderStrong),
  ) {
    Box(contentAlignment = Alignment.Center) {
      Icon(imageVector = icon, contentDescription = contentDescription, modifier = Modifier.size(14.dp))
    }
  }
}

@Composable
private fun V2ProviderAddButton(
  onClick: () -> Unit,
  modifier: Modifier = Modifier,
) {
  Surface(
    onClick = onClick,
    modifier = modifier.fillMaxWidth().height(30.dp),
    shape = RoundedCornerShape(ClawTheme.radii.pill),
    color = ClawTheme.colors.primary,
    contentColor = ClawTheme.colors.primaryText,
  ) {
    Row(
      modifier = Modifier.fillMaxSize(),
      verticalAlignment = Alignment.CenterVertically,
      horizontalArrangement = Arrangement.Center,
    ) {
      Icon(imageVector = Icons.Default.Add, contentDescription = null, modifier = Modifier.size(13.dp))
      Spacer(modifier = Modifier.width(7.dp))
      Text(text = "Add Provider", style = ClawTheme.type.label.copy(fontSize = 9.6.sp, lineHeight = 12.sp), maxLines = 1)
    }
  }
}

@Composable
private fun V2FilterPill(
  text: String,
  icon: ImageVector? = null,
  active: Boolean = false,
  live: Boolean = false,
  dropdown: Boolean = false,
) {
  Surface(
    shape = RoundedCornerShape(7.dp),
    color = if (active) ClawTheme.colors.surfaceRaised else Color.Transparent,
    contentColor = ClawTheme.colors.text,
    border = BorderStroke(1.dp, if (active) ClawTheme.colors.borderStrong else ClawTheme.colors.border),
  ) {
    Row(
      modifier = Modifier.padding(horizontal = 6.dp, vertical = 3.dp),
      verticalAlignment = Alignment.CenterVertically,
      horizontalArrangement = Arrangement.spacedBy(4.dp),
    ) {
      icon?.let { Icon(imageVector = it, contentDescription = null, modifier = Modifier.size(12.dp), tint = ClawTheme.colors.text) }
      Text(text = text, style = ClawTheme.type.label.copy(fontSize = 8.7.sp, lineHeight = 11.sp), color = ClawTheme.colors.text, maxLines = 1)
      if (live) {
        Box(modifier = Modifier.size(4.dp).clip(CircleShape).background(ClawTheme.colors.success))
      }
      if (dropdown) {
        Icon(imageVector = Icons.Default.KeyboardArrowDown, contentDescription = null, modifier = Modifier.size(11.dp), tint = ClawTheme.colors.textMuted)
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
        modifier = Modifier.fillMaxWidth().padding(vertical = 3.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(7.dp),
      ) {
        Surface(
          modifier = Modifier.size(21.dp),
          shape = CircleShape,
          color = Color.Transparent,
          border = BorderStroke(1.dp, ClawTheme.colors.borderStrong),
        ) {
          Box(contentAlignment = Alignment.Center) {
            Icon(
              imageVector = if (active) Icons.Default.StarBorder else Icons.Outlined.ChatBubbleOutline,
              contentDescription = null,
              modifier = Modifier.size(10.dp),
              tint = ClawTheme.colors.text,
            )
          }
        }

        Column(modifier = Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(1.5.dp)) {
          Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
            Text(
              text = title,
              style = ClawTheme.type.body.copy(fontSize = 8.8.sp, lineHeight = 11.2.sp),
              color = ClawTheme.colors.text,
              modifier = Modifier.weight(1f),
              maxLines = 1,
              overflow = TextOverflow.Ellipsis,
            )
            if (active) {
              Box(modifier = Modifier.size(3.5.dp).clip(CircleShape).background(ClawTheme.colors.success))
            }
          }
          Text(text = subtitle, style = ClawTheme.type.caption.copy(fontSize = 7.7.sp, lineHeight = 9.8.sp), color = ClawTheme.colors.textMuted, maxLines = 1)
          Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
            V2MiniTag(text = "Workspace")
            V2MiniTag(text = if (active) "Active" else "OpenClaw")
          }
        }

        Column(horizontalAlignment = Alignment.End, verticalArrangement = Arrangement.spacedBy(5.dp)) {
          Icon(imageVector = Icons.Default.MoreVert, contentDescription = "Session options", modifier = Modifier.size(13.dp), tint = ClawTheme.colors.textMuted)
          Text(text = metadata, style = ClawTheme.type.caption.copy(fontSize = 7.7.sp, lineHeight = 9.8.sp), color = ClawTheme.colors.textMuted, maxLines = 1)
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
    Text(text = text, modifier = Modifier.padding(horizontal = 4.dp, vertical = 0.5.dp), style = ClawTheme.type.caption.copy(fontSize = 7.1.sp, lineHeight = 9.sp), maxLines = 1)
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

  ClawScaffold(contentPadding = PaddingValues(start = 20.dp, top = 14.dp, end = 20.dp, bottom = 20.dp)) {
    LazyColumn(verticalArrangement = Arrangement.spacedBy(7.dp)) {
      item {
        Row(
          modifier = Modifier.fillMaxWidth(),
          verticalAlignment = Alignment.CenterVertically,
          horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
          Text(text = "Sessions", style = ClawTheme.type.display.copy(fontSize = 17.4.sp, lineHeight = 21.sp), color = ClawTheme.colors.text, modifier = Modifier.weight(1f))
          V2PlainIconButton(icon = Icons.Default.Search, contentDescription = "Search sessions", onClick = {})
          V2PlainIconButton(icon = Icons.Default.MoreVert, contentDescription = "Session options", onClick = {})
        }
      }

      item {
        Row(horizontalArrangement = Arrangement.spacedBy(5.dp)) {
          V2FilterPill(text = "Recent", icon = Icons.Outlined.AccessTime, active = true)
          V2FilterPill(text = "Live", icon = Icons.Outlined.MicNone, active = false, live = true)
          V2FilterPill(text = "Pinned", icon = Icons.Default.StarBorder, active = false)
        }
      }

      item {
        Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
          Row(horizontalArrangement = Arrangement.spacedBy(5.dp)) {
            V2FilterPill(text = "Channel", dropdown = true)
            V2FilterPill(text = "Agent", dropdown = true)
          }
          V2OutlineIconButton(icon = Icons.Default.Storage, contentDescription = "Session layout", onClick = {})
        }
      }

      item {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
          Text(text = "Sort: Recent", style = ClawTheme.type.body.copy(fontSize = 8.6.sp, lineHeight = 11.sp), color = ClawTheme.colors.textMuted)
          Icon(imageVector = Icons.Default.KeyboardArrowDown, contentDescription = null, modifier = Modifier.size(11.dp), tint = ClawTheme.colors.textMuted)
        }
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
