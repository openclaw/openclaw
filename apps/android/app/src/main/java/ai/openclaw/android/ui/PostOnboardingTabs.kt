package ai.openclaw.android.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.WindowInsetsSides
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.ime
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.only
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.layout.consumeWindowInsets
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ScreenShare
import androidx.compose.material.icons.filled.ChatBubble
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.RecordVoiceOver
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.Icon
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import ai.openclaw.android.MainViewModel

private enum class HomeTab(
  val label: String,
  val icon: ImageVector,
) {
  Connect(label = "Connect", icon = Icons.Default.CheckCircle),
  Chat(label = "Chat", icon = Icons.Default.ChatBubble),
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
  var activeTab by rememberSaveable { mutableStateOf(HomeTab.Connect) }

  val statusText by viewModel.statusText.collectAsState()
  val isConnected by viewModel.isConnected.collectAsState()

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

  val density = LocalDensity.current
  val imeVisible = WindowInsets.ime.getBottom(density) > 0
  val hideBottomTabBar = activeTab == HomeTab.Chat && imeVisible

  Scaffold(
    modifier = modifier,
    containerColor = Color.Transparent,
    contentWindowInsets = WindowInsets(0, 0, 0, 0),
    topBar = {
      TopStatusBar(
        statusText = statusText,
        statusVisual = statusVisual,
      )
    },
    bottomBar = {
      if (!hideBottomTabBar) {
        BottomTabBar(
          activeTab = activeTab,
          onSelect = { activeTab = it },
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
      when (activeTab) {
        HomeTab.Connect -> ConnectTabScreen(viewModel = viewModel)
        HomeTab.Chat -> ChatSheet(viewModel = viewModel)
        HomeTab.Voice -> VoiceTabScreen(viewModel = viewModel)
        HomeTab.Screen -> ScreenTabScreen(viewModel = viewModel)
        HomeTab.Settings -> SettingsSheet(viewModel = viewModel)
      }
    }
  }
}

@Composable
private fun ScreenTabScreen(viewModel: MainViewModel) {
  val isConnected by viewModel.isConnected.collectAsState()
  val isNodeConnected by viewModel.isNodeConnected.collectAsState()
  val canvasUrl by viewModel.canvasCurrentUrl.collectAsState()
  val canvasA2uiHydrated by viewModel.canvasA2uiHydrated.collectAsState()
  val canvasRehydratePending by viewModel.canvasRehydratePending.collectAsState()
  val canvasRehydrateErrorText by viewModel.canvasRehydrateErrorText.collectAsState()
  val isA2uiUrl = canvasUrl?.contains("/__openclaw__/a2ui/") == true
  val showRestoreCta = isConnected && isNodeConnected && (canvasUrl.isNullOrBlank() || (isA2uiUrl && !canvasA2uiHydrated))
  val restoreCtaText =
    when {
      canvasRehydratePending -> "Restore requested. Waiting for agent…"
      !canvasRehydrateErrorText.isNullOrBlank() -> canvasRehydrateErrorText!!
      else -> "Canvas reset. Tap to restore dashboard."
    }

  Box(modifier = Modifier.fillMaxSize()) {
    CanvasScreen(viewModel = viewModel, modifier = Modifier.fillMaxSize())

    if (showRestoreCta) {
      Surface(
        onClick = {
          if (canvasRehydratePending) return@Surface
          viewModel.requestCanvasRehydrate(source = "screen_tab_cta")
        },
        modifier = Modifier.align(Alignment.TopCenter).padding(horizontal = 16.dp, vertical = 16.dp),
        shape = RoundedCornerShape(12.dp),
        color = mobileSurface.copy(alpha = 0.9f),
        border = BorderStroke(1.dp, mobileBorder),
        shadowElevation = 4.dp,
      ) {
        Text(
          text = restoreCtaText,
          modifier = Modifier.padding(horizontal = 12.dp, vertical = 10.dp),
          style = mobileCallout.copy(fontWeight = FontWeight.Medium),
          color = mobileText,
        )
      }
    }
  }
}

@Composable
private fun TopStatusBar(
  statusText: String,
  statusVisual: StatusVisual,
) {
  val safeInsets = WindowInsets.safeDrawing.only(WindowInsetsSides.Top + WindowInsetsSides.Horizontal)

  val (chipBg, chipDot, chipText, chipBorder) =
    when (statusVisual) {
      StatusVisual.Connected ->
        listOf(
          mobileSuccessSoft,
          mobileSuccess,
          mobileSuccess,
          Color(0xFFCFEBD8),
        )
      StatusVisual.Connecting ->
        listOf(
          mobileAccentSoft,
          mobileAccent,
          mobileAccent,
          Color(0xFFD5E2FA),
        )
      StatusVisual.Warning ->
        listOf(
          mobileWarningSoft,
          mobileWarning,
          mobileWarning,
          Color(0xFFEED8B8),
        )
      StatusVisual.Error ->
        listOf(
          mobileDangerSoft,
          mobileDanger,
          mobileDanger,
          Color(0xFFF3C8C8),
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
      modifier = Modifier.fillMaxWidth().padding(horizontal = 18.dp, vertical = 12.dp),
      verticalAlignment = Alignment.CenterVertically,
      horizontalArrangement = Arrangement.SpaceBetween,
    ) {
      Text(
        text = "OpenClaw",
        style = mobileTitle2,
        color = mobileText,
      )
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

@Composable
private fun BottomTabBar(
  activeTab: HomeTab,
  onSelect: (HomeTab) -> Unit,
) {
  val safeInsets = WindowInsets.navigationBars.only(WindowInsetsSides.Bottom + WindowInsetsSides.Horizontal)

  Box(
    modifier =
      Modifier
        .fillMaxWidth(),
  ) {
    Surface(
      modifier = Modifier.fillMaxWidth(),
      color = Color.White.copy(alpha = 0.97f),
      shape = RoundedCornerShape(topStart = 24.dp, topEnd = 24.dp),
      border = BorderStroke(1.dp, mobileBorder),
      shadowElevation = 6.dp,
    ) {
      Row(
        modifier =
          Modifier
            .fillMaxWidth()
            .windowInsetsPadding(safeInsets)
            .padding(horizontal = 10.dp, vertical = 10.dp),
        horizontalArrangement = Arrangement.spacedBy(6.dp),
        verticalAlignment = Alignment.CenterVertically,
      ) {
        HomeTab.entries.forEach { tab ->
          val active = tab == activeTab
          Surface(
            onClick = { onSelect(tab) },
            modifier = Modifier.weight(1f).heightIn(min = 58.dp),
            shape = RoundedCornerShape(16.dp),
            color = if (active) mobileAccentSoft else Color.Transparent,
            border = if (active) BorderStroke(1.dp, Color(0xFFD5E2FA)) else null,
            shadowElevation = 0.dp,
          ) {
            Column(
              modifier = Modifier.fillMaxWidth().padding(horizontal = 6.dp, vertical = 7.dp),
              horizontalAlignment = Alignment.CenterHorizontally,
              verticalArrangement = Arrangement.spacedBy(2.dp),
            ) {
              Icon(
                imageVector = tab.icon,
                contentDescription = tab.label,
                tint = if (active) mobileAccent else mobileTextTertiary,
              )
              Text(
                text = tab.label,
                color = if (active) mobileAccent else mobileTextSecondary,
                style = mobileCaption2.copy(fontWeight = if (active) FontWeight.Bold else FontWeight.Medium),
              )
            }
          }
        }
      }
    }
  }
}
