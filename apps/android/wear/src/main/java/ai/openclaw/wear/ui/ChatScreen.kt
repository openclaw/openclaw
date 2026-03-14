package ai.openclaw.wear.ui

import android.app.RemoteInput
import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.speech.RecognizerIntent
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.Orientation
import androidx.compose.foundation.gestures.scrollable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxScope
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material.icons.filled.South
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.wear.compose.foundation.lazy.ScalingLazyColumn
import androidx.wear.compose.foundation.lazy.ScalingLazyColumnDefaults
import androidx.wear.compose.foundation.lazy.items
import androidx.wear.compose.foundation.lazy.rememberScalingLazyListState
import androidx.wear.compose.foundation.pager.HorizontalPager
import androidx.wear.compose.foundation.pager.rememberPagerState
import androidx.wear.compose.material3.AppScaffold
import androidx.wear.compose.material3.Button
import androidx.wear.compose.material3.ButtonDefaults
import androidx.wear.compose.material3.EdgeButton
import androidx.wear.compose.material3.EdgeButtonSize
import androidx.wear.compose.material3.FilledIconButton
import androidx.wear.compose.material3.HorizontalPageIndicator
import androidx.wear.compose.material3.Icon
import androidx.wear.compose.material3.MaterialTheme
import androidx.wear.compose.material3.PagerScaffoldDefaults
import androidx.wear.compose.material3.ScreenScaffold
import androidx.wear.compose.material3.Text
import androidx.wear.compose.material3.TimeText
import androidx.wear.compose.material3.AnimatedPage
import androidx.wear.tooling.preview.devices.WearDevices
import ai.openclaw.wear.R
import ai.openclaw.wear.WearViewModel
import ai.openclaw.wear.audio.WearReplySpeaker
import ai.openclaw.wear.chat.WearChatMessage
import ai.openclaw.wear.gateway.WearGatewayConfig
import ai.openclaw.wear.gateway.WearReplyAction
import ai.openclaw.wear.gateway.WearScreenAwakeMode
import java.util.Locale
import kotlinx.coroutines.launch

private const val INPUT_KEY = "wear_chat_input"
private const val ChatPageCount = 2
private const val TranscriptPageIndex = 0
private val ChatPagerIndicatorTopPadding = 20.dp
private val ChatTranscriptScalingParams =
  ScalingLazyColumnDefaults.scalingParams(
    edgeScale = 1f,
    edgeAlpha = 1f,
    minTransitionArea = 0f,
    maxTransitionArea = 0f,
    viewportVerticalOffsetResolver = { 0 },
  )

