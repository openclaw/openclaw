package ai.openclaw.app.ui

import ai.openclaw.app.MainViewModel
import ai.openclaw.app.VoiceCaptureMode
import ai.openclaw.app.ui.design.ClawIconButton
import ai.openclaw.app.ui.design.ClawListItem
import ai.openclaw.app.ui.design.ClawPanel
import ai.openclaw.app.ui.design.ClawPrimaryButton
import ai.openclaw.app.ui.design.ClawSecondaryButton
import ai.openclaw.app.ui.design.ClawStatus
import ai.openclaw.app.ui.design.ClawStatusPill
import ai.openclaw.app.ui.design.ClawTheme
import ai.openclaw.app.voice.VoiceConversationEntry
import ai.openclaw.app.voice.VoiceConversationRole
import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.VolumeOff
import androidx.compose.material.icons.automirrored.filled.VolumeUp
import androidx.compose.material.icons.filled.GraphicEq
import androidx.compose.material.icons.filled.Mic
import androidx.compose.material.icons.filled.MicOff
import androidx.compose.material.icons.filled.Phone
import androidx.compose.material.icons.filled.PhoneDisabled
import androidx.compose.material.icons.filled.RecordVoiceOver
import androidx.compose.material.icons.filled.TextFields
import androidx.compose.material3.Icon
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat

@Composable
fun V2VoiceScreen(viewModel: MainViewModel) {
  val context = LocalContext.current
  val gatewayStatus by viewModel.statusText.collectAsState()
  val voiceCaptureMode by viewModel.voiceCaptureMode.collectAsState()
  val micEnabled by viewModel.micEnabled.collectAsState()
  val micCooldown by viewModel.micCooldown.collectAsState()
  val speakerEnabled by viewModel.speakerEnabled.collectAsState()
  val micStatusText by viewModel.micStatusText.collectAsState()
  val micLiveTranscript by viewModel.micLiveTranscript.collectAsState()
  val micQueuedMessages by viewModel.micQueuedMessages.collectAsState()
  val micConversation by viewModel.micConversation.collectAsState()
  val micIsSending by viewModel.micIsSending.collectAsState()
  val talkModeEnabled by viewModel.talkModeEnabled.collectAsState()
  val talkModeListening by viewModel.talkModeListening.collectAsState()
  val talkModeSpeaking by viewModel.talkModeSpeaking.collectAsState()
  val talkModeConversation by viewModel.talkModeConversation.collectAsState()

  var pendingAction by remember { mutableStateOf<VoiceAction?>(null) }
  var hasMicPermission by remember { mutableStateOf(context.hasRecordAudioPermission()) }
  val requestMicPermission =
    rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
      hasMicPermission = granted
      if (granted) {
        when (pendingAction) {
          VoiceAction.Talk -> viewModel.setTalkModeEnabled(true)
          VoiceAction.Dictation -> viewModel.setMicEnabled(true)
          null -> Unit
        }
      }
      pendingAction = null
    }

  val activeConversation = if (voiceCaptureMode == VoiceCaptureMode.TalkMode) talkModeConversation else micConversation
  val voiceActive = micEnabled || micIsSending || talkModeEnabled
  val activeStatus =
    voiceStatusLabel(
      gatewayStatus = gatewayStatus,
      voiceCaptureMode = voiceCaptureMode,
      micStatusText = micStatusText,
      micQueuedMessages = micQueuedMessages.size,
      micIsSending = micIsSending,
      talkModeListening = talkModeListening,
      talkModeSpeaking = talkModeSpeaking,
    )

  Column(
    modifier =
      Modifier
        .fillMaxSize()
        .imePadding()
        .padding(horizontal = 20.dp, vertical = 12.dp),
    verticalArrangement = Arrangement.spacedBy(14.dp),
  ) {
    V2VoiceHeader(
      voiceActive = voiceActive,
      statusText = activeStatus,
      speakerEnabled = speakerEnabled,
      onToggleSpeaker = { viewModel.setSpeakerEnabled(!speakerEnabled) },
    )

    V2VoiceHero(
      voiceCaptureMode = voiceCaptureMode,
      micEnabled = micEnabled,
      talkModeEnabled = talkModeEnabled,
      talkModeListening = talkModeListening,
      talkModeSpeaking = talkModeSpeaking,
      micLiveTranscript = micLiveTranscript,
      onStartTalk = {
        runVoiceAction(
          action = VoiceAction.Talk,
          hasMicPermission = hasMicPermission,
          requestPermission = {
            pendingAction = VoiceAction.Talk
            requestMicPermission.launch(Manifest.permission.RECORD_AUDIO)
          },
          run = { viewModel.setTalkModeEnabled(!talkModeEnabled) },
        )
      },
      onStartDictation = {
        if (micCooldown) return@V2VoiceHero
        runVoiceAction(
          action = VoiceAction.Dictation,
          hasMicPermission = hasMicPermission,
          requestPermission = {
            pendingAction = VoiceAction.Dictation
            requestMicPermission.launch(Manifest.permission.RECORD_AUDIO)
          },
          run = { viewModel.setMicEnabled(!micEnabled) },
        )
      },
    )

    if (!hasMicPermission) {
      V2VoicePermissionPanel(
        onRequestPermission = {
          pendingAction = VoiceAction.Talk
          requestMicPermission.launch(Manifest.permission.RECORD_AUDIO)
        },
      )
    }

    V2VoiceTranscript(
      entries = activeConversation,
      showThinking = micIsSending && activeConversation.none { it.role == VoiceConversationRole.Assistant && it.isStreaming },
      modifier = Modifier.weight(1f),
    )
  }
}

@Composable
private fun V2VoiceHeader(
  voiceActive: Boolean,
  statusText: String,
  speakerEnabled: Boolean,
  onToggleSpeaker: () -> Unit,
) {
  Row(
    modifier = Modifier.fillMaxWidth(),
    verticalAlignment = Alignment.CenterVertically,
    horizontalArrangement = Arrangement.spacedBy(12.dp),
  ) {
    Column(modifier = Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
      Text(text = "Voice", style = ClawTheme.type.title, color = ClawTheme.colors.text)
      Text(
        text = statusText,
        style = ClawTheme.type.body,
        color = ClawTheme.colors.textMuted,
        maxLines = 1,
        overflow = TextOverflow.Ellipsis,
      )
    }
    ClawStatusPill(
      text = if (voiceActive) "Live" else "Ready",
      status = if (voiceActive) ClawStatus.Success else ClawStatus.Neutral,
    )
    ClawIconButton(
      icon = if (speakerEnabled) Icons.AutoMirrored.Filled.VolumeUp else Icons.AutoMirrored.Filled.VolumeOff,
      contentDescription = if (speakerEnabled) "Mute speaker" else "Unmute speaker",
      onClick = onToggleSpeaker,
    )
  }
}

@Composable
private fun V2VoiceHero(
  voiceCaptureMode: VoiceCaptureMode,
  micEnabled: Boolean,
  talkModeEnabled: Boolean,
  talkModeListening: Boolean,
  talkModeSpeaking: Boolean,
  micLiveTranscript: String?,
  onStartTalk: () -> Unit,
  onStartDictation: () -> Unit,
) {
  Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(12.dp)) {
    V2VoiceOrb(
      active = micEnabled || talkModeEnabled,
      listening = talkModeListening || voiceCaptureMode == VoiceCaptureMode.ManualMic,
      speaking = talkModeSpeaking,
    )

    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
      Box(
        modifier =
          Modifier
            .size(7.dp)
            .clip(CircleShape)
            .background(if (micEnabled || talkModeEnabled) ClawTheme.colors.success else ClawTheme.colors.textSubtle),
      )
      Text(
        text =
          when {
            talkModeSpeaking -> "OpenClaw is replying"
            talkModeListening -> "Listening"
            talkModeEnabled -> "Talk is live"
            micEnabled -> "Dictation is listening"
            else -> "Ready to talk"
          },
        style = ClawTheme.type.body,
        color = ClawTheme.colors.textMuted,
        textAlign = TextAlign.Center,
      )
    }

    if (!micLiveTranscript.isNullOrBlank()) {
      Surface(
        modifier = Modifier.fillMaxWidth(),
        shape = RoundedCornerShape(ClawTheme.radii.panel),
        color = ClawTheme.colors.surface,
        border = BorderStroke(1.dp, ClawTheme.colors.borderStrong),
      ) {
        Text(
          text = micLiveTranscript.trim(),
          modifier = Modifier.padding(horizontal = 12.dp, vertical = 9.dp),
          style = ClawTheme.type.body,
          color = ClawTheme.colors.text,
        )
      }
    }

    ClawPanel(contentPadding = PaddingValues(horizontal = 12.dp, vertical = 6.dp)) {
      V2VoiceModeRow(
        title = if (talkModeEnabled) "End Talk" else "Realtime Talk",
        subtitle = if (talkModeEnabled) "Conversation is live" else "Natural conversation in real time",
        icon = if (talkModeEnabled) Icons.Default.PhoneDisabled else Icons.Default.RecordVoiceOver,
        onClick = onStartTalk,
      )
      V2VoiceModeRow(
        title = if (micEnabled) "Stop Dictation" else "Dictation",
        subtitle = if (micEnabled) "Listening for one turn" else "Convert speech to text",
        icon = if (micEnabled) Icons.Default.MicOff else Icons.Default.TextFields,
        onClick = onStartDictation,
      )
    }

    ClawPrimaryButton(
      text = if (talkModeEnabled) "End Talk" else "Start Talk",
      icon = if (talkModeEnabled) Icons.Default.PhoneDisabled else Icons.Default.Phone,
      onClick = onStartTalk,
      modifier = Modifier.fillMaxWidth(),
    )
  }
}

