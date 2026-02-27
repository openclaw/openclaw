package ai.openclaw.android.ui

import android.Manifest
import android.app.Activity
import android.content.Context
import android.content.ContextWrapper
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.provider.Settings
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.core.LinearEasing
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
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.WindowInsetsSides
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.only
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Mic
import androidx.compose.material.icons.filled.MicOff
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import ai.openclaw.android.MainViewModel
import ai.openclaw.android.voice.VoiceConversationEntry
import ai.openclaw.android.voice.VoiceConversationRole
import kotlin.math.PI
import kotlin.math.max
import kotlin.math.sin

@Composable
fun VoiceTabScreen(viewModel: MainViewModel) {
  val context = LocalContext.current
  val lifecycleOwner = LocalLifecycleOwner.current
  val activity = remember(context) { context.findActivity() }
  val listState = rememberLazyListState()

  val isConnected by viewModel.isConnected.collectAsState()
  val gatewayStatus by viewModel.statusText.collectAsState()
  val micEnabled by viewModel.micEnabled.collectAsState()
  val micStatusText by viewModel.micStatusText.collectAsState()
  val micLiveTranscript by viewModel.micLiveTranscript.collectAsState()
  val micQueuedMessages by viewModel.micQueuedMessages.collectAsState()
  val micConversation by viewModel.micConversation.collectAsState()
  val micInputLevel by viewModel.micInputLevel.collectAsState()
  val micIsSending by viewModel.micIsSending.collectAsState()

  val hasStreamingAssistant = micConversation.any { it.role == VoiceConversationRole.Assistant && it.isStreaming }
  val showThinkingBubble = micIsSending && !hasStreamingAssistant

  var hasMicPermission by remember { mutableStateOf(context.hasRecordAudioPermission()) }
  var pendingMicEnable by remember { mutableStateOf(false) }

  DisposableEffect(lifecycleOwner, context) {
    val observer =
      LifecycleEventObserver { _, event ->
        if (event == Lifecycle.Event.ON_RESUME) {
          hasMicPermission = context.hasRecordAudioPermission()
        }
      }
    lifecycleOwner.lifecycle.addObserver(observer)
    onDispose { lifecycleOwner.lifecycle.removeObserver(observer) }
  }

  val requestMicPermission =
    rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
      hasMicPermission = granted
      if (granted && pendingMicEnable) {
        viewModel.setMicEnabled(true)
      }
      pendingMicEnable = false
    }

  LaunchedEffect(micConversation.size, showThinkingBubble) {
    val total = micConversation.size + if (showThinkingBubble) 1 else 0
    if (total > 0) {
      listState.animateScrollToItem(total - 1)
    }
  }

  Column(
    modifier =
      Modifier
        .fillMaxSize()
        .background(mobileBackgroundGradient)
        .imePadding()
        .windowInsetsPadding(WindowInsets.safeDrawing.only(WindowInsetsSides.Bottom))
        .padding(horizontal = 20.dp, vertical = 14.dp),
    verticalArrangement = Arrangement.spacedBy(10.dp),
  ) {
    Row(
      modifier = Modifier.fillMaxWidth(),
      horizontalArrangement = Arrangement.SpaceBetween,
      verticalAlignment = Alignment.CenterVertically,
    ) {
      Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Text(
          "VOICE",
          style = mobileCaption1.copy(fontWeight = FontWeight.Bold, letterSpacing = 1.sp),
          color = mobileAccent,
        )
        Text("Voice mode", style = mobileTitle2, color = mobileText)
      }
      Surface(
        shape = RoundedCornerShape(999.dp),
        color = if (isConnected) mobileAccentSoft else mobileSurfaceStrong,
        border = BorderStroke(1.dp, if (isConnected) mobileAccent.copy(alpha = 0.25f) else mobileBorderStrong),
      ) {
        Text(
          if (isConnected) "Connected" else "Offline",
          modifier = Modifier.padding(horizontal = 12.dp, vertical = 6.dp),
          style = mobileCaption1,
          color = if (isConnected) mobileAccent else mobileTextSecondary,
        )
      }
    }

    LazyColumn(
      state = listState,
      modifier = Modifier.fillMaxWidth().weight(1f),
      contentPadding = PaddingValues(vertical = 4.dp),
      verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
      if (micConversation.isEmpty() && !showThinkingBubble) {
        item {
          Column(
            modifier = Modifier.fillMaxWidth().padding(top = 12.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
          ) {
            Text(
              "Tap the mic and speak. Each pause sends a turn automatically.",
              style = mobileCallout,
              color = mobileTextSecondary,
            )
          }
        }
      }

      items(items = micConversation, key = { it.id }) { entry ->
        VoiceTurnBubble(entry = entry)
      }

      if (showThinkingBubble) {
        item {
          VoiceThinkingBubble()
        }
      }
    }

    Surface(
      modifier = Modifier.fillMaxWidth(),
      shape = RoundedCornerShape(20.dp),
      color = Color.White,
      border = BorderStroke(1.dp, mobileBorder),
    ) {
      Column(
        modifier = Modifier.fillMaxWidth().padding(horizontal = 14.dp, vertical = 12.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(8.dp),
      ) {
        Surface(
          shape = RoundedCornerShape(999.dp),
          color = mobileSurface,
          border = BorderStroke(1.dp, mobileBorder),
        ) {
          val queueCount = micQueuedMessages.size
          val stateText =
            when {
              queueCount > 0 -> "$queueCount queued"
              micIsSending -> "Sending"
              micEnabled -> "Listening"
              else -> "Mic off"
            }
          Text(
            "$gatewayStatus · $stateText",
            modifier = Modifier.padding(horizontal = 12.dp, vertical = 7.dp),
            style = mobileCaption1,
            color = mobileTextSecondary,
          )
        }

        if (!micLiveTranscript.isNullOrBlank()) {
          Surface(
            modifier = Modifier.fillMaxWidth(),
            shape = RoundedCornerShape(14.dp),
            color = mobileAccentSoft,
            border = BorderStroke(1.dp, mobileAccent.copy(alpha = 0.2f)),
          ) {
            Text(
              micLiveTranscript!!.trim(),
              modifier = Modifier.padding(horizontal = 12.dp, vertical = 10.dp),
              style = mobileCallout,
              color = mobileText,
            )
          }
        }

        MicWaveform(level = micInputLevel, active = micEnabled)

        Button(
          onClick = {
            if (micEnabled) {
              viewModel.setMicEnabled(false)
              return@Button
            }
            if (hasMicPermission) {
              viewModel.setMicEnabled(true)
            } else {
              pendingMicEnable = true
              requestMicPermission.launch(Manifest.permission.RECORD_AUDIO)
            }
          },
          shape = CircleShape,
          contentPadding = PaddingValues(0.dp),
          modifier = Modifier.size(86.dp),
          colors =
            ButtonDefaults.buttonColors(
              containerColor = if (micEnabled) mobileDanger else mobileAccent,
              contentColor = Color.White,
            ),
        ) {
          Icon(
            imageVector = if (micEnabled) Icons.Default.MicOff else Icons.Default.Mic,
            contentDescription = if (micEnabled) "Turn microphone off" else "Turn microphone on",
            modifier = Modifier.size(30.dp),
          )
        }

        Text(
          if (micEnabled) "Tap to stop" else "Tap to speak",
          style = mobileCallout,
          color = mobileTextSecondary,
        )

        if (!hasMicPermission) {
          val showRationale =
            if (activity == null) {
              false
            } else {
              ActivityCompat.shouldShowRequestPermissionRationale(activity, Manifest.permission.RECORD_AUDIO)
            }
          Text(
            if (showRationale) {
              "Microphone permission is required for voice mode."
            } else {
              "Microphone blocked. Open app settings to enable it."
            },
            style = mobileCaption1,
            color = mobileWarning,
            textAlign = TextAlign.Center,
          )
          Button(
            onClick = { openAppSettings(context) },
            shape = RoundedCornerShape(12.dp),
            colors = ButtonDefaults.buttonColors(containerColor = mobileSurfaceStrong, contentColor = mobileText),
          ) {
            Text("Open settings", style = mobileCallout.copy(fontWeight = FontWeight.SemiBold))
          }
        }

        Text(
          micStatusText,
          style = mobileCaption1,
          color = mobileTextTertiary,
        )
      }
    }
  }
}

@Composable
private fun VoiceTurnBubble(entry: VoiceConversationEntry) {
  val isUser = entry.role == VoiceConversationRole.User
  Row(
    modifier = Modifier.fillMaxWidth(),
    horizontalArrangement = if (isUser) Arrangement.End else Arrangement.Start,
  ) {
    Surface(
      modifier = Modifier.fillMaxWidth(0.90f),
      shape = RoundedCornerShape(14.dp),
      color = if (isUser) mobileAccentSoft else mobileSurface,
      border = BorderStroke(1.dp, if (isUser) mobileAccent.copy(alpha = 0.2f) else mobileBorder),
    ) {
      Column(
        modifier = Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 10.dp),
        verticalArrangement = Arrangement.spacedBy(6.dp),
      ) {
        Text(
          if (isUser) "You" else "OpenClaw",
          style = mobileCaption1.copy(fontWeight = FontWeight.SemiBold),
          color = mobileTextSecondary,
        )
        Text(
          if (entry.isStreaming && entry.text.isBlank()) "Listening response…" else entry.text,
          style = mobileCallout,
          color = mobileText,
        )
      }
    }
  }
}

@Composable
private fun VoiceThinkingBubble() {
  Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.Start) {
    Surface(
      modifier = Modifier.fillMaxWidth(0.68f),
      shape = RoundedCornerShape(14.dp),
      color = mobileSurface,
      border = BorderStroke(1.dp, mobileBorder),
    ) {
      Row(
        modifier = Modifier.padding(horizontal = 12.dp, vertical = 10.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        verticalAlignment = Alignment.CenterVertically,
      ) {
        ThinkingDots(color = mobileTextSecondary)
        Text("OpenClaw is thinking…", style = mobileCallout, color = mobileTextSecondary)
      }
    }
  }
}

@Composable
private fun ThinkingDots(color: Color) {
  Row(horizontalArrangement = Arrangement.spacedBy(5.dp), verticalAlignment = Alignment.CenterVertically) {
    ThinkingDot(alpha = 0.38f, color = color)
    ThinkingDot(alpha = 0.62f, color = color)
    ThinkingDot(alpha = 0.90f, color = color)
  }
}

@Composable
private fun ThinkingDot(alpha: Float, color: Color) {
  Surface(
    modifier = Modifier.size(6.dp).alpha(alpha),
    shape = CircleShape,
    color = color,
  ) {}
}

@Composable
private fun MicWaveform(level: Float, active: Boolean) {
  val transition = rememberInfiniteTransition(label = "voiceWave")
  val phase by
    transition.animateFloat(
      initialValue = 0f,
      targetValue = 1f,
      animationSpec = infiniteRepeatable(animation = tween(1_000, easing = LinearEasing), repeatMode = RepeatMode.Restart),
      label = "voiceWavePhase",
    )

  val effective = if (active) level.coerceIn(0f, 1f) else 0f
  val base = max(effective, if (active) 0.05f else 0f)

  Row(
    modifier = Modifier.fillMaxWidth().heightIn(min = 40.dp),
    horizontalArrangement = Arrangement.spacedBy(4.dp, Alignment.CenterHorizontally),
    verticalAlignment = Alignment.CenterVertically,
  ) {
    repeat(16) { index ->
      val pulse =
        if (!active) {
          0f
        } else {
          ((sin(((phase * 2f * PI) + (index * 0.55f)).toDouble()) + 1.0) * 0.5).toFloat()
        }
      val barHeight = 6.dp + (24.dp * (base * pulse))
      Box(
        modifier =
          Modifier
            .width(5.dp)
            .height(barHeight)
            .background(if (active) mobileAccent else mobileBorderStrong, RoundedCornerShape(999.dp)),
      )
    }
  }
}

private fun Context.hasRecordAudioPermission(): Boolean {
  return (
    ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO) ==
      PackageManager.PERMISSION_GRANTED
    )
}

private fun Context.findActivity(): Activity? =
  when (this) {
    is Activity -> this
    is ContextWrapper -> baseContext.findActivity()
    else -> null
  }

private fun openAppSettings(context: Context) {
  val intent =
    Intent(
      Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
      Uri.fromParts("package", context.packageName, null),
    )
  context.startActivity(intent)
}