@Composable
fun ChatScreen(
  viewModel: WearViewModel,
  onNavigateToSessions: () -> Unit,
  onNavigateToChatSettings: () -> Unit,
  onNavigateToConnectionSettings: () -> Unit,
  autoLaunchAction: WearReplyAction? = null,
  onLaunchActionHandled: () -> Unit = {},
) {
  val context = LocalContext.current
  val view = LocalView.current
  val messages by viewModel.messages.collectAsState()
  val streamingText by viewModel.streamingText.collectAsState()
  val connected by viewModel.connected.collectAsState()
  val statusText by viewModel.statusText.collectAsState()
  val errorText by viewModel.errorText.collectAsState()
  val isLoading by viewModel.isLoading.collectAsState()
  val isSending by viewModel.isSending.collectAsState()
  val sessionKey by viewModel.sessionKey.collectAsState()
  val sessions by viewModel.sessions.collectAsState()
  val config by viewModel.config.collectAsState()
  val speaker = remember(context) { WearReplySpeaker(context) }
  val latestTtsEnabled by rememberUpdatedState(config.nativeTtsEnabled)

  DisposableEffect(speaker) {
    onDispose { speaker.shutdown() }
  }

  val inputLauncher =
    rememberLauncherForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
      result.data?.let { data ->
        val results = RemoteInput.getResultsFromIntent(data)
        val text = results?.getCharSequence(INPUT_KEY)?.toString()
        if (!text.isNullOrBlank()) {
          viewModel.sendMessage(text)
        }
      }
    }

  val voiceLauncher =
    rememberLauncherForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
      val text =
        result.data
          ?.getStringArrayListExtra(RecognizerIntent.EXTRA_RESULTS)
          ?.firstOrNull()
          ?.trim()
      if (!text.isNullOrBlank()) {
        viewModel.sendMessage(text)
      }
    }

  LaunchedEffect(viewModel, speaker) {
    viewModel.assistantReplies.collect { reply ->
      if (latestTtsEnabled) {
        speaker.speak(reply)
      }
    }
  }

  val executeReply = {
    launchReplyAction(
      action = config.defaultReplyAction,
      inputLauncher = { launchTextInput(context, inputLauncher) },
      voiceLauncher = { launchVoiceInput(context, voiceLauncher, inputLauncher) },
    )
  }

  LaunchedEffect(autoLaunchAction) {
    val action = autoLaunchAction ?: return@LaunchedEffect
    onLaunchActionHandled()
    launchReplyAction(
      action = action,
      inputLauncher = { launchTextInput(context, inputLauncher) },
      voiceLauncher = { launchVoiceInput(context, voiceLauncher, inputLauncher) },
    )
  }

  val listState = rememberScalingLazyListState()
  val menuListState = rememberScalingLazyListState()
  val pagerState = rememberPagerState(pageCount = { ChatPageCount })
  val scope = rememberCoroutineScope()
  val lifecycleOwner = LocalLifecycleOwner.current
  val needsGatewaySetup = !config.usePhoneProxy && !config.isValid
  val showEmptyState = messages.isEmpty()
  val showStatusHeader = showEmptyState || isLoading
  val sessionDisplayName =
    remember(sessions, sessionKey) {
      sessions.firstOrNull { it.key == sessionKey }?.displayName?.takeIf { it.isNotBlank() }
        ?: sessionKey
    }
  val lastContentItemIndex =
    remember(messages.size, streamingText, isSending, needsGatewaySetup, connected, isLoading, showStatusHeader) {
      chatLatestAnchorIndex(
        showHeader = showStatusHeader,
        messageCount = messages.size,
        hasStreamingText = !streamingText.isNullOrBlank(),
        isSending = isSending,
        showSetupRequired = showEmptyState && needsGatewaySetup,
        showDisconnectedEmpty = showEmptyState && !needsGatewaySetup && !connected,
        showLoadingEmpty = showEmptyState && !needsGatewaySetup && connected && isLoading,
        showPromptEmpty = showEmptyState && !needsGatewaySetup && connected && !isLoading,
      )
    }
  var followLatest by rememberSaveable(sessionKey) { mutableStateOf(true) }
  val lastVisibleIndex by remember(listState) {
    derivedStateOf {
      listState.layoutInfo.visibleItemsInfo.lastOrNull()?.index ?: -1
    }
  }
  val totalItemsCount by remember(listState) {
    derivedStateOf { listState.layoutInfo.totalItemsCount }
  }
  val atLatest by remember(lastVisibleIndex, lastContentItemIndex) {
    derivedStateOf { lastVisibleIndex >= lastContentItemIndex }
  }
  var pendingInitialScrollToLatest by rememberSaveable(sessionKey) { mutableStateOf(true) }

  LaunchedEffect(lastVisibleIndex) {
    followLatest = lastVisibleIndex >= lastContentItemIndex
  }

  LaunchedEffect(lastContentItemIndex, followLatest) {
    if (!followLatest) return@LaunchedEffect
    listState.scrollToItem(lastContentItemIndex)
  }

  LaunchedEffect(totalItemsCount, lastContentItemIndex, pendingInitialScrollToLatest) {
    if (!pendingInitialScrollToLatest) return@LaunchedEffect
    if (totalItemsCount <= lastContentItemIndex || lastContentItemIndex < 0) return@LaunchedEffect
    listState.scrollToItem(lastContentItemIndex)
    followLatest = true
    pendingInitialScrollToLatest = false
  }

  val showScrollToLatest = !atLatest && lastContentItemIndex > 0
  val shouldKeepScreenOn =
    remember(config.screenAwakeMode, isSending, streamingText) {
      when (config.screenAwakeMode) {
        WearScreenAwakeMode.DEFAULT -> false
        WearScreenAwakeMode.WHILE_WAITING -> isSending || !streamingText.isNullOrBlank()
        WearScreenAwakeMode.ALWAYS -> true
      }
    }
  DisposableEffect(view, shouldKeepScreenOn) {
    val previousKeepScreenOn = view.keepScreenOn
    view.keepScreenOn = shouldKeepScreenOn
    onDispose {
      view.keepScreenOn = previousKeepScreenOn
    }
  }

  LaunchedEffect(sessionKey) {
    followLatest = true
    pendingInitialScrollToLatest = true
    pagerState.scrollToPage(TranscriptPageIndex)
  }

  DisposableEffect(lifecycleOwner, pagerState, sessionKey) {
    val observer =
      LifecycleEventObserver { _, event ->
        if (event == Lifecycle.Event.ON_RESUME) {
          followLatest = true
          pendingInitialScrollToLatest = true
          scope.launch { pagerState.scrollToPage(TranscriptPageIndex) }
        }
      }
    lifecycleOwner.lifecycle.addObserver(observer)
    onDispose {
      lifecycleOwner.lifecycle.removeObserver(observer)
    }
  }

  Box(modifier = Modifier.fillMaxSize()) {
    HorizontalPager(
      state = pagerState,
      modifier = Modifier.fillMaxSize(),
      flingBehavior = PagerScaffoldDefaults.snapWithSpringFlingBehavior(state = pagerState),
      rotaryScrollableBehavior = null,
    ) { page ->
      AnimatedPage(pageIndex = page, pagerState = pagerState) {
        when (page) {
          TranscriptPageIndex ->
            ChatTranscriptPage(
              listState = listState,
              messages = messages,
              streamingText = streamingText,
              connected = connected,
              statusText = statusText,
              isLoading = isLoading,
              isSending = isSending,
              sessionKey = sessionKey,
              config = config,
              showStatusHeader = showStatusHeader,
              needsGatewaySetup = needsGatewaySetup,
              showScrollToLatest = showScrollToLatest,
              showStartupOverlay = isLoading && messages.isEmpty() && !needsGatewaySetup,
              onPrimaryAction = {
                if (showScrollToLatest) {
                  followLatest = true
                  pendingInitialScrollToLatest = false
                  scope.launch { listState.scrollToItem(lastContentItemIndex) }
                } else {
                  executeReply()
                }
              },
              onOpenSetupSettings = onNavigateToConnectionSettings,
            )

          else ->
            ChatActionsPage(
              listState = menuListState,
              connected = connected,
              statusText = statusText,
              sessionKey = sessionKey,
              sessionDisplayName = sessionDisplayName,
              config = config,
              onNavigateToSessions = onNavigateToSessions,
              onNavigateToChatSettings = onNavigateToChatSettings,
              onNavigateToConnectionSettings = onNavigateToConnectionSettings,
              onDisconnect = viewModel::disconnect,
              onReconnect = viewModel::reconnect,
            )
        }
      }
    }
    HorizontalPageIndicator(
      pagerState = pagerState,
      modifier =
        Modifier
          .align(Alignment.TopCenter)
          .padding(top = ChatPagerIndicatorTopPadding),
    )

    if (errorText != null) {
      Dialog(onDismissRequest = { viewModel.clearError() }) {
        Column(
          modifier =
            Modifier
              .fillMaxSize()
              .background(MaterialTheme.colorScheme.background)
              .padding(16.dp),
          verticalArrangement = Arrangement.Center,
          horizontalAlignment = Alignment.CenterHorizontally,
        ) {
          Text(
            text = errorText ?: "",
            color = MaterialTheme.colorScheme.error,
            style = MaterialTheme.typography.bodySmall,
            textAlign = TextAlign.Center,
            modifier = Modifier.fillMaxWidth(),
          )
          Spacer(modifier = Modifier.height(12.dp))
          FilledIconButton(onClick = { viewModel.clearError() }) {
            Icon(
              imageVector = Icons.Filled.Check,
              contentDescription = stringResource(R.string.wear_chat_dismiss),
              modifier = Modifier.size(18.dp),
            )
          }
        }
      }
    }
  }
}

