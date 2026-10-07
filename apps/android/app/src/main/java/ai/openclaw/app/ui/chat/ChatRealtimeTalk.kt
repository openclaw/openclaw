package ai.openclaw.app.ui.chat

import ai.openclaw.app.MainViewModel
import ai.openclaw.app.VoiceCaptureMode
import ai.openclaw.app.gatewayTalkSetupDescriptionText
import ai.openclaw.app.i18n.nativeString
import ai.openclaw.app.i18n.nativeText
import ai.openclaw.app.i18n.resolveNativeTextResource
import ai.openclaw.app.requiresSetup
import ai.openclaw.app.ui.FoldAwarePrompt
import ai.openclaw.app.ui.design.ClawTheme
import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.ui.platform.LocalContext
import androidx.core.content.ContextCompat
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner

internal enum class ChatRealtimeTalkLaunch {
  AlreadyStarted,
  RequestPermission,
  ShowSetupMessage,
  StartTalk,
}

/** Resolves the only side effect a Live Talk tap may perform. */
internal fun resolveChatRealtimeTalkLaunch(
  hasMicPermission: Boolean,
  requiresSetup: Boolean,
  talkActive: Boolean = false,
): ChatRealtimeTalkLaunch =
  when {
    talkActive -> ChatRealtimeTalkLaunch.AlreadyStarted
    !hasMicPermission -> ChatRealtimeTalkLaunch.RequestPermission
    requiresSetup -> ChatRealtimeTalkLaunch.ShowSetupMessage
    else -> ChatRealtimeTalkLaunch.StartTalk
  }

@Composable
internal fun rememberChatRealtimeTalkLauncher(viewModel: MainViewModel): (MainViewModel.AssistantTalkStartRequest?) -> Unit {
  val context = LocalContext.current
  val lifecycleOwner = LocalLifecycleOwner.current
  val talkSetupReadiness by viewModel.talkSetupReadiness.collectAsState()
  val currentTalkSetup by rememberUpdatedState(talkSetupReadiness.realtimeTalk)
  ChatTalkNotice(viewModel)
  val showSetupMessage = {
    viewModel.showTalkSetupMessage(gatewayTalkSetupDescriptionText(currentTalkSetup))
  }
  val startTalk = {
    if (currentTalkSetup.requiresSetup) {
      showSetupMessage()
    } else {
      viewModel.ensureTalkStarted()
    }
  }
  val requestMicPermission =
    rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
      // The ViewModel keeps permission ownership through rotation, but never through process death.
      val request = viewModel.takeTalkPermissionRequest()
      if (request != null && granted && lifecycleOwner.lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED)) {
        if (request.assistantRequest == null || viewModel.isAssistantTalkStartCurrent(request.assistantRequest)) {
          startTalk()
        } else {
          viewModel.showTalkSetupMessage(nativeText("Invoke the assistant again to start Talk."))
        }
      }
    }

  return launch@{ assistantRequest ->
    if (assistantRequest != null && !viewModel.isAssistantTalkStartCurrent(assistantRequest)) return@launch
    // Enabling is idempotent even while capture startup is still in flight.
    when (
      resolveChatRealtimeTalkLaunch(
        hasMicPermission = context.hasRecordAudioPermission(),
        requiresSetup = talkSetupReadiness.realtimeTalk.requiresSetup,
        talkActive = viewModel.voiceCaptureMode.value == VoiceCaptureMode.TalkMode,
      )
    ) {
      ChatRealtimeTalkLaunch.AlreadyStarted -> {
        return@launch
      }

      ChatRealtimeTalkLaunch.RequestPermission -> {
        if (viewModel.beginTalkPermissionRequest(assistantRequest)) requestMicPermission.launch(Manifest.permission.RECORD_AUDIO)
      }

      ChatRealtimeTalkLaunch.ShowSetupMessage -> {
        showSetupMessage()
      }

      ChatRealtimeTalkLaunch.StartTalk -> {
        startTalk()
      }
    }
  }
}

/** The same Talk failures remain visible when an external launch encounters onboarding. */
@Composable
internal fun ChatTalkNotice(viewModel: MainViewModel) {
  val failureNotice by viewModel.talkFailureNotice.collectAsState()
  val setupMessage by viewModel.pendingTalkSetupMessage.collectAsState()
  val shownFailure = failureNotice
  val shownSetup = setupMessage
  (shownFailure?.text ?: shownSetup?.resolveNativeTextResource())?.let { message ->
    val dismissMessage = {
      if (shownFailure != null) {
        viewModel.acknowledgeTalkModeFailure(shownFailure)
      } else if (shownSetup != null) {
        viewModel.dismissTalkSetupMessage(shownSetup)
      }
    }
    FoldAwarePrompt(
      onDismissRequest = dismissMessage,
      title = nativeString("Talk"),
      text = { Text(message, style = ClawTheme.type.body, color = ClawTheme.colors.textMuted) },
      actions = {
        TextButton(onClick = dismissMessage) { Text(nativeString("OK")) }
      },
    )
  }
}

private fun Context.hasRecordAudioPermission(): Boolean = ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED
