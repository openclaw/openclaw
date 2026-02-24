package ai.openclaw.android.ui

import android.Manifest
import android.content.pm.PackageManager
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.WindowInsetsSides
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.isImeVisible
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.only
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ScreenShare
import androidx.compose.material.icons.filled.ChatBubble
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.RecordVoiceOver
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
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
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
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
@OptIn(ExperimentalLayoutApi::class)
fun PostOnboardingTabs(viewModel: MainViewModel, modifier: Modifier = Modifier) {
  var activeTab by rememberSaveable { mutableStateOf(HomeTab.Connect) }
  val imeVisible = WindowInsets.isImeVisible

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
      if (!imeVisible) {
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
        .fillMaxWidth()
        .windowInsetsPadding(safeInsets),
  ) {
    Surface(
      modifier = Modifier.fillMaxWidth().offset(y = (-4).dp),
      color = Color.White.copy(alpha = 0.97f),
      shape = RoundedCornerShape(topStart = 24.dp, topEnd = 24.dp),
      border = BorderStroke(1.dp, mobileBorder),
      shadowElevation = 6.dp,
    ) {
      Row(
        modifier = Modifier.fillMaxWidth().padding(horizontal = 10.dp, vertical = 10.dp),
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

@Composable
private fun VoiceTabScreen(viewModel: MainViewModel) {
  val context = LocalContext.current
  val talkEnabled by viewModel.talkEnabled.collectAsState()
  val talkStatusText by viewModel.talkStatusText.collectAsState()
  val talkIsListening by viewModel.talkIsListening.collectAsState()
  val talkIsSpeaking by viewModel.talkIsSpeaking.collectAsState()
  val seamColorArgb by viewModel.seamColorArgb.collectAsState()

  val seamColor = remember(seamColorArgb) { Color(seamColorArgb) }

  val audioPermissionLauncher =
    rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
      if (granted) {
        viewModel.setTalkEnabled(true)
      }
    }

  Box(modifier = Modifier.fillMaxSize().padding(horizontal = 22.dp, vertical = 18.dp)) {
    if (talkEnabled) {
      TalkOrbOverlay(
        seamColor = seamColor,
        statusText = talkStatusText,
        isListening = talkIsListening,
        isSpeaking = talkIsSpeaking,
        modifier = Modifier.align(Alignment.Center),
      )
    } else {
      Column(
        modifier = Modifier.align(Alignment.Center),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(10.dp),
      ) {
        Text("VOICE", style = mobileCaption1.copy(fontWeight = FontWeight.Bold), color = mobileAccent)
        Text("Talk Mode", style = mobileTitle1, color = mobileText)
        Text(
          "Enable voice controls and watch live listening/speaking state.",
          style = mobileBody,
          color = mobileTextSecondary,
        )
      }
    }

    Button(
      onClick = {
        if (talkEnabled) {
          viewModel.setTalkEnabled(false)
          return@Button
        }
        val micOk =
          ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) ==
            PackageManager.PERMISSION_GRANTED
        if (micOk) {
          viewModel.setTalkEnabled(true)
        } else {
          audioPermissionLauncher.launch(Manifest.permission.RECORD_AUDIO)
        }
      },
      modifier = Modifier.align(Alignment.BottomCenter).fillMaxWidth(),
      shape = RoundedCornerShape(14.dp),
      colors =
        ButtonDefaults.buttonColors(
          containerColor = if (talkEnabled) mobileDanger else mobileAccent,
          contentColor = Color.White,
        ),
    ) {
      Text(
        if (talkEnabled) "Disable Talk Mode" else "Enable Talk Mode",
        style = mobileHeadline.copy(fontWeight = FontWeight.Bold),
      )
    }
  }
}

@Composable
private fun ScreenTabScreen(viewModel: MainViewModel) {
  val cameraFlashToken by viewModel.cameraFlashToken.collectAsState()

  Box(modifier = Modifier.fillMaxSize()) {
    CanvasScreen(viewModel = viewModel, modifier = Modifier.fillMaxSize())
    CameraFlashOverlay(token = cameraFlashToken, modifier = Modifier.fillMaxSize())
  }
}