@Composable
private fun ChatTranscriptPage(
  listState: androidx.wear.compose.foundation.lazy.ScalingLazyListState,
  messages: List<WearChatMessage>,
  streamingText: String?,
  connected: Boolean,
  statusText: String,
  isLoading: Boolean,
  isSending: Boolean,
  sessionKey: String,
  config: WearGatewayConfig,
  showStatusHeader: Boolean,
  needsGatewaySetup: Boolean,
  showScrollToLatest: Boolean,
  showStartupOverlay: Boolean,
  onPrimaryAction: () -> Unit,
  onOpenSetupSettings: () -> Unit,
) {
  Box(modifier = Modifier.fillMaxSize()) {
    ScreenScaffold(
      scrollState = listState,
      edgeButton = {
        ChatReplyEdgeButton(
          listState = listState,
          connected = connected,
          showScrollToLatest = showScrollToLatest,
          onClick = onPrimaryAction,
        )
      },
    ) { contentPadding ->
      ScalingLazyColumn(
        state = listState,
        modifier = Modifier.fillMaxSize(),
        autoCentering = null,
        scalingParams = ChatTranscriptScalingParams,
        contentPadding = contentPadding,
        verticalArrangement = Arrangement.spacedBy(4.dp),
      ) {
        if (showStatusHeader) {
          item(key = "header") {
            ConnectionHeader(
              connected = connected,
              statusText = statusText,
              sessionKey = sessionKey,
              replyAction = config.defaultReplyAction,
              nativeTtsEnabled = config.nativeTtsEnabled,
            )
          }
        }

        if (messages.isEmpty() && needsGatewaySetup) {
          item(key = "setup-required") {
            SetupRequiredState(onOpenSettings = onOpenSetupSettings)
          }
        } else if (messages.isEmpty() && !connected) {
          item(key = "empty-disconnected") {
            EmptyState(text = stringResource(R.string.wear_chat_not_connected))
          }
        } else if (messages.isEmpty() && isLoading) {
          item(key = "empty-loading") {
            EmptyState(text = stringResource(R.string.wear_chat_loading))
          }
        } else if (messages.isEmpty()) {
          item(key = "empty") {
            EmptyState(text = stringResource(R.string.wear_chat_empty))
          }
        }

        items(messages, key = { it.id }) { msg ->
          MessageBubble(msg)
        }

        if (!streamingText.isNullOrBlank()) {
          item(key = "streaming") {
            StreamingBubble(text = streamingText)
          }
        }

        if (isSending && streamingText.isNullOrBlank()) {
          item(key = "typing") {
            TypingIndicator()
          }
        }

        item(key = "latest-anchor") {
          Spacer(modifier = Modifier.height(1.dp))
        }
      }
    }

    if (showScrollToLatest) {
      FilledIconButton(
        onClick = onPrimaryAction,
        modifier =
          Modifier
            .align(Alignment.BottomCenter)
            .padding(bottom = 8.dp)
            .size(40.dp),
      ) {
        Icon(
          imageVector = Icons.Filled.South,
          contentDescription = stringResource(R.string.wear_chat_scroll_latest_content_description),
          modifier = Modifier.size(18.dp),
        )
      }
    }

    if (showStartupOverlay) {
      StartupLoadingOverlay(statusText = statusText)
    }
  }
}

@Composable
private fun BoxScope.ChatReplyEdgeButton(
  listState: androidx.wear.compose.foundation.lazy.ScalingLazyListState,
  connected: Boolean,
  showScrollToLatest: Boolean,
  onClick: () -> Unit,
) {
  EdgeButton(
    modifier =
      Modifier
        .align(Alignment.BottomCenter)
        .scrollable(
          state = listState,
          orientation = Orientation.Vertical,
          reverseDirection = true,
          overscrollEffect = androidx.compose.foundation.rememberOverscrollEffect(),
        ),
    onClick = onClick,
    buttonSize = EdgeButtonSize.Small,
    enabled = showScrollToLatest || connected,
  ) {
    if (showScrollToLatest) {
      Text(stringResource(R.string.wear_chat_latest))
    } else {
      Text(stringResource(R.string.wear_chat_reply))
    }
  }
}

@Composable
private fun ChatActionsPage(
  listState: androidx.wear.compose.foundation.lazy.ScalingLazyListState,
  connected: Boolean,
  statusText: String,
  sessionKey: String,
  sessionDisplayName: String,
  config: WearGatewayConfig,
  onNavigateToSessions: () -> Unit,
  onNavigateToChatSettings: () -> Unit,
  onNavigateToConnectionSettings: () -> Unit,
  onDisconnect: () -> Unit,
  onReconnect: () -> Unit,
) {
  val statusTone =
    when {
      connected -> WearStatusTone.CONNECTED
      config.usePhoneProxy || config.isValid -> WearStatusTone.ATTENTION
      else -> WearStatusTone.ERROR
    }

  ScreenScaffold(scrollState = listState) { contentPadding ->
    ScalingLazyColumn(
      state = listState,
      modifier = Modifier.fillMaxSize(),
      contentPadding = contentPadding,
      verticalArrangement = Arrangement.spacedBy(8.dp),
      horizontalAlignment = Alignment.CenterHorizontally,
    ) {
      item(key = "menu-spacer-top") {
        Spacer(modifier = Modifier.height(8.dp))
      }

      item(key = "status") {
        StatusCard(
          statusTone = statusTone,
          statusText = statusText,
        )
      }

      item(key = "sessions-header") {
        ChatSectionHeader(text = stringResource(R.string.wear_chat_change_session))
      }

      item(key = "sessions") {
        SessionSummaryButton(
          sessionDisplayName = sessionDisplayName,
          sessionKey = sessionKey,
          onClick = onNavigateToSessions,
        )
      }

      item(key = "settings-header") {
        ChatSectionHeader(text = stringResource(R.string.wear_chat_settings))
      }

      item(key = "behavior") {
        SettingsNavButton(
          label = stringResource(R.string.wear_chat_behavior),
          onClick = onNavigateToChatSettings,
        )
      }

      item(key = "connection") {
        SettingsNavButton(
          label = stringResource(R.string.wear_chat_connection),
          onClick = onNavigateToConnectionSettings,
        )
      }

      if (connected) {
        item(key = "disconnect") {
          Button(
            onClick = onDisconnect,
            modifier =
              Modifier
                .fillMaxWidth()
                .padding(horizontal = 12.dp),
            colors =
              ButtonDefaults.buttonColors(
                containerColor = MaterialTheme.colorScheme.errorContainer,
                contentColor = MaterialTheme.colorScheme.onErrorContainer,
              ),
            label = {
              Text(stringResource(R.string.wear_chat_disconnect))
            },
          )
        }
      } else {
        item(key = "reconnect") {
          Button(
            onClick = onReconnect,
            modifier =
              Modifier
                .fillMaxWidth()
                .padding(horizontal = 12.dp),
            label = {
              Text(stringResource(R.string.wear_chat_reconnect))
            },
          )
        }
      }
    }
  }
}

@Composable
private fun ChatSectionHeader(text: String) {
  Text(
    text = text,
    style = MaterialTheme.typography.titleSmall,
    color = MaterialTheme.colorScheme.primary,
    modifier =
      Modifier
        .fillMaxWidth()
        .padding(horizontal = 20.dp, vertical = 2.dp),
  )
}

@Composable
private fun SessionSummaryButton(
  sessionDisplayName: String,
  sessionKey: String,
  onClick: () -> Unit,
) {
  Button(
    onClick = onClick,
    modifier =
      Modifier
        .fillMaxWidth()
        .padding(horizontal = 12.dp),
    colors = ButtonDefaults.filledTonalButtonColors(),
    label = {
      Text(
        text = sessionDisplayName,
        maxLines = 2,
        overflow = TextOverflow.Ellipsis,
      )
    },
    secondaryLabel = {
      Text(
        text = sessionKey,
        maxLines = 4,
        overflow = TextOverflow.Clip,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
      )
    },
  )
}

@Composable
private fun StartupLoadingOverlay(statusText: String) {
  Box(
    modifier =
      Modifier
        .fillMaxSize()
        .background(MaterialTheme.colorScheme.background.copy(alpha = 0.9f)),
    contentAlignment = Alignment.Center,
  ) {
    Column(
      modifier =
        Modifier
          .padding(horizontal = 20.dp)
          .clip(RoundedCornerShape(20.dp))
          .background(MaterialTheme.colorScheme.surfaceContainer)
          .padding(horizontal = 16.dp, vertical = 14.dp),
      horizontalAlignment = Alignment.CenterHorizontally,
      verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
      Text(
        text = stringResource(R.string.wear_chat_opening),
        style = MaterialTheme.typography.titleSmall,
        textAlign = TextAlign.Center,
      )
      Text(
        text = statusText,
        style = MaterialTheme.typography.bodySmall,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
        textAlign = TextAlign.Center,
      )
    }
  }
}

@Composable
private fun ConnectionHeader(
  connected: Boolean,
  statusText: String,
  sessionKey: String,
  replyAction: WearReplyAction,
  nativeTtsEnabled: Boolean,
) {
  Column(
    modifier =
      Modifier
        .fillMaxWidth()
        .padding(horizontal = 16.dp, vertical = 4.dp)
        .clip(RoundedCornerShape(18.dp))
        .background(MaterialTheme.colorScheme.surfaceContainer)
        .padding(horizontal = 14.dp, vertical = 10.dp),
    horizontalAlignment = Alignment.CenterHorizontally,
  ) {
    Row(
      verticalAlignment = Alignment.CenterVertically,
      horizontalArrangement = Arrangement.Center,
    ) {
      Box(
        modifier =
          Modifier
            .size(6.dp)
            .clip(CircleShape)
            .background(if (connected) Color(0xFF58D68D) else Color(0xFFFF6B57)),
      )
      Spacer(modifier = Modifier.width(6.dp))
      Text(
        text = statusText,
        style = MaterialTheme.typography.labelSmall,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
      )
    }
    Spacer(modifier = Modifier.height(4.dp))
    Text(
      text =
        when (replyAction) {
          WearReplyAction.VOICE ->
            if (nativeTtsEnabled) {
              stringResource(R.string.wear_chat_voice_in_voice_out)
            } else {
              stringResource(R.string.wear_chat_voice_in_silent_out)
            }
          WearReplyAction.TEXT ->
            if (nativeTtsEnabled) {
              stringResource(R.string.wear_chat_text_in_voice_out)
            } else {
              stringResource(R.string.wear_chat_text_in_silent_out)
            }
        },
      style = MaterialTheme.typography.labelSmall,
      color = MaterialTheme.colorScheme.primary,
      textAlign = TextAlign.Center,
    )
    if (sessionKey != "main") {
      Spacer(modifier = Modifier.height(2.dp))
      Text(
        text = sessionKey,
        style = MaterialTheme.typography.labelSmall,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
        maxLines = 1,
        overflow = TextOverflow.Ellipsis,
      )
    }
  }
}