@Composable
private fun V2VoiceModeRow(
  title: String,
  subtitle: String,
  icon: androidx.compose.ui.graphics.vector.ImageVector,
  onClick: () -> Unit,
) {
  ClawListItem(
    title = title,
    subtitle = subtitle,
    leading = {
      Surface(
        modifier = Modifier.size(34.dp),
        shape = CircleShape,
        color = ClawTheme.colors.surface,
        contentColor = ClawTheme.colors.text,
        border = BorderStroke(1.dp, ClawTheme.colors.border),
      ) {
        Box(contentAlignment = Alignment.Center) {
          Icon(imageVector = icon, contentDescription = null, modifier = Modifier.size(18.dp))
        }
      }
    },
    onClick = onClick,
  )
}

@Composable
private fun V2VoiceOrb(
  active: Boolean,
  listening: Boolean,
  speaking: Boolean,
) {
  Surface(
    modifier = Modifier.size(136.dp),
    shape = CircleShape,
    color = if (active) ClawTheme.colors.surfacePressed else ClawTheme.colors.surface,
    border = BorderStroke(1.dp, if (active) ClawTheme.colors.borderStrong else ClawTheme.colors.border),
  ) {
    Box(contentAlignment = Alignment.Center) {
      Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Icon(
          imageVector =
            when {
              speaking -> Icons.Default.RecordVoiceOver
              listening -> Icons.Default.GraphicEq
              else -> Icons.Default.Mic
            },
          contentDescription = null,
          modifier = Modifier.size(42.dp),
          tint = ClawTheme.colors.text,
        )
        V2Waveform(active = active)
      }
    }
  }
}

@Composable
private fun V2Waveform(active: Boolean) {
  Row(horizontalArrangement = Arrangement.spacedBy(4.dp), verticalAlignment = Alignment.CenterVertically) {
    listOf(8, 14, 22, 30, 18, 12, 26, 18, 9).forEachIndexed { index, height ->
      Box(
        modifier =
          Modifier
            .size(width = 3.dp, height = (if (active) height else 8 + index % 3 * 3).dp)
            .clip(RoundedCornerShape(999.dp))
            .background(if (active) ClawTheme.colors.text else ClawTheme.colors.textSubtle),
      )
    }
  }
}

@Composable
private fun V2VoiceTranscript(
  entries: List<VoiceConversationEntry>,
  showThinking: Boolean,
  modifier: Modifier = Modifier,
) {
  val listState = rememberLazyListState()
  LaunchedEffect(entries.size, showThinking) {
    if (entries.isNotEmpty() || showThinking) {
      listState.animateScrollToItem(0)
    }
  }

  LazyColumn(
    modifier = modifier.fillMaxWidth(),
    state = listState,
    reverseLayout = true,
    verticalArrangement = Arrangement.spacedBy(10.dp),
    contentPadding = PaddingValues(bottom = 8.dp),
  ) {
    if (showThinking) {
      item(key = "thinking") {
        V2VoiceThinkingCard()
      }
    }

    items(entries.asReversed(), key = { it.id }) { entry ->
      V2VoiceTurnCard(entry = entry)
    }

    if (entries.isEmpty() && !showThinking) {
      item {
        Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
          Text(text = "Live transcript", style = ClawTheme.type.caption, color = ClawTheme.colors.textSubtle)
          ClawPanel {
            Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
              Text(text = "No transcript yet", style = ClawTheme.type.section, color = ClawTheme.colors.text)
              Text(
                text = "Your words and OpenClaw replies will appear here.",
                style = ClawTheme.type.body,
                color = ClawTheme.colors.textMuted,
              )
            }
          }
        }
      }
    }
  }
}

