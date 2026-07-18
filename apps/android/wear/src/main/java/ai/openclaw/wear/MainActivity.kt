package ai.openclaw.wear

import ai.openclaw.wear.shared.WearRealtimeTalkRole
import android.Manifest
import android.app.Activity
import android.app.RemoteInput
import android.content.ActivityNotFoundException
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.speech.RecognizerIntent
import androidx.activity.ComponentActivity
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.activity.viewModels
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
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
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.content.ContextCompat
import androidx.wear.compose.foundation.lazy.TransformingLazyColumn
import androidx.wear.compose.foundation.lazy.rememberTransformingLazyColumnState
import androidx.wear.compose.material3.AppScaffold
import androidx.wear.compose.material3.Button
import androidx.wear.compose.material3.ButtonDefaults
import androidx.wear.compose.material3.MaterialTheme
import androidx.wear.compose.material3.ScreenScaffold
import androidx.wear.compose.material3.Text
import androidx.wear.input.RemoteInputIntentHelper

class MainActivity : ComponentActivity() {
  private val viewModel: WearViewModel by viewModels()

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    setContent {
      val state by viewModel.state.collectAsState()
      OpenClawWearApp(
        state = state,
        onRefresh = viewModel::refresh,
        onOpenSession = viewModel::openSession,
        onBack = viewModel::closeSession,
        onReply = viewModel::sendReply,
        onAbort = viewModel::abort,
        onStartTalk = viewModel::startRealtimeTalk,
        onStopTalk = viewModel::stopRealtimeTalk,
      )
    }
  }

  override fun onStart() {
    super.onStart()
    (application as WearApplication).onActivityStarted()
  }

  override fun onStop() {
    (application as WearApplication).onActivityStopped()
    super.onStop()
  }
}

@Composable
internal fun OpenClawWearApp(
  state: WearUiState,
  onRefresh: () -> Unit,
  onOpenSession: (WearSession) -> Unit,
  onBack: () -> Unit,
  onReply: (String) -> Unit,
  onAbort: () -> Unit,
  onStartTalk: () -> Unit,
  onStopTalk: () -> Unit,
) {
  BackHandler(enabled = state.selectedSession != null, onBack = onBack)
  MaterialTheme {
    AppScaffold {
      if (state.selectedSession == null) {
        SessionListScreen(state, onRefresh, onOpenSession)
      } else {
        TranscriptScreen(state, onBack, onRefresh, onReply, onAbort, onStartTalk, onStopTalk)
      }
    }
  }
}

@Composable
private fun SessionListScreen(
  state: WearUiState,
  onRefresh: () -> Unit,
  onOpenSession: (WearSession) -> Unit,
) {
  val context = LocalContext.current
  var notificationsGranted by remember {
    mutableStateOf(
      Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU ||
        ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED,
    )
  }
  val permissionLauncher =
    rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
      notificationsGranted = granted
    }
  val listState = rememberTransformingLazyColumnState()
  ScreenScaffold(scrollState = listState) { contentPadding ->
    TransformingLazyColumn(
      modifier = Modifier.background(OpenClawBackground),
      state = listState,
      contentPadding = contentPadding,
      horizontalAlignment = Alignment.CenterHorizontally,
      verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
      item { WearHeader(section = "SESSIONS") }
      item { ConnectionPanel(state = state, onRefresh = onRefresh) }
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU && !notificationsGranted) {
        item {
          ActionButton(
            label = "ENABLE ALERTS",
            onClick = { permissionLauncher.launch(Manifest.permission.POST_NOTIFICATIONS) },
            accent = OpenClawCyan,
          )
        }
      }
      for (session in state.sessions) {
        item {
          SessionButton(session = session, onClick = { onOpenSession(session) })
        }
      }
      if (!state.loading && state.connected && state.sessions.isEmpty()) {
        item { EmptyLabel("NO RECENT SESSIONS") }
      }
      state.error?.let { error -> item { ErrorLabel(error) } }
    }
  }
}

@Composable
private fun TranscriptScreen(
  state: WearUiState,
  onBack: () -> Unit,
  onRefresh: () -> Unit,
  onReply: (String) -> Unit,
  onAbort: () -> Unit,
  onStartTalk: () -> Unit,
  onStopTalk: () -> Unit,
) {
  val session = state.selectedSession ?: return
  val context = LocalContext.current
  val voiceIntent = remember { createVoiceInputIntent() }
  var voiceAvailable by remember(context) {
    mutableStateOf(voiceIntent.resolveActivity(context.packageManager) != null)
  }
  var microphoneGranted by remember(context) {
    mutableStateOf(
      ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED,
    )
  }
  val microphonePermissionLauncher =
    rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
      microphoneGranted = granted
      if (granted) onStartTalk()
    }
  val textInputLauncher =
    rememberLauncherForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
      if (result.resultCode != Activity.RESULT_OK) return@rememberLauncherForActivityResult
      val data = result.data ?: return@rememberLauncherForActivityResult
      val text = RemoteInput.getResultsFromIntent(data)?.getCharSequence(REPLY_RESULT_KEY)?.toString()
      text?.takeIf { it.isNotBlank() }?.let(onReply)
    }
  val voiceInputLauncher =
    rememberLauncherForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
      if (result.resultCode != Activity.RESULT_OK) return@rememberLauncherForActivityResult
      val data = result.data ?: return@rememberLauncherForActivityResult
      val text = data.getStringArrayListExtra(RecognizerIntent.EXTRA_RESULTS)?.firstOrNull()
      text?.takeIf { it.isNotBlank() }?.let(onReply)
    }
  val listState = rememberTransformingLazyColumnState()
  ScreenScaffold(scrollState = listState) { contentPadding ->
    TransformingLazyColumn(
      modifier = Modifier.background(OpenClawBackground),
      state = listState,
      contentPadding = contentPadding,
      horizontalAlignment = Alignment.CenterHorizontally,
      verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
      item { WearHeader(section = session.title.uppercase()) }
      item {
        Text(
          text = if (state.connected) "PHONE READY" else state.status.uppercase(),
          color = if (state.connected) OpenClawGreen else OpenClawWarning,
          fontSize = 10.sp,
          fontWeight = FontWeight.Bold,
          letterSpacing = 0.8.sp,
          textAlign = TextAlign.Center,
          modifier = Modifier.fillMaxWidth(),
        )
      }
      item {
        Row(
          modifier = Modifier.fillMaxWidth(),
          horizontalArrangement = Arrangement.spacedBy(6.dp),
        ) {
          CompactAction(label = "BACK", onClick = onBack, modifier = Modifier.weight(1f))
          CompactAction(label = "SYNC", onClick = onRefresh, modifier = Modifier.weight(1f))
        }
      }
      for (message in state.messages) {
        item { MessagePanel(message) }
      }
      for (entry in state.realtimeTalk.conversation) {
        item {
          RealtimeTalkPanel(
            assistant = entry.role == WearRealtimeTalkRole.ASSISTANT,
            text = entry.text,
            streaming = entry.streaming,
          )
        }
      }
      state.streamText?.takeIf { it.isNotBlank() }?.let { text ->
        item { StreamingPanel(text) }
      }
      if (!state.loading && state.messages.isEmpty() && state.streamText.isNullOrBlank()) {
        item { EmptyLabel("NO MESSAGES YET") }
      }
      item {
        ActionButton(
          label = if (state.sending) "SENDING…" else "REPLY",
          onClick = {
            val remoteInput = RemoteInput.Builder(REPLY_RESULT_KEY).setLabel("Reply").build()
            val intent = RemoteInputIntentHelper.createActionRemoteInputIntent()
            RemoteInputIntentHelper.putRemoteInputsExtra(intent, listOf(remoteInput))
            textInputLauncher.launch(intent)
          },
          enabled = state.connected && !state.sending,
          accent = OpenClawRed,
        )
      }
      item {
        CompactAction(
          label = if (voiceAvailable) "VOICE REPLY" else "VOICE UNAVAILABLE",
          onClick = {
            try {
              voiceInputLauncher.launch(voiceIntent)
            } catch (_: ActivityNotFoundException) {
              voiceAvailable = false
            }
          },
          modifier = Modifier.fillMaxWidth(),
          enabled = state.connected && !state.sending && voiceAvailable,
        )
      }
      item {
        ActionButton(
          label =
            when {
              state.talkBusy -> "REAL-TIME TALK…"
              state.realtimeTalk.active -> "STOP REAL-TIME TALK"
              else -> "REAL-TIME TALK"
            },
          onClick = {
            if (state.realtimeTalk.active) {
              onStopTalk()
            } else if (microphoneGranted) {
              onStartTalk()
            } else {
              microphonePermissionLauncher.launch(Manifest.permission.RECORD_AUDIO)
            }
          },
          enabled = state.connected && !state.talkBusy,
          accent = if (state.realtimeTalk.active) OpenClawWarning else OpenClawCyan,
        )
      }
      if (state.realtimeTalk.active || state.talkBusy) {
        item {
          Text(
            text = state.realtimeTalk.statusText.uppercase(),
            color = if (state.realtimeTalk.active) OpenClawGreen else OpenClawMuted,
            fontSize = 10.sp,
            fontWeight = FontWeight.Bold,
            textAlign = TextAlign.Center,
            modifier = Modifier.fillMaxWidth(),
          )
        }
      }
      if (state.activeRunId != null || !state.streamText.isNullOrBlank()) {
        item {
          ActionButton(label = "ABORT RUN", onClick = onAbort, accent = OpenClawWarning)
        }
      }
      state.error?.let { error -> item { ErrorLabel(error) } }
    }
  }
}

private fun createVoiceInputIntent(): Intent =
  Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
    putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
    putExtra(RecognizerIntent.EXTRA_PROMPT, "Reply to OpenClaw")
  }

@Composable
private fun WearHeader(section: String) {
  Column(
    modifier = Modifier.fillMaxWidth().padding(horizontal = 8.dp),
    horizontalAlignment = Alignment.CenterHorizontally,
  ) {
    Text(
      text = "OPENCLAW",
      color = OpenClawRed,
      fontSize = 11.sp,
      fontWeight = FontWeight.Bold,
      letterSpacing = 1.4.sp,
    )
    Text(
      text = section,
      color = Color.White,
      fontSize = 17.sp,
      fontWeight = FontWeight.SemiBold,
      maxLines = 1,
      overflow = TextOverflow.Ellipsis,
    )
  }
}

@Composable
private fun ConnectionPanel(
  state: WearUiState,
  onRefresh: () -> Unit,
) {
  Column(
    modifier =
      Modifier
        .fillMaxWidth()
        .background(OpenClawPanel, RoundedCornerShape(20.dp))
        .padding(horizontal = 14.dp, vertical = 12.dp),
    horizontalAlignment = Alignment.CenterHorizontally,
  ) {
    Row(verticalAlignment = Alignment.CenterVertically) {
      Box(
        modifier =
          Modifier
            .size(8.dp)
            .background(if (state.connected) OpenClawGreen else OpenClawRed, CircleShape),
      )
      Spacer(Modifier.size(7.dp))
      Text(
        text =
          when {
            state.loading -> "CHECKING PHONE"
            state.connected -> "PHONE READY"
            else -> "PHONE UNAVAILABLE"
          },
        color = Color.White,
        fontSize = 13.sp,
        fontWeight = FontWeight.SemiBold,
      )
    }
    Spacer(Modifier.height(5.dp))
    Text(
      text = state.status,
      color = OpenClawMuted,
      fontSize = 11.sp,
      lineHeight = 14.sp,
      textAlign = TextAlign.Center,
      maxLines = 2,
      overflow = TextOverflow.Ellipsis,
    )
    if (!state.loading) {
      Spacer(Modifier.height(8.dp))
      CompactAction(label = "REFRESH", onClick = onRefresh, modifier = Modifier.fillMaxWidth())
    }
  }
}

@Composable
private fun SessionButton(
  session: WearSession,
  onClick: () -> Unit,
) {
  Button(
    onClick = onClick,
    modifier = Modifier.fillMaxWidth(),
    colors = ButtonDefaults.buttonColors(containerColor = OpenClawPanel, contentColor = Color.White),
    label = {
      Column(modifier = Modifier.fillMaxWidth()) {
        Text(
          text = session.title,
          fontSize = 14.sp,
          fontWeight = FontWeight.SemiBold,
          maxLines = 1,
          overflow = TextOverflow.Ellipsis,
        )
        Text(
          text = if (session.hasActiveRun) "ACTIVE RUN" else session.key.takeLast(32),
          color = if (session.hasActiveRun) OpenClawCyan else OpenClawMuted,
          fontSize = 10.sp,
          maxLines = 1,
          overflow = TextOverflow.Ellipsis,
        )
      }
    },
  )
}

@Composable
private fun MessagePanel(message: WearChatMessage) {
  val assistant = message.role == "assistant"
  Column(
    modifier =
      Modifier
        .fillMaxWidth()
        .background(if (assistant) OpenClawPanel else OpenClawAccentPanel, RoundedCornerShape(18.dp))
        .padding(horizontal = 13.dp, vertical = 10.dp),
  ) {
    Text(
      text = if (assistant) "OPENCLAW" else "YOU",
      color = if (assistant) OpenClawCyan else OpenClawRed,
      fontSize = 9.sp,
      fontWeight = FontWeight.Bold,
      letterSpacing = 1.sp,
    )
    Spacer(Modifier.height(3.dp))
    Text(
      text = message.text,
      color = Color.White,
      fontSize = 12.sp,
      lineHeight = 16.sp,
      maxLines = 8,
      overflow = TextOverflow.Ellipsis,
    )
  }
}

@Composable
private fun StreamingPanel(text: String) {
  Column(
    modifier =
      Modifier
        .fillMaxWidth()
        .background(OpenClawPanel, RoundedCornerShape(18.dp))
        .padding(horizontal = 13.dp, vertical = 10.dp),
  ) {
    Text(
      text = "LIVE",
      color = OpenClawGreen,
      fontSize = 9.sp,
      fontWeight = FontWeight.Bold,
      letterSpacing = 1.sp,
    )
    Text(
      text = text,
      color = Color.White,
      fontSize = 12.sp,
      lineHeight = 16.sp,
      maxLines = 8,
      overflow = TextOverflow.Ellipsis,
    )
  }
}

@Composable
private fun RealtimeTalkPanel(
  assistant: Boolean,
  text: String,
  streaming: Boolean,
) {
  Column(
    modifier =
      Modifier
        .fillMaxWidth()
        .background(if (assistant) OpenClawPanel else OpenClawAccentPanel, RoundedCornerShape(18.dp))
        .padding(horizontal = 13.dp, vertical = 10.dp),
  ) {
    Text(
      text = if (assistant) "REAL-TIME OPENCLAW" else "REAL-TIME YOU",
      color = if (assistant) OpenClawCyan else OpenClawRed,
      fontSize = 9.sp,
      fontWeight = FontWeight.Bold,
      letterSpacing = 1.sp,
    )
    Text(
      text = text + if (streaming) " …" else "",
      color = Color.White,
      fontSize = 12.sp,
      lineHeight = 16.sp,
      maxLines = 8,
      overflow = TextOverflow.Ellipsis,
    )
  }
}

@Composable
private fun ActionButton(
  label: String,
  onClick: () -> Unit,
  accent: Color,
  enabled: Boolean = true,
) {
  Button(
    onClick = onClick,
    enabled = enabled,
    modifier = Modifier.fillMaxWidth(),
    colors = ButtonDefaults.buttonColors(containerColor = accent, contentColor = OpenClawBackground),
    label = {
      Text(
        text = label,
        modifier = Modifier.fillMaxWidth(),
        textAlign = TextAlign.Center,
        fontSize = 12.sp,
        fontWeight = FontWeight.Bold,
        letterSpacing = 0.8.sp,
      )
    },
  )
}

@Composable
private fun CompactAction(
  label: String,
  onClick: () -> Unit,
  modifier: Modifier,
  enabled: Boolean = true,
) {
  Button(
    onClick = onClick,
    enabled = enabled,
    modifier = modifier,
    colors = ButtonDefaults.buttonColors(containerColor = OpenClawPanel, contentColor = Color.White),
    label = {
      Text(
        text = label,
        modifier = Modifier.fillMaxWidth(),
        textAlign = TextAlign.Center,
        fontSize = 10.sp,
        fontWeight = FontWeight.Bold,
      )
    },
  )
}

@Composable
private fun EmptyLabel(text: String) {
  Text(
    text = text,
    color = OpenClawMuted,
    fontSize = 11.sp,
    fontWeight = FontWeight.Medium,
    textAlign = TextAlign.Center,
    modifier = Modifier.fillMaxWidth().padding(10.dp),
  )
}

@Composable
private fun ErrorLabel(text: String) {
  Text(
    text = text,
    color = OpenClawWarning,
    fontSize = 11.sp,
    lineHeight = 14.sp,
    textAlign = TextAlign.Center,
    modifier = Modifier.fillMaxWidth().padding(horizontal = 10.dp),
  )
}

internal const val REPLY_RESULT_KEY = "openclaw_wear_reply"

private val OpenClawBackground = Color(0xFF07080A)
private val OpenClawPanel = Color(0xFF17191F)
private val OpenClawAccentPanel = Color(0xFF21181C)
private val OpenClawRed = Color(0xFFFF5A67)
private val OpenClawCyan = Color(0xFF70DDF2)
private val OpenClawGreen = Color(0xFF68D391)
private val OpenClawWarning = Color(0xFFF0B35A)
private val OpenClawMuted = Color(0xFFB7BAC2)