@Composable
private fun EmptyState(text: String) {
  Text(
    text = text,
    style = MaterialTheme.typography.bodySmall,
    textAlign = TextAlign.Center,
    color = MaterialTheme.colorScheme.onSurfaceVariant,
    modifier =
      Modifier
        .fillMaxWidth()
        .padding(horizontal = 20.dp, vertical = 16.dp),
  )
}

@Composable
private fun SetupRequiredState(
  onOpenSettings: () -> Unit,
) {
  Column(
    modifier =
      Modifier
        .fillMaxWidth()
        .padding(horizontal = 16.dp, vertical = 16.dp)
        .clip(RoundedCornerShape(18.dp))
        .background(MaterialTheme.colorScheme.surfaceContainer)
        .padding(horizontal = 14.dp, vertical = 14.dp),
    horizontalAlignment = Alignment.CenterHorizontally,
    verticalArrangement = Arrangement.spacedBy(10.dp),
  ) {
    Text(
      text = stringResource(R.string.wear_chat_setup_required),
      style = MaterialTheme.typography.bodySmall,
      textAlign = TextAlign.Center,
      color = MaterialTheme.colorScheme.onSurface,
    )
    FilledIconButton(onClick = onOpenSettings) {
      Icon(
        imageVector = Icons.Filled.Settings,
        contentDescription = stringResource(R.string.wear_chat_open_settings),
        modifier = Modifier.size(18.dp),
      )
    }
  }
}

@Composable
private fun MessageBubble(msg: WearChatMessage) {
  val isUser = msg.role == "user"
  val bgColor =
    if (isUser) {
      MaterialTheme.colorScheme.primaryContainer
    } else {
      MaterialTheme.colorScheme.surfaceContainer
    }
  val textColor =
    if (isUser) {
      MaterialTheme.colorScheme.onPrimaryContainer
    } else {
      MaterialTheme.colorScheme.onSurface
    }

  Row(
    modifier =
      Modifier
        .fillMaxWidth()
        .padding(horizontal = 8.dp),
    horizontalArrangement = if (isUser) Arrangement.End else Arrangement.Start,
  ) {
    Box(
      modifier =
        Modifier
          .clip(
            RoundedCornerShape(
              topStart = 12.dp,
              topEnd = 12.dp,
              bottomStart = if (isUser) 12.dp else 4.dp,
              bottomEnd = if (isUser) 4.dp else 12.dp,
            ),
          )
          .background(bgColor)
          .padding(horizontal = 10.dp, vertical = 6.dp)
          .fillMaxWidth(0.86f),
    ) {
      Text(
        text = msg.text,
        style = MaterialTheme.typography.bodySmall,
        color = textColor,
      )
    }
  }
}

@Composable
private fun StreamingBubble(text: String) {
  val infiniteTransition = rememberInfiniteTransition(label = "stream")
  val alpha by
    infiniteTransition.animateFloat(
      initialValue = 0.7f,
      targetValue = 1f,
      animationSpec =
        infiniteRepeatable(
          animation = tween(600),
          repeatMode = RepeatMode.Reverse,
        ),
      label = "pulse",
    )

  Row(
    modifier =
      Modifier
        .fillMaxWidth()
        .padding(horizontal = 8.dp),
    horizontalArrangement = Arrangement.Start,
  ) {
    Box(
      modifier =
        Modifier
          .clip(RoundedCornerShape(12.dp, 12.dp, 12.dp, 4.dp))
          .background(MaterialTheme.colorScheme.surfaceContainer)
          .padding(horizontal = 10.dp, vertical = 6.dp)
          .fillMaxWidth(0.86f)
          .alpha(alpha),
    ) {
      Text(
        text = text,
        style = MaterialTheme.typography.bodySmall,
        color = MaterialTheme.colorScheme.onSurface,
      )
    }
  }
}

@Composable
private fun TypingIndicator() {
  val infiniteTransition = rememberInfiniteTransition(label = "dots")
  val alpha by
    infiniteTransition.animateFloat(
      initialValue = 0.3f,
      targetValue = 1f,
      animationSpec =
        infiniteRepeatable(
          animation = tween(500),
          repeatMode = RepeatMode.Reverse,
        ),
      label = "dotsAlpha",
    )

  Row(
    modifier =
      Modifier
        .fillMaxWidth()
        .padding(horizontal = 8.dp),
    horizontalArrangement = Arrangement.Start,
  ) {
    Box(
      modifier =
        Modifier
          .clip(RoundedCornerShape(12.dp, 12.dp, 12.dp, 4.dp))
          .background(MaterialTheme.colorScheme.surfaceContainer)
          .padding(horizontal = 12.dp, vertical = 8.dp),
    ) {
      Row(
        horizontalArrangement = Arrangement.spacedBy(4.dp),
        modifier = Modifier.alpha(alpha),
      ) {
        repeat(3) {
          Box(
            modifier =
              Modifier
                .size(6.dp)
                .clip(CircleShape)
                .background(MaterialTheme.colorScheme.onSurfaceVariant),
          )
        }
      }
    }
  }
}

private fun launchReplyAction(
  action: WearReplyAction,
  inputLauncher: () -> Unit,
  voiceLauncher: () -> Unit,
) {
  when (action) {
    WearReplyAction.VOICE -> voiceLauncher()
    WearReplyAction.TEXT -> inputLauncher()
  }
}

private fun launchTextInput(
  context: Context,
  inputLauncher: androidx.activity.result.ActivityResultLauncher<Intent>,
) {
  val remoteInputs =
    listOf(
      RemoteInput.Builder(INPUT_KEY)
        .setLabel(context.getString(R.string.wear_chat_input_label_reply))
        .build(),
    )
  val wearIntent = androidx.wear.input.RemoteInputIntentHelper.createActionRemoteInputIntent()
  androidx.wear.input.RemoteInputIntentHelper.putRemoteInputsExtra(wearIntent, remoteInputs)
  inputLauncher.launch(wearIntent)
}

private fun launchVoiceInput(
  context: Context,
  voiceLauncher: androidx.activity.result.ActivityResultLauncher<Intent>,
  fallbackLauncher: androidx.activity.result.ActivityResultLauncher<Intent>,
) {
  val intent =
    Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
      putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
      putExtra(RecognizerIntent.EXTRA_PROMPT, context.getString(R.string.wear_chat_voice_prompt))
      putExtra(RecognizerIntent.EXTRA_LANGUAGE, Locale.getDefault())
    }
  val canHandle = intent.resolveActivity(context.packageManager) != null
  if (!canHandle) {
    launchTextInput(context, fallbackLauncher)
    return
  }
  try {
    voiceLauncher.launch(intent)
  } catch (_: ActivityNotFoundException) {
    launchTextInput(context, fallbackLauncher)
  }
}

private fun previewMessages(): List<WearChatMessage> =
  listOf(
    WearChatMessage(
      id = "assistant-1",
      role = "assistant",
      text = "Morning. I pulled the latest session and queued the proxy reconnect.",
      timestampMs = 1_000,
    ),
    WearChatMessage(
      id = "user-1",
      role = "user",
      text = "Good. Can you start voice mode from the watch tile?",
      timestampMs = 2_000,
    ),
    WearChatMessage(
      id = "assistant-2",
      role = "assistant",
      text = "Yes. The tile launches directly into the current conversation and can trigger voice input.",
      timestampMs = 3_000,
    ),
  )

@Preview(device = WearDevices.LARGE_ROUND, showSystemUi = true)
@Preview(device = WearDevices.SMALL_ROUND, showSystemUi = true)
@Composable
private fun ChatScreenConversationPreview() {
  WearTheme {
    AppScaffold(timeText = { TimeText() }) {
      ChatPreview(
        messages = previewMessages(),
        connected = true,
        statusText = stringResource(R.string.wear_status_connected_via_phone),
        config =
          WearGatewayConfig(
            usePhoneProxy = true,
            defaultReplyAction = WearReplyAction.VOICE,
            nativeTtsEnabled = true,
          ),
        sessionDisplayName = "Cool Matrix channel",
        sessionKey = "agent:main:matrix:channel:!123456789abcdef:matrix.org",
      )
    }
  }
}

@Preview(device = WearDevices.LARGE_ROUND, showSystemUi = true)
@Composable
private fun ChatScreenLoadingPreview() {
  WearTheme {
    AppScaffold(timeText = { TimeText() }) {
      ChatPreview(
        messages = emptyList(),
        connected = false,
        statusText = stringResource(R.string.wear_status_finding_phone),
        isLoading = true,
        config =
          WearGatewayConfig(
            usePhoneProxy = true,
            defaultReplyAction = WearReplyAction.TEXT,
            nativeTtsEnabled = false,
          ),
      )
    }
  }
}

@Preview(device = WearDevices.LARGE_ROUND, showSystemUi = true)
@Composable
private fun ChatScreenActionMenuPreview() {
  WearTheme {
    AppScaffold(timeText = { TimeText() }) {
      ChatPreview(
        messages = previewMessages(),
        connected = false,
        statusText = stringResource(R.string.wear_status_offline),
        config =
          WearGatewayConfig(
            usePhoneProxy = false,
            host = "gateway-host",
            port = 18789,
            token = "secret",
            useTls = true,
            defaultReplyAction = WearReplyAction.TEXT,
            nativeTtsEnabled = false,
          ),
        sessionDisplayName = "Heartbeat",
        sessionKey = "agent:agent:main",
        initialPage = 1,
      )
    }
  }
}

@Preview(device = WearDevices.LARGE_ROUND, showSystemUi = true)
@Composable
private fun ChatScreenScrollToLatestPreview() {
  WearTheme {
    AppScaffold(timeText = { TimeText() }) {
      ChatPreview(
        messages = previewMessages(),
        connected = true,
        statusText = stringResource(R.string.wear_status_connected_via_phone),
        streamingText = "Still streaming the final answer...",
        config =
          WearGatewayConfig(
            usePhoneProxy = true,
            defaultReplyAction = WearReplyAction.VOICE,
            nativeTtsEnabled = true,
          ),
        showScrollToLatest = true,
        sessionDisplayName = "Cool matrix channel",
        sessionKey = "agent:main:matrix:channel:!123456789abcdef:matrix.org",
      )
    }
  }
}

@Composable
private fun ChatPreview(
  messages: List<WearChatMessage>,
  connected: Boolean,
  statusText: String,
  isLoading: Boolean = false,
  streamingText: String? = null,
  isSending: Boolean = false,
  config: WearGatewayConfig,
  showScrollToLatest: Boolean = false,
  sessionDisplayName: String = "Pixel Watch",
  sessionKey: String = "main",
  initialPage: Int = TranscriptPageIndex,
) {
  val listState = rememberScalingLazyListState()
  val menuListState = rememberScalingLazyListState()
  val pagerState = rememberPagerState(pageCount = { ChatPageCount })
  val showStatusHeader = messages.isEmpty() || isLoading

  LaunchedEffect(initialPage) {
    pagerState.scrollToPage(initialPage)
  }

  Box(modifier = Modifier.fillMaxSize()) {
    HorizontalPager(
      state = pagerState,
      modifier = Modifier.fillMaxSize(),
      flingBehavior = PagerScaffoldDefaults.snapWithSpringFlingBehavior(state = pagerState),
      rotaryScrollableBehavior = null,
    ) { page ->
      AnimatedPage(pageIndex = page, pagerState = pagerState) {
        when (page) {
          TranscriptPageIndex ->
            ChatTranscriptPage(
              listState = listState,
              messages = messages,
              streamingText = streamingText,
              connected = connected,
              statusText = statusText,
              isLoading = isLoading,
              isSending = isSending,
              sessionKey = sessionKey,
              config = config,
              showStatusHeader = showStatusHeader,
              needsGatewaySetup = false,
              showScrollToLatest = showScrollToLatest,
              showStartupOverlay = isLoading && messages.isEmpty(),
              onPrimaryAction = {},
              onOpenSetupSettings = {},
            )

          else ->
            ChatActionsPage(
              listState = menuListState,
              connected = connected,
              statusText = statusText,
              sessionKey = sessionKey,
              sessionDisplayName = sessionDisplayName,
              config = config,
              onNavigateToSessions = {},
              onNavigateToChatSettings = {},
              onNavigateToConnectionSettings = {},
              onDisconnect = {},
              onReconnect = {},
            )
        }
      }
    }
    HorizontalPageIndicator(
      pagerState = pagerState,
      modifier =
        Modifier
          .align(Alignment.TopCenter)
          .padding(top = ChatPagerIndicatorTopPadding),
    )
  }
}

private fun chatLatestAnchorIndex(
  showHeader: Boolean,
  messageCount: Int,
  hasStreamingText: Boolean,
  isSending: Boolean,
  showSetupRequired: Boolean,
  showDisconnectedEmpty: Boolean,
  showLoadingEmpty: Boolean,
  showPromptEmpty: Boolean,
): Int {
  var index = if (showHeader) 0 else -1
  if (showSetupRequired || showDisconnectedEmpty || showLoadingEmpty || showPromptEmpty) {
    index += 1
  } else if (messageCount > 0) {
    index += messageCount
  }
  if (hasStreamingText) index += 1
  if (isSending && !hasStreamingText) index += 1
  index += 1
  return index
}
