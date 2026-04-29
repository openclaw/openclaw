package ai.openclaw.app.ui

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.WindowInsetsSides
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.only
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.layout.consumeWindowInsets
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ScreenShare
import androidx.compose.material.icons.filled.ChatBubble
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.Menu
import androidx.compose.material.icons.filled.Pets
import androidx.compose.material.icons.filled.RecordVoiceOver
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.DrawerValue
import androidx.compose.material3.ModalDrawerSheet
import androidx.compose.material3.ModalNavigationDrawer
import androidx.compose.material3.NavigationDrawerItem
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.rememberDrawerState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.zIndex
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch
import ai.openclaw.app.HomeDestination
import ai.openclaw.app.MainViewModel
import ai.openclaw.app.ui.buddy.BuddyModeScreen

private enum class HomeTab(
  val label: String,
  val icon: ImageVector,
) {
  Connect(label = "Connect", icon = Icons.Default.CheckCircle),
  Chat(label = "Chat", icon = Icons.Default.ChatBubble),
  Buddy(label = "Nemo", icon = Icons.Default.Pets),
  Voice(label = "Voice", icon = Icons.Default.RecordVoiceOver),
  Screen(label = "Screen", icon = Icons.AutoMirrored.Filled.ScreenShare),
  Settings(label = "Settings", icon = Icons.Default.Settings),
}

private enum class StatusVisual {
  Connected,
  Connecting,
  Warning,
  Error,
  Offline,
}

@Composable
fun PostOnboardingTabs(viewModel: MainViewModel, modifier: Modifier = Modifier) {
  var activeTab by rememberSaveable { mutableStateOf(HomeTab.Buddy) }
  var chatTabStarted by rememberSaveable { mutableStateOf(false) }
  var screenTabStarted by rememberSaveable { mutableStateOf(false) }
  val requestedHomeDestination by viewModel.requestedHomeDestination.collectAsState()

  LaunchedEffect(requestedHomeDestination) {
    val destination = requestedHomeDestination ?: return@LaunchedEffect
    activeTab =
      when (destination) {
        HomeDestination.Connect -> HomeTab.Connect
        HomeDestination.Chat -> HomeTab.Chat
        HomeDestination.Voice -> HomeTab.Voice
        HomeDestination.Screen -> HomeTab.Screen
        HomeDestination.Settings -> HomeTab.Settings
      }
    viewModel.clearRequestedHomeDestination()
  }

  // Stop TTS when user navigates away from voice tab, and lazily keep the Chat/Screen tabs
  // alive after the first visit so repeated tab switches do not rebuild their UI trees.
  LaunchedEffect(activeTab) {
    viewModel.setBuddyModeActive(activeTab == HomeTab.Buddy)
    viewModel.setVoiceScreenActive(activeTab == HomeTab.Voice)
    if (activeTab == HomeTab.Chat) {
      chatTabStarted = true
    }
    if (activeTab == HomeTab.Screen) {
      screenTabStarted = true
    }
  }

  val statusText by viewModel.statusText.collectAsState()
  val isConnected by viewModel.isConnected.collectAsState()
  val drawerState = rememberDrawerState(DrawerValue.Closed)
  val scope = rememberCoroutineScope()

  BackHandler(enabled = drawerState.isOpen) {
    scope.launch { drawerState.close() }
  }

  val statusVisual =
    remember(statusText, isConnected) {
      val lower = statusText.lowercase()
      when {
        isConnected -> StatusVisual.Connected
        lower.contains("connecting") || lower.contains("reconnecting") -> StatusVisual.Connecting
        lower.contains("pairing") || lower.contains("approval") || lower.contains("auth") -> StatusVisual.Warning
        lower.contains("error") || lower.contains("failed") -> StatusVisual.Error
        else -> StatusVisual.Offline
      }
    }

  ModalNavigationDrawer(
    drawerState = drawerState,
    drawerContent = {
      HomeNavigationDrawer(
        activeTab = activeTab,
        onSelect = { tab ->
          activeTab = tab
          scope.launch { drawerState.close() }
        },
      )
    },
    modifier = modifier,
  ) {
    Scaffold(
      containerColor = Color.Transparent,
      contentWindowInsets = WindowInsets(0, 0, 0, 0),
      topBar = {
        if (activeTab != HomeTab.Buddy) {
          TopStatusBar(
            activeTab = activeTab,
            statusText = statusText,
            statusVisual = statusVisual,
            onMenuClick = { scope.launch { drawerState.open() } },
          )
        }
      },
    ) { innerPadding ->
      Box(
        modifier =
          Modifier
            .fillMaxSize()
            .padding(innerPadding)
            .consumeWindowInsets(innerPadding)
            .background(mobileBackgroundGradient),
      ) {
        if (chatTabStarted) {
          Box(
            modifier =
              Modifier
                .matchParentSize()
                .alpha(if (activeTab == HomeTab.Chat) 1f else 0f)
                .zIndex(if (activeTab == HomeTab.Chat) 1f else 0f),
          ) {
            ChatSheet(viewModel = viewModel)
          }
        }

        if (screenTabStarted) {
          ScreenTabScreen(
            viewModel = viewModel,
            visible = activeTab == HomeTab.Screen,
            modifier =
              Modifier
                .matchParentSize()
                .alpha(if (activeTab == HomeTab.Screen) 1f else 0f)
                .zIndex(if (activeTab == HomeTab.Screen) 1f else 0f),
          )
        }

        when (activeTab) {
          HomeTab.Connect -> ConnectTabScreen(viewModel = viewModel)
          HomeTab.Chat -> if (!chatTabStarted) ChatSheet(viewModel = viewModel)
          HomeTab.Buddy -> BuddyModeScreen(viewModel = viewModel)
          HomeTab.Voice -> VoiceTabScreen(viewModel = viewModel)
          HomeTab.Screen -> Unit
          HomeTab.Settings -> SettingsSheet(viewModel = viewModel)
        }
        if (activeTab == HomeTab.Buddy) {
          BuddyDebugEntry(
            onClick = { scope.launch { drawerState.open() } },
            modifier = Modifier.align(Alignment.TopStart),
          )
        }
      }
    }
  }
}

@Composable
private fun HomeNavigationDrawer(
  activeTab: HomeTab,
  onSelect: (HomeTab) -> Unit,
) {
  val safeInsets = WindowInsets.safeDrawing.only(WindowInsetsSides.Top + WindowInsetsSides.Bottom)

  ModalDrawerSheet(
    modifier = Modifier.widthIn(max = 320.dp).windowInsetsPadding(safeInsets),
    drawerContainerColor = mobileCardSurface,
    drawerContentColor = mobileText,
  ) {
    Column(
      modifier =
        Modifier
          .fillMaxWidth()
          .verticalScroll(rememberScrollState())
          .padding(horizontal = 12.dp, vertical = 16.dp),
      verticalArrangement = Arrangement.spacedBy(4.dp),
    ) {
      Text(
        text = "OpenClaw",
        style = mobileTitle2,
        color = mobileText,
        modifier = Modifier.padding(horizontal = 16.dp, vertical = 10.dp),
      )
      HomeTab.entries.forEach { tab ->
        NavigationDrawerItem(
          selected = tab == activeTab,
          onClick = { onSelect(tab) },
          icon = {
            Icon(
              imageVector = tab.icon,
              contentDescription = null,
              tint = if (tab == activeTab) mobileAccent else mobileTextSecondary,
            )
          },
          label = {
            Text(
              text = tab.label,
              color = if (tab == activeTab) mobileAccent else mobileText,
              style = mobileBody.copy(fontWeight = if (tab == activeTab) FontWeight.Bold else FontWeight.Medium),
            )
          },
        )
      }
    }
  }
}

@Composable
private fun BuddyDebugEntry(
  onClick: () -> Unit,
  modifier: Modifier = Modifier,
) {
  val safeInsets = WindowInsets.safeDrawing.only(WindowInsetsSides.Top + WindowInsetsSides.Start)

  Surface(
    modifier =
      modifier
        .windowInsetsPadding(safeInsets)
        .padding(start = 10.dp, top = 10.dp)
        .size(44.dp),
    onClick = onClick,
    shape = RoundedCornerShape(999.dp),
    color = Color(0x660C1115),
    shadowElevation = 0.dp,
  ) {
    Box(contentAlignment = Alignment.Center) {
      Icon(
        imageVector = Icons.Default.Menu,
        contentDescription = "Open debug menu",
        tint = Color(0xFFE9FFFF),
      )
    }
  }
}

