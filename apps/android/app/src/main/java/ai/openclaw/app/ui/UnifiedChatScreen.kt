package ai.openclaw.app.ui

import ai.openclaw.app.MainViewModel
import ai.openclaw.app.ui.chat.ChatRealtimeTalkSessionScreen
import ai.openclaw.app.ui.chat.ChatRealtimeTalkSetupScreen
import ai.openclaw.app.ui.chat.ChatScreen
import ai.openclaw.app.ui.chat.rememberChatRealtimeTalkLauncher
import ai.openclaw.app.ui.design.ClawScaffold
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.WindowInsetsSides
import androidx.compose.foundation.layout.only
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.unit.dp

@Composable
internal fun UnifiedChatShellScreen(
  viewModel: MainViewModel,
  onOpenVoiceSettings: () -> Unit,
  onOpenSessions: () -> Unit,
  onOpenGatewaySettings: () -> Unit,
) {
  val talkModeEnabled by viewModel.talkModeEnabled.collectAsState()
  var showTalkSetupInChat by rememberSaveable { mutableStateOf(false) }
  val onStartTalk =
    rememberChatRealtimeTalkLauncher(
      viewModel = viewModel,
      onSetupRequired = { showTalkSetupInChat = true },
    )
  LaunchedEffect(viewModel) { viewModel.refreshTalkSetupReadiness() }
  LaunchedEffect(talkModeEnabled) {
    if (talkModeEnabled) showTalkSetupInChat = false
  }

  ClawScaffold(
    contentPadding = PaddingValues(start = 0.dp, top = 8.dp, end = 0.dp, bottom = 0.dp),
    contentWindowInsets = WindowInsets.safeDrawing.only(WindowInsetsSides.Top + WindowInsetsSides.Horizontal),
  ) {
    ChatScreen(
      viewModel = viewModel,
      onStartTalk = onStartTalk,
      realtimeTalkContent =
        when {
          talkModeEnabled -> {
            {
              ChatRealtimeTalkSessionScreen(
                viewModel = viewModel,
                onOpenVoiceSettings = onOpenVoiceSettings,
                embeddedInChat = true,
              )
            }
          }
          showTalkSetupInChat -> {
            {
              ChatRealtimeTalkSetupScreen(
                viewModel = viewModel,
                onDismiss = { showTalkSetupInChat = false },
                onOpenVoiceSettings = {
                  showTalkSetupInChat = false
                  onOpenVoiceSettings()
                },
              )
            }
          }
          else -> null
        },
      onOpenSessions = onOpenSessions,
      onOpenGatewaySettings = onOpenGatewaySettings,
    )
  }
}