@Composable
private fun V2VoiceTurnCard(entry: VoiceConversationEntry) {
  val isUser = entry.role == VoiceConversationRole.User
  Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = if (isUser) Arrangement.End else Arrangement.Start) {
    Surface(
      modifier = Modifier.fillMaxWidth(if (isUser) 0.88f else 0.94f),
      shape = RoundedCornerShape(20.dp),
      color = if (isUser) ClawTheme.colors.primary else ClawTheme.colors.surfaceRaised,
      contentColor = if (isUser) ClawTheme.colors.primaryText else ClawTheme.colors.text,
      border = BorderStroke(1.dp, if (entry.isStreaming) ClawTheme.colors.borderStrong else ClawTheme.colors.border),
    ) {
      Column(modifier = Modifier.padding(horizontal = 14.dp, vertical = 12.dp), verticalArrangement = Arrangement.spacedBy(7.dp)) {
        Text(
          text = if (isUser) "You" else "OpenClaw",
          style = ClawTheme.type.caption.copy(fontWeight = FontWeight.SemiBold),
          color = if (isUser) ClawTheme.colors.primaryText.copy(alpha = 0.72f) else ClawTheme.colors.textSubtle,
        )
        Text(
          text = if (entry.isStreaming && entry.text.isBlank()) "Listening..." else entry.text,
          style = ClawTheme.type.body,
          color = if (isUser) ClawTheme.colors.primaryText else ClawTheme.colors.text,
        )
      }
    }
  }
}

@Composable
private fun V2VoiceThinkingCard() {
  ClawPanel {
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
      ClawStatusPill(text = "Sending", status = ClawStatus.Warning)
      Text(text = "OpenClaw is preparing a response.", style = ClawTheme.type.body, color = ClawTheme.colors.textMuted)
    }
  }
}

@Composable
private fun V2VoicePermissionPanel(onRequestPermission: () -> Unit) {
  ClawPanel {
    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
      ClawStatusPill(text = "Permission needed", status = ClawStatus.Warning)
      Text(text = "Microphone access is needed for Talk and Dictation.", style = ClawTheme.type.section, color = ClawTheme.colors.text)
      Text(
        text = "OpenClaw only listens when you start a voice mode.",
        style = ClawTheme.type.body,
        color = ClawTheme.colors.textMuted,
      )
      ClawSecondaryButton(text = "Enable Microphone", icon = Icons.Default.Mic, onClick = onRequestPermission)
    }
  }
}

private enum class VoiceAction {
  Talk,
  Dictation,
}

private fun runVoiceAction(
  action: VoiceAction,
  hasMicPermission: Boolean,
  requestPermission: () -> Unit,
  run: () -> Unit,
) {
  if (hasMicPermission) {
    run()
  } else {
    requestPermission()
  }
}

private fun voiceStatusLabel(
  gatewayStatus: String,
  voiceCaptureMode: VoiceCaptureMode,
  micStatusText: String,
  micQueuedMessages: Int,
  micIsSending: Boolean,
  talkModeListening: Boolean,
  talkModeSpeaking: Boolean,
): String =
  when {
    voiceCaptureMode == VoiceCaptureMode.TalkMode && talkModeSpeaking -> "OpenClaw is speaking"
    voiceCaptureMode == VoiceCaptureMode.TalkMode && talkModeListening -> "Listening"
    voiceCaptureMode == VoiceCaptureMode.TalkMode -> "Talk is live"
    micIsSending -> "Sending dictation"
    voiceCaptureMode == VoiceCaptureMode.ManualMic -> micStatusText.ifBlank { "Listening" }
    micQueuedMessages > 0 -> "$micQueuedMessages queued"
    gatewayStatus.lowercase().contains("offline") -> "Gateway offline"
    else -> "Ready to talk"
  }

private fun Context.hasRecordAudioPermission(): Boolean = ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED
