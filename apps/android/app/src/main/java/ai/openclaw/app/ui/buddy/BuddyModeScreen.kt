package ai.openclaw.app.ui.buddy

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.os.SystemClock
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material.icons.filled.CameraAlt
import androidx.compose.material.icons.filled.ChatBubble
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Mic
import androidx.compose.material.icons.filled.MicOff
import androidx.compose.material.icons.filled.Pets
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import ai.openclaw.app.MainViewModel
import ai.openclaw.app.buddy.BuddyAction
import ai.openclaw.app.buddy.BuddyQuickMessage
import ai.openclaw.app.buddy.BuddySnapshot
import ai.openclaw.app.buddy.BuddyStateDisplayPolicy
import ai.openclaw.app.buddy.BuddyVoiceInputPolicy
import ai.openclaw.app.buddy.NemoProfileStatus
import ai.openclaw.app.VoiceCaptureMode
import ai.openclaw.app.ui.mobileBody
import ai.openclaw.app.ui.mobileCallout
import kotlinx.coroutines.delay

@Composable
fun BuddyModeScreen(viewModel: MainViewModel, modifier: Modifier = Modifier) {
  val context = LocalContext.current
  val lifecycleOwner = LocalLifecycleOwner.current
  val snapshot by viewModel.buddySnapshot.collectAsState()
  val visibleSnapshot = rememberVisibleBuddySnapshot(snapshot)
  val cameraConfirmation by viewModel.buddyCameraConfirmation.collectAsState()
  val nemoProfileStatus by viewModel.nemoProfileStatus.collectAsState()
  val isConnected by viewModel.isConnected.collectAsState()
  val voiceCaptureMode by viewModel.voiceCaptureMode.collectAsState()
  val quickInputAvailable =
    isConnected && (nemoProfileStatus == NemoProfileStatus.Ready || nemoProfileStatus == NemoProfileStatus.Unknown)
  var showQuickInput by remember { mutableStateOf(false) }
  var hasMicPermission by remember { mutableStateOf(context.hasRecordAudioPermission()) }
  DisposableEffect(lifecycleOwner, context) {
    val observer =
      LifecycleEventObserver { _, event ->
        if (event == Lifecycle.Event.ON_RESUME) {
          hasMicPermission = context.hasRecordAudioPermission()
        }
      }
    lifecycleOwner.lifecycle.addObserver(observer)
    onDispose {
      lifecycleOwner.lifecycle.removeObserver(observer)
    }
  }

  val requestMicPermission =
    rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
      hasMicPermission = granted
      if (granted) {
        viewModel.toggleBuddyVoiceInput()
      }
    }

  Box(
    modifier =
      modifier
        .fillMaxSize()
        .background(Color(0xFF030507)),
  ) {
    NemoFace(state = visibleSnapshot.state, modifier = Modifier.fillMaxSize())
    BuddyTouchLayer(
      onAction = { action ->
        if (action == BuddyAction.Play && quickInputAvailable) {
          showQuickInput = true
        } else {
          viewModel.handleBuddyAction(action)
        }
      },
      modifier = Modifier.fillMaxSize(),
    )
    BuddyOverlay(
      snapshot = visibleSnapshot,
      showConfirmationActions = cameraConfirmation != null,
      onConfirm = { viewModel.respondBuddyCameraConfirmation(true) },
      onCancel = { viewModel.respondBuddyCameraConfirmation(false) },
      modifier =
        Modifier
          .align(Alignment.BottomCenter)
          .padding(bottom = 28.dp, start = 24.dp, end = 24.dp),
    )
    NemoProfileSetupPanel(
      status = nemoProfileStatus,
      onSetup = viewModel::requestNemoProfileSetup,
      modifier =
        Modifier
          .align(Alignment.Center)
          .padding(horizontal = 28.dp),
    )
    NemoActionRail(
      voiceActive = voiceCaptureMode != VoiceCaptureMode.Off,
      chatEnabled = quickInputAvailable,
      onChat = { showQuickInput = true },
      onVoice = {
        if (BuddyVoiceInputPolicy.shouldRequestPermission(voiceCaptureMode, hasMicPermission)) {
          requestMicPermission.launch(Manifest.permission.RECORD_AUDIO)
        } else {
          viewModel.toggleBuddyVoiceInput()
        }
      },
      onCamera = { viewModel.handleBuddyAction(BuddyAction.StartVisionScan) },
      modifier =
        Modifier
          .align(Alignment.CenterEnd)
          .padding(end = 28.dp),
    )
    if (showQuickInput && quickInputAvailable) {
      NemoQuickInputPanel(
        onSend = viewModel::sendBuddyMessage,
        onDismiss = { showQuickInput = false },
        modifier =
          Modifier
            .align(Alignment.BottomCenter)
            .padding(start = 28.dp, end = 28.dp, bottom = 112.dp),
      )
    }
  }
}

@Composable
private fun NemoActionRail(
  voiceActive: Boolean,
  chatEnabled: Boolean,
  onChat: () -> Unit,
  onVoice: () -> Unit,
  onCamera: () -> Unit,
  modifier: Modifier = Modifier,
) {
  Column(
    modifier = modifier,
    verticalArrangement = Arrangement.spacedBy(14.dp),
    horizontalAlignment = Alignment.CenterHorizontally,
  ) {
    NemoActionButton(
      onClick = onChat,
      enabled = chatEnabled,
      contentDescription = "Open Nemo chat",
    ) {
      Icon(Icons.Default.ChatBubble, contentDescription = null)
    }
    NemoActionButton(
      onClick = onVoice,
      active = voiceActive,
      contentDescription = if (voiceActive) "Stop Nemo voice" else "Start Nemo voice",
    ) {
      Icon(if (voiceActive) Icons.Default.MicOff else Icons.Default.Mic, contentDescription = null)
    }
    NemoActionButton(
      onClick = onCamera,
      contentDescription = "Ask Nemo to look",
    ) {
      Icon(Icons.Default.CameraAlt, contentDescription = null)
    }
  }
}

@Composable
private fun NemoActionButton(
  onClick: () -> Unit,
  modifier: Modifier = Modifier,
  enabled: Boolean = true,
  active: Boolean = false,
  contentDescription: String,
  content: @Composable () -> Unit,
) {
  IconButton(
    onClick = onClick,
    enabled = enabled,
    modifier =
      modifier
        .size(56.dp)
        .semantics { this.contentDescription = contentDescription }
        .background(
          color =
            when {
              !enabled -> Color(0x660C1115)
              active -> Color(0xFFE9FFFF)
              else -> Color(0xCC0C1115)
            },
          shape = RoundedCornerShape(28.dp),
        ),
  ) {
    Box(modifier = Modifier.size(24.dp), contentAlignment = Alignment.Center) {
      androidx.compose.runtime.CompositionLocalProvider(
        androidx.compose.material3.LocalContentColor provides
          when {
            !enabled -> Color(0x668EA0AA)
            active -> Color(0xFF061016)
            else -> Color(0xFFE9FFFF)
          },
      ) {
        Box(modifier = Modifier, contentAlignment = Alignment.Center) {
          content()
        }
      }
    }
  }
}

@Composable
private fun rememberVisibleBuddySnapshot(snapshot: BuddySnapshot): BuddySnapshot {
  val visible = androidx.compose.runtime.remember { mutableStateOf(snapshot) }
  val visibleSinceMs = androidx.compose.runtime.remember { mutableLongStateOf(SystemClock.elapsedRealtime()) }

  LaunchedEffect(snapshot) {
    val now = SystemClock.elapsedRealtime()
    val current = visible.value
    if (BuddyStateDisplayPolicy.shouldHoldBeforeLeaving(current.state, snapshot.state)) {
      val elapsed = now - visibleSinceMs.longValue
      val remaining = BuddyStateDisplayPolicy.minVisibleMs(current.state) - elapsed
      if (remaining > 0L) {
        delay(remaining)
      }
    }
    visible.value = snapshot
    visibleSinceMs.longValue = SystemClock.elapsedRealtime()
  }

  return visible.value
}

@Composable
private fun NemoProfileSetupPanel(
  status: NemoProfileStatus,
  onSetup: () -> Unit,
  modifier: Modifier = Modifier,
) {
  val copy =
    when (status) {
      NemoProfileStatus.Missing ->
        ProfileSetupCopy(
          title = "激活你的 Nemo",
          detail = "让 Nemo 变成一只会记得你、能陪你聊天的数字宠物。",
          action = "激活 Nemo",
          actionEnabled = true,
        )
      NemoProfileStatus.Initializing ->
        ProfileSetupCopy(
          title = "正在唤醒 Nemo",
          detail = "我正在为 Nemo 准备专属记忆和陪伴性格，很快就能开始互动。",
          action = null,
          actionEnabled = false,
        )
      NemoProfileStatus.NeedsRestart ->
        ProfileSetupCopy(
          title = "Nemo 快准备好了",
          detail = "重启 OpenClaw 后，Nemo 就能带着自己的记忆醒来。",
          action = null,
          actionEnabled = false,
        )
      NemoProfileStatus.Failed ->
        ProfileSetupCopy(
          title = "Nemo 暂时没醒来",
          detail = "请确认手机已经连上 OpenClaw，然后再试一次。",
          action = "再试一次",
          actionEnabled = true,
        )
      else -> return
    }

  Column(
    modifier =
      modifier
        .background(Color(0xDD0C1115), RoundedCornerShape(8.dp))
        .padding(horizontal = 18.dp, vertical = 14.dp),
  ) {
    Text(
      text = copy.title,
      color = Color(0xFFF4FBFF),
      style = mobileCallout.copy(fontWeight = FontWeight.SemiBold),
    )
    Text(
      text = copy.detail,
      color = Color(0xFFC6D4DC),
      style = mobileBody,
      modifier = Modifier.padding(top = 6.dp),
    )
    if (status == NemoProfileStatus.Initializing) {
      Row(
        modifier = Modifier.padding(top = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(10.dp),
      ) {
        CircularProgressIndicator(
          modifier = Modifier.size(18.dp),
          color = Color(0xFFE9FFFF),
          strokeWidth = 2.dp,
        )
        Text(
          text = "正在准备 Nemo 的小窝",
          color = Color(0xFFE9FFFF),
          style = mobileBody.copy(fontWeight = FontWeight.SemiBold),
        )
      }
    }
    if (copy.action != null) {
      Button(
        onClick = onSetup,
        enabled = copy.actionEnabled,
        colors =
          ButtonDefaults.buttonColors(
            containerColor = Color(0xFFE9FFFF),
            contentColor = Color(0xFF061016),
          ),
        modifier = Modifier.padding(top = 12.dp),
      ) {
        Icon(Icons.Default.Pets, contentDescription = null, modifier = Modifier.size(16.dp))
        Text(copy.action, modifier = Modifier.padding(start = 8.dp))
      }
    }
  }
}

private data class ProfileSetupCopy(
  val title: String,
  val detail: String,
  val action: String?,
  val actionEnabled: Boolean,
)

@Composable
private fun NemoQuickInputPanel(
  onSend: (String) -> Unit,
  onDismiss: () -> Unit,
  modifier: Modifier = Modifier,
) {
  var input by remember { mutableStateOf("") }
  val focusRequester = remember { FocusRequester() }
  val keyboard = LocalSoftwareKeyboardController.current

  fun submit() {
    val message = BuddyQuickMessage.normalize(input) ?: return
    onSend(message)
    input = ""
    keyboard?.hide()
    onDismiss()
  }

  LaunchedEffect(Unit) {
    focusRequester.requestFocus()
    keyboard?.show()
  }

  Surface(
    modifier = modifier.widthIn(max = 760.dp),
    shape = RoundedCornerShape(8.dp),
    color = Color(0xEE0C1115),
    tonalElevation = 0.dp,
    shadowElevation = 8.dp,
  ) {
    Row(
      modifier = Modifier.fillMaxWidth().padding(start = 14.dp, top = 10.dp, end = 8.dp, bottom = 10.dp),
      verticalAlignment = Alignment.CenterVertically,
      horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
      OutlinedTextField(
        value = input,
        onValueChange = { input = it.take(BuddyQuickMessage.MAX_LENGTH) },
        modifier = Modifier.weight(1f).focusRequester(focusRequester),
        textStyle = mobileBody.copy(color = Color(0xFFF4FBFF)),
        placeholder = { Text("和 Nemo 说点什么", color = Color(0xFF9AA8B0), style = mobileBody) },
        singleLine = true,
        shape = RoundedCornerShape(8.dp),
        keyboardOptions = KeyboardOptions(imeAction = ImeAction.Send),
        keyboardActions = KeyboardActions(onSend = { submit() }),
        colors =
          OutlinedTextFieldDefaults.colors(
            focusedTextColor = Color(0xFFF4FBFF),
            unfocusedTextColor = Color(0xFFF4FBFF),
            focusedBorderColor = Color(0xFFE9FFFF),
            unfocusedBorderColor = Color(0x668EA0AA),
            cursorColor = Color(0xFFE9FFFF),
            focusedContainerColor = Color(0xAA061016),
            unfocusedContainerColor = Color(0xAA061016),
          ),
      )
      IconButton(onClick = ::submit, enabled = BuddyQuickMessage.normalize(input) != null) {
        Icon(
          imageVector = Icons.AutoMirrored.Filled.Send,
          contentDescription = "Send to Nemo",
          tint = if (BuddyQuickMessage.normalize(input) != null) Color(0xFFE9FFFF) else Color(0x668EA0AA),
        )
      }
      IconButton(onClick = onDismiss) {
        Icon(
          imageVector = Icons.Default.Close,
          contentDescription = "Close quick chat",
          tint = Color(0xFFC6D4DC),
        )
      }
    }
  }
}

private fun Context.hasRecordAudioPermission(): Boolean {
  return (
    ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO) ==
      PackageManager.PERMISSION_GRANTED
    )
}
