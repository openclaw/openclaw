package ai.openclaw.app.ui.chat

import ai.openclaw.app.MainViewModel
import ai.openclaw.app.gatewayTalkSetupDescription
import ai.openclaw.app.i18n.nativeString
import ai.openclaw.app.requiresSetup
import ai.openclaw.app.voice.TalkModeManager
import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.widget.Toast
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.platform.LocalContext
import androidx.core.content.ContextCompat

internal enum class ChatRealtimeTalkLaunch {
  RequestPermission,
  ShowSetupMessage,
  StartTalk,
}

/** Resolves the only side effect a Live Talk tap may perform. */
internal fun resolveChatRealtimeTalkLaunch(
  hasMicPermission: Boolean,
  requiresSetup: Boolean,
): ChatRealtimeTalkLaunch =
  when {
    !hasMicPermission -> ChatRealtimeTalkLaunch.RequestPermission
    requiresSetup -> ChatRealtimeTalkLaunch.ShowSetupMessage
    else -> ChatRealtimeTalkLaunch.StartTalk
  }

@Composable
internal fun rememberChatRealtimeTalkLauncher(viewModel: MainViewModel): () -> Unit {
  val context = LocalContext.current
  val talkSetupReadiness by viewModel.talkSetupReadiness.collectAsState()
  val currentTalkSetup by rememberUpdatedState(talkSetupReadiness.realtimeTalk)
  val showSetupMessage = {
    Toast
      .makeText(context, gatewayTalkSetupDescription(currentTalkSetup), Toast.LENGTH_LONG)
      .show()
  }
  var pendingStart by remember(viewModel) { mutableStateOf<TalkModeManager.ChatStart?>(null) }
  DisposableEffect(viewModel) { onDispose { pendingStart?.retire() } }
  val requestMicPermission =
    rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
      val start = pendingStart ?: return@rememberLauncherForActivityResult
      pendingStart = null
      if (!granted || !start.canStart()) {
        start.retire()
        return@rememberLauncherForActivityResult
      }
      if (currentTalkSetup.requiresSetup) {
        start.retire()
        showSetupMessage()
      } else {
        viewModel.startChatTalk(start)
      }
    }

  return launch@{
    // Do not relabel an outstanding permission result with a later gesture.
    if (pendingStart != null) return@launch
    val launch =
      resolveChatRealtimeTalkLaunch(
        hasMicPermission = context.hasRecordAudioPermission(),
        requiresSetup = talkSetupReadiness.realtimeTalk.requiresSetup,
      )
    if (launch == ChatRealtimeTalkLaunch.ShowSetupMessage) {
      showSetupMessage()
      return@launch
    }
    val start =
      viewModel.captureChatTalkStart() ?: run {
        if (currentTalkSetup.requiresSetup) {
          showSetupMessage()
        } else {
          Toast.makeText(context, nativeString("Talk is unavailable for this conversation. Reopen the chat and try again."), Toast.LENGTH_LONG).show()
        }
        return@launch
      }
    when (launch) {
      ChatRealtimeTalkLaunch.RequestPermission -> {
        pendingStart = start
        requestMicPermission.launch(Manifest.permission.RECORD_AUDIO)
      }

      ChatRealtimeTalkLaunch.ShowSetupMessage -> {
        start.retire()
        showSetupMessage()
      }

      ChatRealtimeTalkLaunch.StartTalk -> {
        viewModel.startChatTalk(start)
      }
    }
  }
}

private fun Context.hasRecordAudioPermission(): Boolean = ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED
