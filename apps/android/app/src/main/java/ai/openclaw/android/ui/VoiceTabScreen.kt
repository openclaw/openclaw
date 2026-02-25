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
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.WindowInsetsSides
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.only
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import ai.openclaw.android.MainViewModel
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
  val liveTranscript by viewModel.micLiveTranscript.collectAsState()
  val queuedMessages by viewModel.micQueuedMessages.collectAsState()
  val micInputLevel by viewModel.micInputLevel.collectAsState()
  val micIsSending by viewModel.micIsSending.collectAsState()

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

  LazyColumn(
    state = listState,
    modifier =
      Modifier
        .fillMaxWidth()
        .imePadding()
        .windowInsetsPadding(WindowInsets.safeDrawing.only(WindowInsetsSides.Bottom)),
    contentPadding = PaddingValues(horizontal = 20.dp, vertical = 16.dp),
    verticalArrangement = Arrangement.spacedBy(10.dp),
  ) {
    item {
      Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Text(
          "VOICE",
          style = mobileCaption1.copy(fontWeight = FontWeight.Bold, letterSpacing = 1.sp),
          color = mobileAccent,
        )
        Text("Mic capture", style = mobileTitle2, color = mobileText)
        Text(
          if (isConnected) {
            "Mic on captures speech continuously. Mic off sends the full transcript queue."
          } else {
            "Gateway offline. Mic off will keep messages queued until reconnect."
          },
          style = mobileCallout,
          color = mobileTextSecondary,
        )
      }
    }

    item {
      Surface(
        modifier = Modifier.fillMaxWidth(),
        shape = RoundedCornerShape(16.dp),
        color = Color.White,
        border = BorderStroke(1.dp, mobileBorder),
      ) {
        Column(
          modifier = Modifier.fillMaxWidth().padding(horizontal = 14.dp, vertical = 12.dp),
          verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
          Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically,
          ) {
            Text("Gateway", style = mobileCaption1, color = mobileTextSecondary)
            Text(gatewayStatus, style = mobileCaption1, color = mobileText)
          }
          Text(micStatusText, style = mobileHeadline, color = mobileText)
          Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
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
              shape = RoundedCornerShape(12.dp),
              colors =
                ButtonDefaults.buttonColors(
                  containerColor = if (micEnabled) mobileDanger else mobileAccent,
                  contentColor = Color.White,
                ),
            ) {
              Text(
                if (micEnabled) "Mic off" else "Mic on",
                style = mobileCallout.copy(fontWeight = FontWeight.Bold),
              )
            }
            if (!hasMicPermission) {
              Button(
                onClick = { openAppSettings(context) },
                shape = RoundedCornerShape(12.dp),
                colors =
                  ButtonDefaults.buttonColors(
                    containerColor = mobileSurfaceStrong,
                    contentColor = mobileText,
                  ),
              ) {
                Text("Open settings", style = mobileCallout.copy(fontWeight = FontWeight.SemiBold))
              }
            }
          }
          if (!hasMicPermission) {
            val showRationale =
              if (activity == null) {
                false
              } else {
                ActivityCompat.shouldShowRequestPermissionRationale(activity, Manifest.permission.RECORD_AUDIO)
              }
            Text(
              if (showRationale) {
                "Microphone permission required to capture speech."
              } else {
                "Microphone is blocked. Enable it in app settings."
              },
              style = mobileCallout,
              color = mobileWarning,
            )
          }
        }
      }
    }

    item {
      Surface(
        modifier = Modifier.fillMaxWidth(),
        shape = RoundedCornerShape(16.dp),
        color = Color.White,
        border = BorderStroke(1.dp, mobileBorder),
      ) {
        Column(
          modifier = Modifier.fillMaxWidth().padding(horizontal = 14.dp, vertical = 12.dp),
          verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
          Text("Mic waveform", style = mobileHeadline, color = mobileText)
          MicWaveform(level = micInputLevel, active = micEnabled)
        }
      }
    }

    item {
      Surface(
        modifier = Modifier.fillMaxWidth(),
        shape = RoundedCornerShape(16.dp),
        color = Color.White,
        border = BorderStroke(1.dp, mobileBorder),
      ) {
        Column(
          modifier = Modifier.fillMaxWidth().padding(horizontal = 14.dp, vertical = 12.dp),
          verticalArrangement = Arrangement.spacedBy(6.dp),
        ) {
          Text("Live transcript", style = mobileHeadline, color = mobileText)
          Text(
            liveTranscript?.trim().takeUnless { it.isNullOrEmpty() } ?: "Waiting for speech…",
            style = mobileCallout,
            color = if (liveTranscript.isNullOrBlank()) mobileTextTertiary else mobileText,
          )
        }
      }
    }

    item {
      Surface(
        modifier = Modifier.fillMaxWidth(),
        shape = RoundedCornerShape(16.dp),
        color = Color.White,
        border = BorderStroke(1.dp, mobileBorder),
      ) {
        Column(
          modifier = Modifier.fillMaxWidth().padding(horizontal = 14.dp, vertical = 12.dp),
          verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
          Text("Queued messages", style = mobileHeadline, color = mobileText)
          Text(
            if (queuedMessages.isEmpty()) {
              "No queued transcripts."
            } else {
              "${queuedMessages.size} queued${if (micIsSending) " · sending…" else ""}"
            },
            style = mobileCallout,
            color = mobileTextSecondary,
          )
          if (queuedMessages.isNotEmpty()) {
            HorizontalDivider(color = mobileBorder)
          }
          if (queuedMessages.isEmpty()) {
            Text("Turn mic off to flush captured speech into the queue.", style = mobileCallout, color = mobileTextTertiary)
          } else {
            queuedMessages.forEachIndexed { index, item ->
              Surface(
                modifier = Modifier.fillMaxWidth().padding(bottom = if (index == queuedMessages.lastIndex) 0.dp else 8.dp),
                shape = RoundedCornerShape(12.dp),
                color = mobileSurface,
                border = BorderStroke(1.dp, mobileBorder),
              ) {
                Column(modifier = Modifier.fillMaxWidth().padding(horizontal = 10.dp, vertical = 8.dp)) {
                  Text("Message ${index + 1}", style = mobileCaption1, color = mobileTextSecondary)
                  Text(item, style = mobileCallout, color = mobileText)
                }
              }
            }
          }
        }
      }
    }

    item { Spacer(modifier = Modifier.height(24.dp)) }
  }
}

@Composable
private fun MicWaveform(level: Float, active: Boolean) {
  val transition = rememberInfiniteTransition(label = "wave")
  val phase by
    transition.animateFloat(
      initialValue = 0f,
      targetValue = 1f,
      animationSpec = infiniteRepeatable(animation = tween(1_200, easing = LinearEasing), repeatMode = RepeatMode.Restart),
      label = "wavePhase",
    )
  val effective = if (active) level.coerceIn(0f, 1f) else 0f
  val base = max(effective, if (active) 0.08f else 0f)
  Row(
    modifier = Modifier.fillMaxWidth().heightIn(min = 60.dp),
    horizontalArrangement = Arrangement.spacedBy(4.dp, Alignment.CenterHorizontally),
    verticalAlignment = Alignment.CenterVertically,
  ) {
    repeat(22) { index ->
      val pulse =
        if (!active) {
          0f
        } else {
          ((sin(((phase * 2f * PI) + (index * 0.5f)).toDouble()) + 1.0) * 0.5).toFloat()
        }
      val barHeight = 8.dp + (52.dp * (base * pulse))
      Box(
        modifier =
          Modifier
            .width(6.dp)
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
