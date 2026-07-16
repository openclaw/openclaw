package ai.openclaw.wear

import ai.openclaw.wear.shared.WearChatRole
import ai.openclaw.wear.shared.WearConversationSnapshot
import android.app.RemoteInput
import android.content.Intent
import android.os.Bundle
import android.speech.RecognizerIntent
import android.view.HapticFeedbackConstants
import androidx.activity.ComponentActivity
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.res.stringResource
import androidx.wear.compose.material3.AppScaffold
import androidx.wear.input.RemoteInputIntentHelper
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch

internal enum class WearInteractionState {
  READY,
  LISTENING,
  TYPING,
  SENDING,
  AGENT_WORKING,
  ERROR,
}

class MainActivity : ComponentActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    setContent {
      OpenClawWearApp(
        client = remember { WearConversationClient(applicationContext) },
        themePreferences = remember { WearThemePreferences(applicationContext) },
        conversationPreferences =
          remember {
            WearConversationPreferences(applicationContext)
          },
        speaker = remember { WearReplySpeaker(applicationContext) },
      )
    }
  }
}

@Composable
internal fun OpenClawWearApp(
  client: WearConversationClient,
  themePreferences: WearThemePreferences,
  conversationPreferences: WearConversationPreferences,
  speaker: WearReplySpeaker,
) {
  var snapshot by remember { mutableStateOf<WearConversationSnapshot?>(null) }
  var failure by remember { mutableStateOf<WearConversationFailure?>(null) }
  var loading by remember { mutableStateOf(true) }
  var actionBusy by remember { mutableStateOf(false) }
  var interaction by remember { mutableStateOf(WearInteractionState.READY) }
  var themeMode by remember { mutableStateOf(themePreferences.read()) }
  var autoSpeak by remember {
    mutableStateOf(conversationPreferences.readAutoSpeak())
  }
  val speaking by speaker.isSpeaking.collectAsState()
  val scope = rememberCoroutineScope()
  val view = LocalView.current
  val speakPrompt = stringResource(R.string.speak_to_agent)
  val messageLabel = stringResource(R.string.message)
  val messageTitle = stringResource(R.string.message_agent)
  val sendLabel = stringResource(R.string.send)

  fun applyResult(result: WearConversationClientResult) {
    val receivedSnapshot = result.snapshot
    if (receivedSnapshot != null) {
      snapshot = receivedSnapshot
      failure = null
    } else {
      failure = result.failure ?: WearConversationFailure.INTERNAL_ERROR
    }
    loading = false
  }

  fun reportFailure(result: WearConversationClientResult) {
    applyResult(result)
    interaction = WearInteractionState.ERROR
    view.performHapticFeedback(HapticFeedbackConstants.REJECT)
  }

  fun submitMessage(rawMessage: String) {
    val message = rawMessage.trim()
    if (message.isEmpty() || actionBusy) return
    val previousAssistantId = snapshot.latestAssistantMessage()?.id
    actionBusy = true
    failure = null
    interaction = WearInteractionState.SENDING
    speaker.stop()
    scope.launch {
      val submitted = client.sendMessage(message)
      if (submitted.snapshot == null) {
        reportFailure(submitted)
        actionBusy = false
        return@launch
      }
      applyResult(submitted)
      view.performHapticFeedback(HapticFeedbackConstants.CONFIRM)
      interaction = WearInteractionState.AGENT_WORKING

      var replyText: String? = null
      for (attempt in 0 until REPLY_POLL_ATTEMPTS) {
        val current = snapshot
        val latestAssistant = current.latestAssistantMessage()
        if (
          latestAssistant != null &&
          latestAssistant.id != previousAssistantId &&
          current?.pendingRunCount == 0
        ) {
          replyText = latestAssistant.text
          break
        }
        delay(REPLY_POLL_INTERVAL_MILLIS)
        val refreshed = client.loadSnapshot()
        if (refreshed.snapshot == null) {
          reportFailure(refreshed)
          return@launch
        }
        applyResult(refreshed)
      }

      actionBusy = false
      interaction = WearInteractionState.READY
      val completedReply = replyText
      if (completedReply != null) {
        view.performHapticFeedback(HapticFeedbackConstants.CONFIRM)
        if (autoSpeak) speaker.speak(completedReply)
      }
    }
  }

  fun selectAgent(agentId: String) {
    if (actionBusy) return
    actionBusy = true
    interaction = WearInteractionState.AGENT_WORKING
    speaker.stop()
    scope.launch {
      val result = client.selectAgent(agentId)
      if (result.snapshot == null) {
        reportFailure(result)
      } else {
        applyResult(result)
        interaction = WearInteractionState.READY
        view.performHapticFeedback(HapticFeedbackConstants.CONFIRM)
      }
      actionBusy = false
    }
  }

  fun selectSession(sessionId: String) {
    if (actionBusy) return
    actionBusy = true
    interaction = WearInteractionState.AGENT_WORKING
    speaker.stop()
    scope.launch {
      val result = client.selectSession(sessionId)
      if (result.snapshot == null) {
        reportFailure(result)
      } else {
        applyResult(result)
        interaction = WearInteractionState.READY
        view.performHapticFeedback(HapticFeedbackConstants.CONFIRM)
      }
      actionBusy = false
    }
  }

  fun refresh() {
    if (actionBusy) return
    loading = snapshot == null
    scope.launch {
      val result = client.loadSnapshot()
      if (result.snapshot == null) {
        reportFailure(result)
      } else {
        applyResult(result)
        if (interaction == WearInteractionState.ERROR) {
          interaction = WearInteractionState.READY
        }
      }
    }
  }

  val speechLauncher =
    rememberLauncherForActivityResult(
      ActivityResultContracts.StartActivityForResult(),
    ) { result ->
      val transcript =
        result.data
          ?.getStringArrayListExtra(RecognizerIntent.EXTRA_RESULTS)
          ?.firstOrNull()
      if (transcript.isNullOrBlank()) {
        interaction = WearInteractionState.READY
      } else {
        submitMessage(transcript)
      }
    }
  val textLauncher =
    rememberLauncherForActivityResult(
      ActivityResultContracts.StartActivityForResult(),
    ) { result ->
      val text =
        result.data
          ?.let(RemoteInput::getResultsFromIntent)
          ?.getCharSequence(REMOTE_INPUT_KEY)
          ?.toString()
      if (text.isNullOrBlank()) {
        interaction = WearInteractionState.READY
      } else {
        submitMessage(text)
      }
    }

  LaunchedEffect(client) {
    applyResult(client.loadSnapshot())
  }

  LaunchedEffect(client) {
    while (isActive) {
      delay(
        if (snapshot?.pendingRunCount.orZero() > 0) {
          ACTIVE_REFRESH_INTERVAL_MILLIS
        } else {
          IDLE_REFRESH_INTERVAL_MILLIS
        },
      )
      if (!actionBusy) {
        applyResult(client.loadSnapshot())
      }
    }
  }

  DisposableEffect(speaker) {
    onDispose {
      speaker.shutdown()
    }
  }

  OpenClawWearTheme(themeMode = themeMode) {
    AppScaffold {
      OpenClawWearScreens(
        snapshot = snapshot,
        failure = failure,
        loading = loading,
        interaction =
          when {
            speaking -> WearInteractionState.READY
            snapshot?.pendingRunCount.orZero() > 0 &&
              interaction == WearInteractionState.READY ->
              WearInteractionState.AGENT_WORKING
            else -> interaction
          },
        speaking = speaking,
        actionBusy = actionBusy,
        themeMode = themeMode,
        autoSpeak = autoSpeak,
        onTalk = {
          interaction = WearInteractionState.LISTENING
          val intent =
            Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH)
              .putExtra(
                RecognizerIntent.EXTRA_LANGUAGE_MODEL,
                RecognizerIntent.LANGUAGE_MODEL_FREE_FORM,
              ).putExtra(
                RecognizerIntent.EXTRA_PROMPT,
                speakPrompt,
              )
          runCatching { speechLauncher.launch(intent) }
            .onFailure {
              interaction = WearInteractionState.ERROR
              failure = WearConversationFailure.INTERNAL_ERROR
              view.performHapticFeedback(HapticFeedbackConstants.REJECT)
            }
        },
        onType = {
          interaction = WearInteractionState.TYPING
          val remoteInput =
            RemoteInput
              .Builder(REMOTE_INPUT_KEY)
              .setLabel(messageLabel)
              .build()
          val intent =
            RemoteInputIntentHelper
              .createActionRemoteInputIntent()
              .also { inputIntent ->
                RemoteInputIntentHelper.putRemoteInputsExtra(
                  inputIntent,
                  listOf(remoteInput),
                )
                RemoteInputIntentHelper.putTitleExtra(
                  inputIntent,
                  messageTitle,
                )
                RemoteInputIntentHelper.putConfirmLabelExtra(
                  inputIntent,
                  sendLabel,
                )
              }
          runCatching { textLauncher.launch(intent) }
            .onFailure {
              interaction = WearInteractionState.ERROR
              failure = WearConversationFailure.INTERNAL_ERROR
              view.performHapticFeedback(HapticFeedbackConstants.REJECT)
            }
        },
        onSelectAgent = ::selectAgent,
        onSelectSession = ::selectSession,
        onRefresh = ::refresh,
        onThemeModeChange = { selectedMode ->
          themeMode = selectedMode
          themePreferences.write(selectedMode)
        },
        onAutoSpeakChange = { enabled ->
          autoSpeak = enabled
          conversationPreferences.writeAutoSpeak(enabled)
          if (!enabled) speaker.stop()
        },
        onSpeakLatest = {
          snapshot.latestAssistantMessage()?.text?.let(speaker::speak)
        },
        onStopSpeaking = speaker::stop,
      )
    }
  }
}

private fun WearConversationSnapshot?.latestAssistantMessage() =
  this
    ?.messages
    ?.lastOrNull { message ->
      message.role == WearChatRole.ASSISTANT && message.text.isNotBlank()
    }

private fun Int?.orZero(): Int = this ?: 0

private const val REMOTE_INPUT_KEY = "openclaw_watch_message"
private const val REPLY_POLL_ATTEMPTS = 72
private const val REPLY_POLL_INTERVAL_MILLIS = 1_250L
private const val ACTIVE_REFRESH_INTERVAL_MILLIS = 1_500L
private const val IDLE_REFRESH_INTERVAL_MILLIS = 10_000L