@Composable
private fun ScreenTabScreen(viewModel: MainViewModel, visible: Boolean, modifier: Modifier = Modifier) {
  val isConnected by viewModel.isConnected.collectAsState()
  var refreshedForCurrentConnection by rememberSaveable(isConnected) { mutableStateOf(false) }

  LaunchedEffect(isConnected, visible, refreshedForCurrentConnection) {
    if (visible && isConnected && !refreshedForCurrentConnection) {
      viewModel.refreshHomeCanvasOverviewIfConnected()
      refreshedForCurrentConnection = true
    }
  }

  Box(modifier = modifier.fillMaxSize()) {
    CanvasScreen(viewModel = viewModel, visible = visible, modifier = Modifier.fillMaxSize())
  }
}

@Composable
private fun TopStatusBar(
  activeTab: HomeTab,
  statusText: String,
  statusVisual: StatusVisual,
  onMenuClick: () -> Unit,
) {
  val safeInsets = WindowInsets.safeDrawing.only(WindowInsetsSides.Top + WindowInsetsSides.Horizontal)

  val (chipBg, chipDot, chipText, chipBorder) =
    when (statusVisual) {
      StatusVisual.Connected ->
        listOf(
          mobileSuccessSoft,
          mobileSuccess,
          mobileSuccess,
          LocalMobileColors.current.chipBorderConnected,
        )
      StatusVisual.Connecting ->
        listOf(
          mobileAccentSoft,
          mobileAccent,
          mobileAccent,
          LocalMobileColors.current.chipBorderConnecting,
        )
      StatusVisual.Warning ->
        listOf(
          mobileWarningSoft,
          mobileWarning,
          mobileWarning,
          LocalMobileColors.current.chipBorderWarning,
        )
      StatusVisual.Error ->
        listOf(
          mobileDangerSoft,
          mobileDanger,
          mobileDanger,
          LocalMobileColors.current.chipBorderError,
        )
      StatusVisual.Offline ->
        listOf(
          mobileSurface,
          mobileTextTertiary,
          mobileTextSecondary,
          mobileBorder,
        )
    }

  Surface(
    modifier = Modifier.fillMaxWidth().windowInsetsPadding(safeInsets),
    color = Color.Transparent,
    shadowElevation = 0.dp,
  ) {
    Row(
      modifier = Modifier.fillMaxWidth().padding(start = 6.dp, end = 18.dp, top = 8.dp, bottom = 8.dp),
      verticalAlignment = Alignment.CenterVertically,
      horizontalArrangement = Arrangement.SpaceBetween,
    ) {
      IconButton(onClick = onMenuClick) {
        Icon(
          imageVector = Icons.Default.Menu,
          contentDescription = "Open navigation",
          tint = mobileText,
        )
      }
      Text(
        text = activeTab.label,
        style = mobileTitle2,
        color = mobileText,
        maxLines = 1,
        overflow = TextOverflow.Ellipsis,
        modifier = Modifier.weight(1f),
      )
      Spacer(modifier = Modifier.width(12.dp))
      Surface(
        shape = RoundedCornerShape(999.dp),
        color = chipBg,
        border = androidx.compose.foundation.BorderStroke(1.dp, chipBorder),
      ) {
        Row(
          modifier = Modifier.padding(horizontal = 10.dp, vertical = 5.dp),
          horizontalArrangement = Arrangement.spacedBy(6.dp),
          verticalAlignment = Alignment.CenterVertically,
        ) {
          Surface(
            modifier = Modifier.padding(top = 1.dp),
            color = chipDot,
            shape = RoundedCornerShape(999.dp),
          ) {
            Box(modifier = Modifier.padding(4.dp))
          }
          Text(
            text = statusText.trim().ifEmpty { "Offline" },
            style = mobileCaption1,
            color = chipText,
            maxLines = 1,
          )
        }
      }
    }
  }
}
