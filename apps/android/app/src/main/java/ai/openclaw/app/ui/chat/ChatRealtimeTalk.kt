package ai.openclaw.app.ui.chat

import ai.openclaw.app.MainViewModel
import ai.openclaw.app.gatewayTalkSetupDescription
import ai.openclaw.app.i18n.nativeString
import ai.openclaw.app.requiresSetup
import ai.openclaw.app.ui.TalkSessionScreen
import ai.openclaw.app.ui.design.ClawPrimaryButton
import ai.openclaw.app.ui.design.ClawSecondaryButton
import ai.openclaw.app.ui.design.ClawTheme
import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat

internal enum class ChatRealtimeTalkLaunch {
  RequestPermission,
  ShowSetupInline,
  StartTalk,
}

/** Resolves the only side effect a Live Talk tap may perform. */
internal fun resolveChatRealtimeTalkLaunch(
  hasMicPermission: Boolean,
  requiresSetup: Boolean,
): ChatRealtimeTalkLaunch =
  when {
    !hasMicPermission -> ChatRealtimeTalkLaunch.RequestPermission
    requiresSetup -> ChatRealtimeTalkLaunch.ShowSetupInline
    else -> ChatRealtimeTalkLaunch.StartTalk
  }

@Composable
internal fun rememberChatRealtimeTalkLauncher(
  viewModel: MainViewModel,
  onSetupRequired: () -> Unit,
): () -> Unit {
  val context = LocalContext.current
  val talkSetupReadiness by viewModel.talkSetupReadiness.collectAsState()
  val currentTalkRequiresSetup by rememberUpdatedState(talkSetupReadiness.realtimeTalk.requiresSetup)
  val requestMicPermission =
    rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
      if (!granted) return@rememberLauncherForActivityResult
      if (currentTalkRequiresSetup) {
        onSetupRequired()
      } else {
        viewModel.setTalkModeEnabled(true)
      }
    }

  return {
    when (
      resolveChatRealtimeTalkLaunch(
        hasMicPermission = context.hasRecordAudioPermission(),
        requiresSetup = talkSetupReadiness.realtimeTalk.requiresSetup,
      )
    ) {
      ChatRealtimeTalkLaunch.RequestPermission -> requestMicPermission.launch(Manifest.permission.RECORD_AUDIO)
      ChatRealtimeTalkLaunch.ShowSetupInline -> onSetupRequired()
      ChatRealtimeTalkLaunch.StartTalk -> viewModel.setTalkModeEnabled(true)
    }
  }
}

@Composable
internal fun ChatRealtimeTalkSetupScreen(
  viewModel: MainViewModel,
  onDismiss: () -> Unit,
  onOpenVoiceSettings: () -> Unit,
) {
  val talkSetupReadiness by viewModel.talkSetupReadiness.collectAsState()

  Column(
    modifier = Modifier.fillMaxSize().padding(horizontal = 20.dp, vertical = 16.dp),
    verticalArrangement = Arrangement.Center,
    horizontalAlignment = Alignment.CenterHorizontally,
  ) {
    Text(text = nativeString("Realtime Talk"), style = ClawTheme.type.title, color = ClawTheme.colors.text)
    Text(
      text = gatewayTalkSetupDescription(talkSetupReadiness.realtimeTalk),
      modifier = Modifier.padding(top = 8.dp),
      style = ClawTheme.type.body,
      color = ClawTheme.colors.textMuted,
    )
    Row(
      modifier = Modifier.fillMaxWidth().padding(top = 16.dp),
      horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
      ClawSecondaryButton(text = nativeString("Back"), onClick = onDismiss, modifier = Modifier.weight(1f))
      ClawPrimaryButton(text = nativeString("Open Settings"), onClick = onOpenVoiceSettings, modifier = Modifier.weight(1f))
    }
  }
}

@Composable
internal fun ChatRealtimeTalkSessionScreen(
  viewModel: MainViewModel,
  onOpenVoiceSettings: () -> Unit,
  embeddedInChat: Boolean = false,
) {
  val entries by viewModel.talkModeConversation.collectAsState()
  val listening by viewModel.talkModeListening.collectAsState()
  val speaking by viewModel.talkModeSpeaking.collectAsState()
  val statusText by viewModel.talkModeStatusText.collectAsState()
  val awaitingAgent by viewModel.talkAwaitingAgent.collectAsState()
  val inputLevel by viewModel.talkInputLevel.collectAsState()
  val outputLevel by viewModel.talkOutputLevel.collectAsState()
  val speechActive by viewModel.talkSpeechActive.collectAsState()
  val speakerEnabled by viewModel.speakerEnabled.collectAsState()

  TalkSessionScreen(
    entries = entries,
    listening = listening,
    speaking = speaking,
    statusText = statusText,
    awaitingAgent = awaitingAgent,
    inputLevel = inputLevel,
    outputLevel = outputLevel,
    speechActive = speechActive,
    speakerEnabled = speakerEnabled,
    onToggleSpeaker = { viewModel.setSpeakerEnabled(!speakerEnabled) },
    onEndTalk = { viewModel.setTalkModeEnabled(false) },
    onOpenVoiceSettings = onOpenVoiceSettings,
    embeddedInChat = embeddedInChat,
  )
}

private fun Context.hasRecordAudioPermission(): Boolean = ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED
