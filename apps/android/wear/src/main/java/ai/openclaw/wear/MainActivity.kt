package ai.openclaw.wear

import ai.openclaw.wear.shared.WearRealtimeTalkRole
import android.Manifest
import android.app.Activity
import android.app.RemoteInput
import android.content.ActivityNotFoundException
import android.content.Intent
import android.content.pm.ApplicationInfo
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.speech.RecognizerIntent
import android.view.HapticFeedbackConstants
import androidx.activity.ComponentActivity
import androidx.activity.compose.LocalActivity
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.result.ActivityResultLauncher
import androidx.activity.result.contract.ActivityResultContracts
import androidx.activity.viewModels
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.res.stringResource
import androidx.core.content.ContextCompat
import androidx.core.net.toUri
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.wear.compose.material3.AppScaffold
import androidx.wear.input.RemoteInputIntentHelper
import kotlinx.coroutines.delay
import java.util.Locale

internal const val extraWearLaunchTarget = "openclaw.wear.launchTarget"

internal enum class WearLaunchTarget(
  val rawValue: String,
  val initialPage: WearHomePage,
) {
  Chat("chat", WearHomePage.Chat),
  Voice("voice", WearHomePage.Voice),
  ;

  companion object {
    fun fromRawValue(raw: String?): WearLaunchTarget = entries.firstOrNull { target -> target.rawValue == raw?.trim()?.lowercase() } ?: Chat
  }
}

internal fun consumeWearConversationTarget(intent: Intent?): WearConversationTarget? {
  val sessionKey = intent?.getStringExtra(EXTRA_SESSION_KEY)?.takeIf(String::isNotBlank)
  val phoneNodeId = intent?.getStringExtra(EXTRA_PHONE_NODE_ID)?.takeIf(String::isNotBlank)
  intent?.removeExtra(EXTRA_SESSION_KEY)
  intent?.removeExtra(EXTRA_PHONE_NODE_ID)
  return if (sessionKey != null && phoneNodeId != null) WearConversationTarget(sessionKey, phoneNodeId) else null
}

internal fun parseWearLaunchTarget(intent: Intent?): WearLaunchTarget = WearLaunchTarget.fromRawValue(intent?.getStringExtra(extraWearLaunchTarget))

internal fun consumeWearLaunchTarget(intent: Intent?): WearLaunchTarget =
  parseWearLaunchTarget(intent).also {
    intent?.removeExtra(extraWearLaunchTarget)
  }

internal data class WearNavigationRequest(
  val id: Int,
  val target: WearLaunchTarget,
  val waitForConversation: Boolean = false,
)

internal data class WearLaunchState(
  val initialTarget: WearLaunchTarget = WearLaunchTarget.Chat,
  val navigationRequest: WearNavigationRequest? = null,
  val nextRequestId: Int = 0,
) {
  fun next(
    intent: Intent?,
    waitForConversation: Boolean = false,
  ): WearLaunchState {
    val requestId = nextRequestId + 1
    return copy(
      navigationRequest =
        WearNavigationRequest(
          id = requestId,
          target = consumeWearLaunchTarget(intent),
          waitForConversation = waitForConversation,
        ),
      nextRequestId = requestId,
    )
  }

  fun handled(requestId: Int): WearLaunchState = if (navigationRequest?.id == requestId) copy(navigationRequest = null) else this

  companion object {
    fun initial(intent: Intent?): WearLaunchState = WearLaunchState(initialTarget = consumeWearLaunchTarget(intent))
  }
}

@Composable
internal fun WearLaunchContent(
  launchState: WearLaunchState,
  content: @Composable (WearHomePage, WearNavigationRequest?) -> Unit,
) {
  // Warm launches are pager events. Keeping this composition identity stable preserves
  // pending-reply, autospeak, and real-time UI state owned below this boundary.
  content(launchState.initialTarget.initialPage, launchState.navigationRequest)
}

internal fun shouldRecreateForScreenshotMode(
  currentScene: WearScreenshotScene?,
  intent: Intent?,
  screenshotModeEnabled: Boolean,
): Boolean =
  screenshotModeEnabled &&
    (currentScene != null || parseWearScreenshotModeIntent(intent) != null)

class MainActivity : ComponentActivity() {
  private val viewModel: WearViewModel by viewModels()
  private var screenshotScene: WearScreenshotScene? = null
  private var launchState by mutableStateOf(WearLaunchState())

  private val screenshotModeEnabled: Boolean
    get() = applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE != 0

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    if (screenshotModeEnabled) {
      screenshotScene = parseWearScreenshotModeIntent(intent)
    }
    launchState = WearLaunchState.initial(intent)
    if (screenshotScene == null) consumeWearConversationTarget(intent)?.let(viewModel::openNotification)
    setContent {
      val scene = screenshotScene
      if (scene == null) {
        WearLaunchContent(launchState) { initialPage, navigationRequest ->
          OpenClawWearApp(
            viewModel = viewModel,
            settingsStore = remember { WearSettingsStore(applicationContext) },
            speaker = remember { WearReplySpeaker(applicationContext) },
            initialPage = initialPage,
            navigationRequest = navigationRequest,
            onNavigationRequestHandled = { requestId ->
              launchState = launchState.handled(requestId)
            },
          )
        }
      } else {
        OpenClawWearScreenshotApp(scene)
      }
    }
  }

  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    setIntent(intent)
    if (shouldRecreateForScreenshotMode(screenshotScene, intent, screenshotModeEnabled)) {
      recreate()
      return
    }
    val conversationTarget = consumeWearConversationTarget(intent)
    conversationTarget?.let(viewModel::openNotification)
    launchState = launchState.next(intent, waitForConversation = conversationTarget != null)
  }

  override fun onStart() {
    super.onStart()
    if (screenshotScene == null) {
      (application as WearApplication).onActivityStarted()
    }
  }

  override fun onStop() {
    if (screenshotScene == null) {
      (application as WearApplication).onActivityStopped()
    }
    super.onStop()
  }
}

@Composable
internal fun OpenClawWearApp(
  viewModel: WearViewModel,
  settingsStore: WearSettingsStore,
  speaker: WearReplySpeaker,
  initialPage: WearHomePage = WearHomePage.Chat,
  navigationRequest: WearNavigationRequest? = null,
  onNavigationRequestHandled: (Int) -> Unit = {},
) {
  val state by viewModel.state.collectAsState()
  val snapshot = state.toConversationSnapshot()
  val conversationContext = viewModel.captureConversationContext()
  val speaking by speaker.isSpeaking.collectAsState()
  val speechFailed by speaker.failed.collectAsState()
  val view = LocalView.current
  val lifecycleOwner = LocalLifecycleOwner.current
  val activity = LocalActivity.current
  val initialSettings = remember(settingsStore) { settingsStore.read() }
  var interaction by remember { mutableStateOf(WearInteractionState.READY) }
  var themeMode by remember { mutableStateOf(initialSettings.themeMode) }
  var autoSpeak by remember { mutableStateOf(initialSettings.autoSpeak) }
  var notificationsGranted by remember {
    mutableStateOf(
      Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU ||
        ContextCompat.checkSelfPermission(view.context, Manifest.permission.POST_NOTIFICATIONS) ==
        PackageManager.PERMISSION_GRANTED,
    )
  }
  var microphoneGranted by remember {
    mutableStateOf(ContextCompat.checkSelfPermission(view.context, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED)
  }
  var microphoneDenied by remember { mutableStateOf(false) }
  var microphoneSettingsRequired by remember { mutableStateOf(false) }
  var expectedAssistantKey by remember { mutableStateOf<String?>(null) }
  var awaitingReplySessionId by remember { mutableStateOf<String?>(null) }
  var awaitingReplyRunId by remember { mutableStateOf<String?>(null) }
  var awaitingReplyContext by remember { mutableStateOf<WearConversationContext?>(null) }
  var awaitingReply by remember { mutableStateOf(false) }
  var previousRealtimeSnapshot by remember { mutableStateOf(snapshot) }
  var realtimeThinkingTurnId by remember { mutableStateOf<String?>(null) }
  var inputContext by remember { mutableStateOf<WearConversationContext?>(null) }
  var audioPermissionPending by remember { mutableStateOf(false) }
  var modelSearchContext by remember { mutableStateOf<WearConversationContext?>(null) }
  val speakPrompt = stringResource(R.string.speak_to_agent)
  val messageLabel = stringResource(R.string.message)
  val messageTitle = stringResource(R.string.message_agent)
  val sendLabel = stringResource(R.string.send)
  val sessionSearchTitle = stringResource(R.string.search_sessions_title)
  val modelSearchTitle = stringResource(R.string.search_models_title)
  val searchLabel = stringResource(R.string.search)

  fun submitMessage(rawMessage: String) {
    val context = inputContext
    inputContext = null
    if (!viewModel.validateConversationContext(context)) {
      interaction = WearInteractionState.READY
      view.performHapticFeedback(HapticFeedbackConstants.REJECT)
      return
    }
    val message = rawMessage.trim()
    val sessionId = snapshot?.activeSessionId
    if (message.isEmpty()) {
      interaction = WearInteractionState.READY
      return
    }
    if (!state.canSubmitReply) {
      interaction = WearInteractionState.READY
      view.performHapticFeedback(HapticFeedbackConstants.REJECT)
      return
    }
    if (!state.connected || sessionId == null) {
      interaction = WearInteractionState.READY
      view.performHapticFeedback(HapticFeedbackConstants.REJECT)
      return
    }
    if (!viewModel.sendReply(message, context) { awaitingReplyRunId = it }) {
      interaction = WearInteractionState.READY
      view.performHapticFeedback(HapticFeedbackConstants.REJECT)
      return
    }
    expectedAssistantKey = snapshot.latestAssistantMessage()?.stableKey()
    awaitingReplySessionId = sessionId
    awaitingReplyContext = context
    awaitingReply = true
    interaction = WearInteractionState.SENDING
    speaker.stop()
  }

  val speechLauncher =
    rememberLauncherForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
      val transcript =
        result.data
          ?.getStringArrayListExtra(RecognizerIntent.EXTRA_RESULTS)
          ?.firstOrNull()
      if (result.resultCode == Activity.RESULT_OK && !transcript.isNullOrBlank()) {
        submitMessage(transcript)
      } else {
        inputContext = null
        interaction = WearInteractionState.READY
      }
    }
  val textLauncher =
    rememberLauncherForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
      val text =
        result.data
          ?.let(RemoteInput::getResultsFromIntent)
          ?.getCharSequence(REMOTE_INPUT_KEY)
          ?.toString()
      if (result.resultCode == Activity.RESULT_OK && !text.isNullOrBlank()) {
        submitMessage(text)
      } else {
        inputContext = null
        interaction = WearInteractionState.READY
      }
    }
  val sessionSearchLauncher =
    rememberLauncherForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
      val query =
        result.data
          ?.let(RemoteInput::getResultsFromIntent)
          ?.getCharSequence(REMOTE_INPUT_KEY)
          ?.toString()
      if (result.resultCode == Activity.RESULT_OK && !query.isNullOrBlank()) {
        viewModel.searchSessions(query)
      }
    }
  val modelSearchLauncher =
    rememberLauncherForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
      val query =
        result.data
          ?.let(RemoteInput::getResultsFromIntent)
          ?.getCharSequence(REMOTE_INPUT_KEY)
          ?.toString()
      if (result.resultCode == Activity.RESULT_OK && !query.isNullOrBlank()) {
        if (viewModel.validateConversationContext(modelSearchContext)) viewModel.searchModels(query)
      }
      modelSearchContext = null
    }

  fun launchSearchInput(
    title: String,
    launcher: ActivityResultLauncher<Intent>,
  ) {
    val remoteInput = RemoteInput.Builder(REMOTE_INPUT_KEY).setLabel(searchLabel).build()
    val intent =
      RemoteInputIntentHelper.createActionRemoteInputIntent().also { inputIntent ->
        RemoteInputIntentHelper.putRemoteInputsExtra(inputIntent, listOf(remoteInput))
        RemoteInputIntentHelper.putTitleExtra(inputIntent, title)
        RemoteInputIntentHelper.putConfirmLabelExtra(inputIntent, searchLabel)
      }
    launcher.launch(intent)
  }

  fun startRealtimeTalk(context: WearConversationContext?) {
    speaker.stop()
    if (!lifecycleOwner.lifecycle.currentState.isAtLeast(Lifecycle.State.RESUMED)) return
    microphoneGranted = ContextCompat.checkSelfPermission(view.context, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED
    if (!microphoneGranted) {
      microphoneDenied = true
      return
    }
    microphoneDenied = false
    viewModel.startRealtimeTalk(context)
  }

  fun leaveConversationContext() {
    awaitingReply = false
    awaitingReplySessionId = null
    awaitingReplyRunId = null
    expectedAssistantKey = null
    interaction = WearInteractionState.READY
    speaker.stop()
  }

  val audioPermissionLauncher =
    rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
      audioPermissionPending = false
      microphoneGranted = granted
      // Permission availability is not recording intent. A fresh tap starts Talk,
      // including after Settings or a dialog that outlived its conversation.
      microphoneDenied = !granted
      microphoneSettingsRequired = !granted && activity?.shouldShowRequestPermissionRationale(Manifest.permission.RECORD_AUDIO) == false
      if (!granted) view.performHapticFeedback(HapticFeedbackConstants.REJECT)
    }

  val notificationPermissionLauncher =
    rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
      notificationsGranted = granted
    }

  DisposableEffect(lifecycleOwner, view.context) {
    val observer =
      LifecycleEventObserver { _, event ->
        if (event == Lifecycle.Event.ON_RESUME) {
          val wasGranted = microphoneGranted
          microphoneGranted = ContextCompat.checkSelfPermission(view.context, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED
          if (microphoneGranted) {
            microphoneDenied = false
            microphoneSettingsRequired = false
          } else if (microphoneDenied || wasGranted) {
            microphoneDenied = true
            microphoneSettingsRequired = activity?.shouldShowRequestPermissionRationale(Manifest.permission.RECORD_AUDIO) == false
          }
          notificationsGranted =
            Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU ||
            ContextCompat.checkSelfPermission(view.context, Manifest.permission.POST_NOTIFICATIONS) ==
            PackageManager.PERMISSION_GRANTED
        }
        if (event == Lifecycle.Event.ON_PAUSE) {
          viewModel.cancelPendingRealtimeTalkStart()
        }
        if (event == Lifecycle.Event.ON_STOP) {
          speaker.stop()
          viewModel.suspendRealtimeTalk()
        }
      }
    lifecycleOwner.lifecycle.addObserver(observer)
    onDispose { lifecycleOwner.lifecycle.removeObserver(observer) }
  }

  fun toggleRealtimeTalk() {
    if (state.talkBusy || state.controlBusy) return
    if (state.realtimeTalk.active || state.realtimeCapturing) {
      viewModel.stopRealtimeTalk()
      return
    }
    if (!state.connected || state.selectedSession == null) return
    if (
      ContextCompat.checkSelfPermission(view.context, Manifest.permission.RECORD_AUDIO) ==
      PackageManager.PERMISSION_GRANTED
    ) {
      startRealtimeTalk(viewModel.captureConversationContext())
    } else {
      audioPermissionPending = true
      audioPermissionLauncher.launch(Manifest.permission.RECORD_AUDIO)
    }
  }

  LaunchedEffect(conversationContext) {
    speaker.stop()
  }

  WearReplyCompletionEffect(
    state = state,
    snapshot = snapshot,
    awaitingReply = awaitingReply,
    awaitingReplySessionId = awaitingReplySessionId,
    awaitingReplyRunId = awaitingReplyRunId,
    expectedAssistantKey = expectedAssistantKey,
    conversationContext = conversationContext,
    awaitingReplyContext = awaitingReplyContext,
  ) { reply ->
    awaitingReply = false
    awaitingReplySessionId = null
    awaitingReplyContext = null
    expectedAssistantKey = null
    interaction = WearInteractionState.READY
    if (reply != null) {
      view.performHapticFeedback(HapticFeedbackConstants.CONFIRM)
      if (autoSpeak && lifecycleOwner.lifecycle.currentState.isAtLeast(Lifecycle.State.RESUMED)) speaker.speak(reply.text)
    }
  }

  LaunchedEffect(snapshot?.realtimeTalk) {
    val next = snapshot
    realtimeThinkingTurnId =
      if (next == null) {
        null
      } else {
        nextRealtimeThinkingTurnId(previousRealtimeSnapshot, next, realtimeThinkingTurnId)
      }
    previousRealtimeSnapshot = next
  }
  LaunchedEffect(realtimeThinkingTurnId) {
    val turnId = realtimeThinkingTurnId ?: return@LaunchedEffect
    delay(MINIMUM_REALTIME_THINKING_VISIBLE_MILLIS)
    if (realtimeThinkingTurnId == turnId) {
      realtimeThinkingTurnId = null
    }
  }

  DisposableEffect(speaker) {
    onDispose(speaker::shutdown)
  }

  val failure =
    state.conversationFailure
      ?: WearConversationFailure.PHONE_UNAVAILABLE.takeIf {
        state.phoneNodeId == null && !state.loading
      }
  val resolvedInteraction =
    when {
      state.conversationFailure != null || speechFailed -> WearInteractionState.ERROR
      state.sending -> WearInteractionState.SENDING
      state.hasActiveStream || state.pendingReply?.retryable == false -> WearInteractionState.AGENT_WORKING
      else -> interaction
    }

  OpenClawWearTheme(themeMode = themeMode) {
    AppScaffold {
      OpenClawWearScreens(
        snapshot = snapshot,
        failure = failure,
        loading = state.loading,
        interaction = resolvedInteraction,
        speaking = speaking,
        speechFailed = speechFailed,
        realtimeCapturing = state.realtimeCapturing,
        realtimePlaying = state.realtimePlaying,
        realtimeStopping = state.talkStopping,
        realtimeMouthLevel = state.realtimeMouthLevel,
        realtimePlaybackFailed = state.realtimePlaybackFailed || speechFailed,
        microphonePermissionRequired = microphoneDenied && !microphoneGranted,
        microphoneSettingsRequired = microphoneSettingsRequired,
        onMicrophoneRecovery = {
          if (microphoneSettingsRequired && activity != null) {
            activity.startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, "package:${activity.packageName}".toUri()))
          } else {
            audioPermissionLauncher.launch(Manifest.permission.RECORD_AUDIO)
          }
        },
        realtimeThinkingOverride = realtimeThinkingTurnId != null,
        actionBusy =
          state.loading ||
            inputContext != null ||
            audioPermissionPending ||
            modelSearchContext != null ||
            state.sending ||
            state.talkBusy ||
            state.controlBusy ||
            state.hasActiveStream ||
            state.realtimeTalk.active ||
            state.realtimeCapturing ||
            state.realtimePlaying,
        inputEnabled = state.connected && snapshot?.activeSessionId != null && state.canSubmitReply,
        canAbort = state.hasActiveStream || state.pendingReply != null,
        themeMode = themeMode,
        autoSpeak = autoSpeak,
        notificationsGranted = notificationsGranted,
        initialPage = initialPage,
        navigationRequest = navigationRequest?.takeUnless { it.waitForConversation && (state.loading || state.talkBusy || state.realtimeTalk.active || state.realtimeCapturing || state.realtimePlaying) },
        onNavigationRequestHandled = onNavigationRequestHandled,
        onTalk = {
          if (!state.connected || snapshot?.activeSessionId == null) return@OpenClawWearScreens
          inputContext = viewModel.captureConversationContext()
          interaction = WearInteractionState.LISTENING
          val intent =
            Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH)
              .putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
              .putExtra(RecognizerIntent.EXTRA_LANGUAGE, Locale.getDefault().toLanguageTag())
              .putExtra(RecognizerIntent.EXTRA_PROMPT, speakPrompt)
          try {
            speechLauncher.launch(intent)
          } catch (_: ActivityNotFoundException) {
            inputContext = null
            interaction = WearInteractionState.ERROR
            view.performHapticFeedback(HapticFeedbackConstants.REJECT)
          }
        },
        onType = {
          if (!state.connected || snapshot?.activeSessionId == null) return@OpenClawWearScreens
          inputContext = viewModel.captureConversationContext()
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
                RemoteInputIntentHelper.putRemoteInputsExtra(inputIntent, listOf(remoteInput))
                RemoteInputIntentHelper.putTitleExtra(inputIntent, messageTitle)
                RemoteInputIntentHelper.putConfirmLabelExtra(inputIntent, sendLabel)
              }
          textLauncher.launch(intent)
        },
        onRealtimeTalk = ::toggleRealtimeTalk,
        onAbort = {
          speaker.stop()
          viewModel.abort()
        },
        onSelectAgent = { agentId ->
          leaveConversationContext()
          viewModel.selectAgent(agentId)
        },
        onSelectSession = { sessionKey ->
          (
            state.sessionSearchResults.firstOrNull { it.key == sessionKey }
              ?: state.sessions.firstOrNull { it.key == sessionKey }
          )?.let { session ->
            leaveConversationContext()
            viewModel.openSession(session)
          }
        },
        onSearchSessions = { launchSearchInput(sessionSearchTitle, sessionSearchLauncher) },
        onLoadMoreSessionSearch = viewModel::loadMoreSessionSearch,
        onClearSessionSearch = viewModel::clearSessionSearch,
        onSelectModel = { modelRef ->
          leaveConversationContext()
          viewModel.selectModel(modelRef)
        },
        onSearchModels = {
          modelSearchContext = viewModel.captureConversationContext()
          launchSearchInput(modelSearchTitle, modelSearchLauncher)
        },
        onClearModelSearch = viewModel::clearModelSearch,
        onAgentPulseVisibilityChanged = viewModel::setAgentPulseVisible,
        onAgentPulseRefresh = viewModel::refreshAgentPulse,
        onRefresh = viewModel::refresh,
        onGatewayEnabledChange = { enabled ->
          speaker.stop()
          viewModel.setGatewayEnabled(enabled)
        },
        onThemeModeChange = { selectedMode ->
          themeMode = selectedMode
          settingsStore.writeThemeMode(selectedMode)
        },
        onAutoSpeakChange = { enabled ->
          autoSpeak = enabled
          settingsStore.writeAutoSpeak(enabled)
          if (!enabled) speaker.stop()
        },
        onRequestNotifications = {
          if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            notificationPermissionLauncher.launch(Manifest.permission.POST_NOTIFICATIONS)
          }
        },
        onOpenNotificationSettings = {
          if (activity != null) {
            val notificationSettings =
              Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS)
                .putExtra(Settings.EXTRA_APP_PACKAGE, activity.packageName)
            try {
              activity.startActivity(notificationSettings)
            } catch (_: ActivityNotFoundException) {
              activity.startActivity(
                Intent(
                  Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                  "package:${activity.packageName}".toUri(),
                ),
              )
            }
          }
        },
        onSpeakLatest = {
          if (lifecycleOwner.lifecycle.currentState.isAtLeast(Lifecycle.State.RESUMED)) {
            snapshot.latestAssistantMessage()?.text?.let(speaker::speak)
          }
        },
        onStopSpeaking = speaker::stop,
      )
    }
  }
}

@Composable
internal fun WearReplyCompletionEffect(
  state: WearUiState,
  snapshot: WearConversationSnapshot?,
  awaitingReply: Boolean,
  awaitingReplySessionId: String?,
  expectedAssistantKey: String?,
  awaitingReplyRunId: String? = null,
  conversationContext: WearConversationContext? = null,
  awaitingReplyContext: WearConversationContext? = null,
  onCompleted: (WearChatMessage?) -> Unit,
) {
  val complete by rememberUpdatedState(onCompleted)
  LaunchedEffect(
    conversationContext,
    awaitingReplyContext,
    snapshot?.activeSessionId,
    state.messages,
    state.activeRunId,
    state.streamText,
    state.sending,
    state.failure,
    state.pendingReply,
    state.replyTerminal,
    state.replyCompletion,
    state.pendingAbortRunId,
    awaitingReply,
    awaitingReplySessionId,
    expectedAssistantKey,
    awaitingReplyRunId,
  ) {
    if (!awaitingReply) return@LaunchedEffect
    if (snapshot == null || snapshot.activeSessionId != awaitingReplySessionId || conversationContext != awaitingReplyContext) {
      complete(null)
      return@LaunchedEffect
    }
    // Gateway can emit the terminal before replying to the matching Abort RPC.
    // Wait for that recorded operation result, without discarding reply ownership.
    if (awaitingReplyRunId != null && state.pendingAbortRunId == awaitingReplyRunId) return@LaunchedEffect
    val terminal = state.replyCompletion ?: state.replyTerminal
    val ownsPending = awaitingReplyRunId != null && state.pendingReply?.runId == awaitingReplyRunId
    val ownsTerminal = awaitingReplyRunId != null && terminal?.runId == awaitingReplyRunId
    if (ownsTerminal && terminal.outcome == WearReplyOutcome.Canceled) {
      complete(null)
      return@LaunchedEffect
    }
    // An Abort/history/control failure does not end the still-owned logical send.
    if (state.failure != null && !ownsPending && !ownsTerminal) {
      complete(null)
      return@LaunchedEffect
    }
    if (state.sending || state.hasActiveStream || state.pendingReply != null) return@LaunchedEffect
    // Preserved foreign finals are not evidence for this reply. The terminal
    // history must reconcile the transcript before choosing text to confirm or speak.
    if (terminal != null && terminal.history == null) return@LaunchedEffect
    if (awaitingReplyRunId != null && terminal?.runId != null && terminal.runId != awaitingReplyRunId) {
      complete(null)
      return@LaunchedEffect
    }
    val confirmationRunId = awaitingReplyRunId ?: terminal?.runId
    val ownedMessage =
      if (terminal == null && confirmationRunId == null) {
        snapshot.latestAssistantMessage()
      } else {
        confirmationRunId?.let { runId ->
          snapshot.messages.lastOrNull { it.replyOutcomeForRun(runId) != null }
        } ?: terminal?.message?.takeIf { it.role == "assistant" }
      }
    val reply =
      newAssistantReplyForSession(
        awaitingSessionId = awaitingReplySessionId,
        activeSessionId = snapshot.activeSessionId,
        expectedAssistantKey = expectedAssistantKey,
        latestAssistantMessage = ownedMessage,
      )
    if (reply != null || terminal?.history != null) complete(reply)
  }
}

private fun WearConversationSnapshot?.latestAssistantMessage(): WearChatMessage? =
  this
    ?.messages
    ?.lastOrNull { message ->
      message.chatRole == WearChatRole.ASSISTANT && message.text.isNotBlank()
    }

private fun WearChatMessage.stableKey(): String = id ?: role + ":" + timestamp + ":" + text.hashCode()

internal fun newAssistantReplyForSession(
  awaitingSessionId: String?,
  activeSessionId: String?,
  expectedAssistantKey: String?,
  latestAssistantMessage: WearChatMessage?,
): WearChatMessage? =
  latestAssistantMessage?.takeIf { message ->
    awaitingSessionId != null &&
      awaitingSessionId == activeSessionId &&
      message.stableKey() != expectedAssistantKey
  }

internal fun nextRealtimeThinkingTurnId(
  previous: WearConversationSnapshot?,
  next: WearConversationSnapshot,
  currentTurnId: String?,
): String? {
  if (!next.realtimeTalk.active) return null
  return newlyCompletedRealtimeUserTurnId(previous, next) ?: currentTurnId
}

internal fun newlyCompletedRealtimeUserTurnId(
  previous: WearConversationSnapshot?,
  next: WearConversationSnapshot,
): String? {
  if (previous?.realtimeTalk?.active != true || !next.realtimeTalk.active) return null
  val previousFinalUserTurnIds =
    previous.realtimeTalk.conversation
      .asSequence()
      .filter { entry -> entry.role == WearRealtimeTalkRole.USER && !entry.streaming }
      .map { entry -> entry.id }
      .toSet()
  return next.realtimeTalk.conversation
    .lastOrNull { entry ->
      entry.role == WearRealtimeTalkRole.USER &&
        !entry.streaming &&
        entry.id !in previousFinalUserTurnIds
    }?.id
}

internal const val REPLY_RESULT_KEY = "openclaw_watch_message"
private const val REMOTE_INPUT_KEY = REPLY_RESULT_KEY
private const val MINIMUM_REALTIME_THINKING_VISIBLE_MILLIS = 900L
