package ai.openclaw.app.ui

import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.WindowInsetsSides
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.ime
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.only
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.layout.consumeWindowInsets
import androidx.compose.foundation.shape.CircleShape
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
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.zIndex
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import ai.openclaw.app.HomeDestination
import ai.openclaw.app.MainViewModel

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
        HomeTab.Voice -> VoiceTabScreen(viewModel = viewModel)
        HomeTab.Screen -> Unit
        HomeTab.Settings -> SettingsSheet(viewModel = viewModel)
      }
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

/**
 * Top status bar aligned to iOS StatusPill style:
 * - Compact pill with pulsing status dot
 * - Glass-card inspired background (dark translucent)
 * - iOS: RoundedRectangle cornerRadius 14, .ultraThinMaterial, black.opacity(0.18)
 */
@Composable
private fun TopStatusBar(
  statusText: String,
  statusVisual: StatusVisual,
) {
  val safeInsets = WindowInsets.safeDrawing.only(WindowInsetsSides.Top + WindowInsetsSides.Horizontal)

  // iOS status dot colors: .green, .yellow, .red, .gray
  val dotColor by animateColorAsState(
    targetValue =
      when (statusVisual) {
        StatusVisual.Connected -> Color(0xFF34C759) // iOS .green
        StatusVisual.Connecting -> Color(0xFFFFCC00) // iOS .yellow
        StatusVisual.Warning -> Color(0xFFFF9500) // iOS .orange
        StatusVisual.Error -> Color(0xFFFF3B30) // iOS .red
        StatusVisual.Offline -> Color(0xFF8E8E93) // iOS .gray
      },
    label = "dot-color",
  )

  // Pulsing animation for connecting state (iOS: .easeInOut(duration: 0.9).repeatForever)
  val pulseTransition = rememberInfiniteTransition(label = "status-pulse")
  val pulseScale by
    pulseTransition.animateFloat(
      initialValue = 0.85f,
      targetValue = 1.15f,
      animationSpec =
        infiniteRepeatable(
          animation = tween(durationMillis = 900),
          repeatMode = RepeatMode.Reverse,
        ),
      label = "pulse-scale",
    )
  val pulseAlpha by
    pulseTransition.animateFloat(
      initialValue = 0.6f,
      targetValue = 1.0f,
      animationSpec =
        infiniteRepeatable(
          animation = tween(durationMillis = 900),
          repeatMode = RepeatMode.Reverse,
        ),
      label = "pulse-alpha",
    )
  val isPulsing = statusVisual == StatusVisual.Connecting

  Surface(
    modifier = Modifier.fillMaxWidth().windowInsetsPadding(safeInsets),
    color = Color.Transparent,
    shadowElevation = 0.dp,
  ) {
    Row(
      // iOS: .padding(.horizontal, 12), .padding(.top, 10), .padding(.bottom, 8)
      modifier = Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 10.dp),
      verticalAlignment = Alignment.CenterVertically,
      horizontalArrangement = Arrangement.SpaceBetween,
    ) {
      // Status pill: iOS glass card style
      Surface(
        shape = RoundedCornerShape(14.dp),
        // iOS: Color.black.opacity(0.18) on dark background
        color = Color.Black.copy(alpha = 0.18f),
        border = BorderStroke(0.5.dp, Color.White.copy(alpha = 0.18f)),
      ) {
        Row(
          modifier = Modifier.padding(horizontal = 12.dp, vertical = 8.dp),
          horizontalArrangement = Arrangement.spacedBy(8.dp),
          verticalAlignment = Alignment.CenterVertically,
        ) {
          // Status dot (iOS: 8–9dp circle)
          val dotSize = if (isPulsing) 8.dp * pulseScale else 9.dp
          val dotAlpha = if (isPulsing) pulseAlpha else 1f
          Box(
            modifier =
              Modifier
                .size(dotSize)
                .alpha(dotAlpha)
                .drawBehind {
                  drawCircle(color = dotColor)
                },
          )
          // iOS: .footnote.weight(.semibold)
          Text(
            text = statusText.trim().ifEmpty { "Offline" },
            style = mobileCallout.copy(fontWeight = FontWeight.SemiBold),
            color = Color.White,
            maxLines = 1,
          )
        }
      }

      Spacer(modifier = Modifier.weight(1f))

      // App name on the right
      Text(
        text = "OpenClaw",
        style = mobileHeadline,
        color = Color.White.copy(alpha = 0.7f),
      )
    }
  }
}

/**
 * Bottom tab bar aligned to iOS HomeToolbar style:
 * - Glass-material background (translucent dark)
 * - iOS: .ultraThinMaterial, top separator line, 12dp horizontal padding
 * - Compact action buttons with rounded rect backgrounds
 */
@Composable
private fun BottomTabBar(
  activeTab: HomeTab,
  onSelect: (HomeTab) -> Unit,
) {
  val safeInsets = WindowInsets.navigationBars.only(WindowInsetsSides.Bottom + WindowInsetsSides.Horizontal)

  Column(modifier = Modifier.fillMaxWidth()) {
    // iOS: top separator line (white opacity 0.12, height 0.6)
    Box(
      modifier =
        Modifier
          .fillMaxWidth()
          .height(0.5.dp)
          .background(Color.White.copy(alpha = 0.12f)),
    )

    // iOS: .ultraThinMaterial background — approximate with dark translucent
    Surface(
      modifier = Modifier.fillMaxWidth(),
      color = Color.Black.copy(alpha = 0.60f),
    ) {
      Row(
        modifier =
          Modifier
            .fillMaxWidth()
            .windowInsetsPadding(safeInsets)
            // iOS: padding(.horizontal, 12), padding(.top, 10), padding(.bottom, 8)
            .padding(horizontal = 12.dp)
            .padding(top = 10.dp, bottom = 8.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        verticalAlignment = Alignment.CenterVertically,
      ) {
        HomeTab.entries.forEach { tab ->
          val active = tab == activeTab
          // iOS: each button is 40×40 with RoundedCornerShape(12), black.opacity(0.18)
          Surface(
            onClick = { onSelect(tab) },
            modifier = Modifier.weight(1f).heightIn(min = 52.dp),
            // iOS: RoundedCornerShape(12)
            shape = RoundedCornerShape(12.dp),
            // iOS: Color.black.opacity(brighten ? 0.12 : 0.18)
            color = if (active) Color.White.copy(alpha = 0.12f) else Color.Transparent,
            border =
              if (active) {
                BorderStroke(0.6.dp, Color.White.copy(alpha = 0.22f))
              } else {
                null
              },
            shadowElevation = 0.dp,
          ) {
            Column(
              modifier = Modifier.fillMaxWidth().padding(horizontal = 6.dp, vertical = 6.dp),
              horizontalAlignment = Alignment.CenterHorizontally,
              verticalArrangement = Arrangement.spacedBy(2.dp),
            ) {
              Icon(
                imageVector = tab.icon,
                contentDescription = tab.label,
                tint = if (active) Color.White else Color.White.copy(alpha = 0.45f),
                modifier = Modifier.size(20.dp),
              )
              Text(
                text = tab.label,
                color = if (active) Color.White else Color.White.copy(alpha = 0.45f),
                style = mobileCaption2.copy(fontWeight = if (active) FontWeight.SemiBold else FontWeight.Medium),
              )
            }
          }
        }
      }
    }
  }
}
