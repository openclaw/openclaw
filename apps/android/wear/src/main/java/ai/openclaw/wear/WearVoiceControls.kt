package ai.openclaw.wear

import ai.openclaw.wear.shared.WearRealtimeTalkSnapshot
import ai.openclaw.wear.shared.WearRealtimeTalkStatus
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.layout
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextLayoutResult
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.rememberTextMeasurer
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.Constraints
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.wear.compose.foundation.lazy.TransformingLazyColumn
import androidx.wear.compose.foundation.lazy.rememberTransformingLazyColumnState
import androidx.wear.compose.material3.LocalTextStyle
import androidx.wear.compose.material3.ScreenScaffold
import androidx.wear.compose.material3.Text
import androidx.wear.compose.material3.TextDefaults
import androidx.wear.compose.material3.minimumInteractiveComponentSize
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import androidx.compose.ui.semantics.onClick as semanticsOnClick

internal data class WearVoiceLayout(
  val horizontalPadding: Dp,
  val orbSize: Dp,
  val contentHeight: Dp,
)

internal fun wearVoiceLayout(
  maxWidth: Dp,
  fontScale: Float,
): WearVoiceLayout {
  val compact = maxWidth <= 192.dp
  val compactLargeText = compact && fontScale > 1.1f
  return WearVoiceLayout(
    horizontalPadding = if (fontScale > 1.1f) 4.dp else 6.dp,
    orbSize =
      when {
        compactLargeText -> 48.dp
        compact -> 80.dp
        fontScale > 1.1f -> 80.dp
        else -> 92.dp
      },
    contentHeight =
      when {
        compactLargeText -> 132.dp
        compact -> 144.dp
        else -> 156.dp
      },
  )
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
internal fun VoiceHomeMode(
  colors: WearColors,
  microphonePermissionRequired: Boolean,
  microphoneSettingsRequired: Boolean,
  onMicrophoneRecovery: () -> Unit,
  realtimeTalk: WearRealtimeTalkSnapshot,
  realtimeStopping: Boolean,
  speaking: Boolean,
  realtimeCapturing: Boolean,
  realtimePlaying: Boolean,
  realtimeMouthLevel: Float,
  realtimePlaybackFailed: Boolean,
  realtimeThinkingOverride: Boolean,
  realtimeElapsedSeconds: Long,
  actionBusy: Boolean,
  inputEnabled: Boolean,
  onTalk: () -> Unit,
  onRealtimeTalk: () -> Unit,
  onStopSpeaking: () -> Unit,
  onOpenThread: () -> Unit,
) {
  val realtimeActive = realtimeTalk.active || realtimeCapturing
  val ttsOnly = speaking && !realtimeActive
  val recoverMicrophone = microphonePermissionRequired && !realtimeActive && !ttsOnly
  val state =
    realtimeVoiceButtonState(
      realtimeTalk = realtimeTalk,
      ttsOnly = ttsOnly,
      realtimeCapturing = realtimeCapturing,
      realtimePlaying = realtimePlaying,
      realtimePlaybackFailed = realtimePlaybackFailed,
      realtimeThinkingOverride = realtimeThinkingOverride && !realtimeStopping,
    )
  var dictatePreview by remember { mutableStateOf(false) }
  val coroutineScope = rememberCoroutineScope()
  val list = rememberTransformingLazyColumnState()
  val dictateActionEnabled = inputEnabled && !actionBusy && !speaking && !realtimeActive && !dictatePreview
  val liveActionEnabled =
    (realtimeActive || ttsOnly || (inputEnabled && !actionBusy)) && !dictatePreview
  val startDictate: () -> Unit = {
    if (dictateActionEnabled) {
      coroutineScope.launch {
        dictatePreview = true
        delay(300L)
        dictatePreview = false
        onTalk()
      }
    }
  }
  val toggleLive: () -> Unit = {
    if (liveActionEnabled) {
      if (ttsOnly) {
        onStopSpeaking()
      } else if (recoverMicrophone) {
        onMicrophoneRecovery()
      } else {
        onRealtimeTalk()
      }
    }
  }
  val label =
    when (state) {
      RealtimeVoiceButtonState.IDLE -> null
      RealtimeVoiceButtonState.CONNECTING -> stringResource(R.string.connecting)
      RealtimeVoiceButtonState.LISTENING -> stringResource(R.string.listening)
      RealtimeVoiceButtonState.THINKING -> stringResource(R.string.thinking)
      RealtimeVoiceButtonState.SPEAKING -> stringResource(R.string.speaking)
      RealtimeVoiceButtonState.ERROR -> stringResource(R.string.real_time_audio_failed)
    }
  val statusText =
    when {
      realtimeStopping -> stringResource(R.string.stopping)
      dictatePreview -> stringResource(R.string.listening)
      recoverMicrophone -> stringResource(R.string.microphone_permission_required)
      label == null -> null
      realtimeActive -> "$label · ${formatVoiceElapsedTime(realtimeElapsedSeconds)}"
      else -> label
    }
  val accent =
    when {
      dictatePreview || state == RealtimeVoiceButtonState.IDLE -> colors.voiceAccent
      state == RealtimeVoiceButtonState.ERROR -> colors.danger
      else -> colors.voiceAccent
    }
  val avatarState = if (dictatePreview) RealtimeVoiceButtonState.LISTENING else state
  val liveVoiceDescription = stringResource(R.string.talk)
  val liveClickLabel =
    when {
      ttsOnly -> stringResource(R.string.stop_speaking)
      recoverMicrophone -> stringResource(if (microphoneSettingsRequired) R.string.open_settings else R.string.retry)
      realtimeActive -> stringResource(R.string.stop_speaking)
      else -> stringResource(R.string.speak_to_agent)
    }
  val dictateClickLabel = stringResource(R.string.dictate)
  val orbClick = if (liveActionEnabled) toggleLive else startDictate
  val orbClickLabel = if (liveActionEnabled) liveClickLabel else dictateClickLabel
  val density = LocalDensity.current
  val configuration = LocalConfiguration.current
  val fontScale = density.fontScale
  val textMeasurer = rememberTextMeasurer()
  val labelStyle = wearVoiceLabelStyle()
  val holdLabel = WearVoiceLabel(stringResource(R.string.hold), dictateClickLabel)
  val liveLabel = WearVoiceLabel(stringResource(R.string.tap), stringResource(R.string.live))
  val threadLabel = WearVoiceLabel(stringResource(R.string.double_tap), stringResource(R.string.thread))
  val threadClickLabel = stringResource(R.string.open_thread)
  val recoveryLabel = if (recoverMicrophone) stringResource(if (microphoneSettingsRequired) R.string.open_settings else R.string.retry) else null
  BoxWithConstraints(Modifier.fillMaxSize()) {
    val layout = wearVoiceLayout(maxWidth = maxWidth, fontScale = fontScale)
    val liveControlWidth = if (recoverMicrophone) layout.orbSize.coerceAtLeast(80.dp) else layout.orbSize
    val liveControlHeight = if (recoverMicrophone) 60.dp else layout.orbSize
    val voiceControlOffset = if (fontScale > 1.1f) (-8).dp else (-4).dp
    val threadTop = if (fontScale > 1.1f) (-8).dp else (-16).dp
    val orbTop = (maxHeight - liveControlHeight) / 2 + voiceControlOffset
    val threadOverlap = (threadTop + 48.dp - orbTop).coerceAtLeast(0.dp)
    val statusWidth = (maxWidth - 56.dp).coerceAtMost(136.dp)
    // Measure the same glyphs and placements used below before choosing a layout.
    // A taller translation must not push Thread into the round edge or cover Talk.
    val compactFits =
      remember(constraints, density, textMeasurer, labelStyle, configuration.screenHeightDp, configuration.isScreenRound, holdLabel, liveLabel, threadLabel, statusText, recoveryLabel) {
        with(density) {
          val width = constraints.maxWidth
          val height = constraints.maxHeight
          val viewport = IntSize(width, configuration.screenHeightDp.dp.roundToPx())
          val contentTop = (viewport.height - height) / 2f
          val offset = voiceControlOffset.roundToPx()
          val controlTop = orbTop.roundToPx()
          val controlBottom = controlTop + liveControlHeight.roundToPx()
          val sideWidth = (width - layout.horizontalPadding.roundToPx() * 2 - liveControlWidth.roundToPx()) / 2

          fun measure(
            text: String,
            width: Int,
            bold: Boolean = false,
            status: Boolean = false,
          ): TextLayoutResult =
            textMeasurer.measure(
              text = text,
              style = labelStyle.copy(fontWeight = if (bold) FontWeight.SemiBold else labelStyle.fontWeight, lineHeight = if (status) 12.sp else 14.sp),
              constraints = Constraints(maxWidth = width.coerceAtLeast(0)),
            )

          fun fitsLabel(
            label: WearVoiceLabel,
            width: Int,
            center: Float,
            thread: Boolean = false,
          ): Boolean {
            val title = measure(label.title, width, bold = true)
            val detail = measure(label.detail, width)
            val topPadding = if (thread) (threadOverlap * 2).roundToPx() else 10.dp.roundToPx()
            val bottomPadding = if (thread) 0 else 10.dp.roundToPx()
            val naturalHeight = title.size.height + detail.size.height + topPadding + bottomPadding
            val targetHeight = maxOf(48.dp.roundToPx(), naturalHeight)
            if (targetHeight > height) return false
            val targetTop =
              if (thread) {
                minOf(threadTop.roundToPx(), controlTop - targetHeight).toFloat()
              } else {
                (height - targetHeight) / 2f + offset
              }
            val titleTop = contentTop + targetTop + (targetHeight - naturalHeight) / 2f + topPadding
            return title.fitsVoiceViewport(Offset(center - title.size.width / 2f, titleTop), viewport, configuration.isScreenRound) &&
              detail.fitsVoiceViewport(Offset(center - detail.size.width / 2f, titleTop + title.size.height), viewport, configuration.isScreenRound)
          }
          val sideCenter = layout.horizontalPadding.roundToPx() + sideWidth / 2f
          val statusFits =
            statusText?.let {
              val result = measure(it, statusWidth.roundToPx(), status = true)
              val top = height - 1.dp.roundToPx() - result.size.height
              top >= controlBottom && result.fitsVoiceViewport(Offset((width - result.size.width) / 2f, contentTop + top), viewport, configuration.isScreenRound)
            } ?: true
          val recoveryFits =
            recoveryLabel?.let {
              val result = measure(it, liveControlWidth.roundToPx(), bold = true)
              result.size.height <= liveControlHeight.roundToPx() &&
                result.fitsVoiceViewport(Offset((width - result.size.width) / 2f, contentTop + controlTop + (liveControlHeight.roundToPx() - result.size.height) / 2f), viewport, configuration.isScreenRound)
            } ?: true
          fitsLabel(holdLabel, sideWidth, sideCenter) && fitsLabel(liveLabel, sideWidth, width - sideCenter) &&
            fitsLabel(threadLabel, (maxWidth - 56.dp).roundToPx(), width / 2f, thread = true) && statusFits && recoveryFits
        }
      }

    fun revealVoiceControl(action: () -> Unit) {
      if (!compactFits) {
        // Request-only scrolling waits for unrelated content changes. Reveal feedback
        // even when a selected action does not immediately change the conversation.
        coroutineScope.launch { list.scrollToItem(0) }
      }
      action()
    }
    val clickOrb = { revealVoiceControl(orbClick) }
    val dictate = { revealVoiceControl(startDictate) }
    val live = { revealVoiceControl(toggleLive) }
    val talkControl: @Composable (Modifier) -> Unit = { modifier ->
      Box(
        modifier =
          modifier
            .width(liveControlWidth)
            .height(liveControlHeight)
            .combinedClickable(
              // Both layouts use one gesture owner, including recovery and preview cancellation.
              enabled = !dictatePreview && (liveActionEnabled || dictateActionEnabled),
              onClickLabel = orbClickLabel,
              role = Role.Button,
              onClick = clickOrb,
              onDoubleClick = onOpenThread,
              onLongClickLabel = dictateClickLabel.takeIf { dictateActionEnabled },
              onLongClick = dictate.takeIf { dictateActionEnabled },
            ).semantics { contentDescription = liveVoiceDescription },
        contentAlignment = Alignment.Center,
      ) {
        if (recoveryLabel != null) {
          Text(text = recoveryLabel, color = colors.voiceAccent, style = labelStyle, fontWeight = FontWeight.SemiBold)
        } else {
          WearTalkAvatar(
            state = avatarState,
            mouthLevel = if (realtimePlaying) realtimeMouthLevel else 0f,
            syntheticSpeech = ttsOnly,
            accent = accent,
            danger = colors.danger,
            modifier = Modifier.fillMaxSize(),
          )
        }
      }
    }
    val dictateControl: @Composable (Modifier) -> Unit = { modifier ->
      VoiceGestureLabel(holdLabel, colors.voiceAccent, colors.textMuted, modifier, onClick = dictate.takeIf { dictateActionEnabled }, onClickLabel = dictateClickLabel)
    }
    val liveControl: @Composable (Modifier) -> Unit = { modifier ->
      VoiceGestureLabel(liveLabel, colors.voiceAccent, colors.textMuted, modifier, onClick = live.takeIf { liveActionEnabled }, onClickLabel = liveClickLabel)
    }
    val threadControl: @Composable (Modifier, PaddingValues) -> Unit = { modifier, padding ->
      VoiceGestureLabel(threadLabel, colors.voiceAccent, colors.textMuted, modifier, onDoubleClick = onOpenThread, onClickLabel = threadClickLabel, contentPadding = padding)
    }
    val status: @Composable (Modifier) -> Unit = { modifier ->
      statusText?.let {
        Text(text = it, color = if (recoverMicrophone) colors.danger else colors.textMuted, fontSize = 12.sp, lineHeight = 12.sp, textAlign = TextAlign.Center, modifier = modifier)
      }
    }
    if (compactFits) {
      Row(
        modifier = Modifier.align(Alignment.Center).fillMaxWidth().padding(horizontal = layout.horizontalPadding),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.Center,
      ) {
        dictateControl(Modifier.offset(y = voiceControlOffset).weight(1f))
        Box(Modifier.width(liveControlWidth).height(layout.contentHeight)) {
          talkControl(Modifier.align(Alignment.Center).offset(y = voiceControlOffset))
        }
        liveControl(Modifier.offset(y = voiceControlOffset).weight(1f))
      }
      threadControl(
        Modifier
          .align(Alignment.TopCenter)
          .layout { measurable, constraints ->
            val target = measurable.measure(constraints)
            val top = minOf(threadTop.roundToPx(), orbTop.roundToPx() - target.height)
            this.layout(target.width, target.height) { target.placeRelative(0, top) }
          }.padding(horizontal = 28.dp)
          .fillMaxWidth()
          .minimumInteractiveComponentSize(),
        PaddingValues(top = threadOverlap * 2),
      )
      status(Modifier.align(Alignment.BottomCenter).width(statusWidth).padding(bottom = 1.dp))
    } else {
      ScreenScaffold(scrollState = list) { padding ->
        TransformingLazyColumn(
          modifier = Modifier.fillMaxSize(),
          state = list,
          contentPadding = padding,
          horizontalAlignment = Alignment.CenterHorizontally,
          verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
          item(key = "talk") {
            // Center the control and its explanation together after an action.
            // Separate items can leave a long recovery/error message below the viewport.
            Column(
              modifier = Modifier.minimumVerticalContentPadding(top = TextDefaults.minimumTopListContentPadding, bottom = TextDefaults.minimumBottomListContentPadding),
              horizontalAlignment = Alignment.CenterHorizontally,
              verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
              talkControl(Modifier)
              status(Modifier.fillMaxWidth().padding(horizontal = 12.dp))
            }
          }
          item(key = "thread") { threadControl(Modifier.fillMaxWidth().padding(horizontal = 12.dp), PaddingValues(vertical = 10.dp)) }
          item(key = "dictate") { dictateControl(Modifier.fillMaxWidth().padding(horizontal = 12.dp)) }
          item(key = "live") {
            liveControl(Modifier.fillMaxWidth().padding(horizontal = 12.dp).minimumVerticalContentPadding(TextDefaults.minimumBottomListContentPadding))
          }
        }
      }
    }
  }
}

private data class WearVoiceLabel(
  val title: String,
  val detail: String,
)

@Composable
private fun wearVoiceLabelStyle() = LocalTextStyle.current.copy(fontSize = 12.sp, lineHeight = 14.sp, textAlign = TextAlign.Center)

private fun TextLayoutResult.fitsVoiceViewport(
  origin: Offset,
  viewport: IntSize,
  round: Boolean,
): Boolean {
  if (hasVisualOverflow) return false
  val center = Offset(viewport.width / 2f, viewport.height / 2f)
  val radius = minOf(viewport.width, viewport.height) / 2f
  return layoutInput.text.indices.filterNot { layoutInput.text[it].isWhitespace() }.all { index ->
    val box = getBoundingBox(index).translate(origin)
    listOf(box.topLeft, box.topRight, box.bottomLeft, box.bottomRight).all { point ->
      point.x >= 0 && point.x <= viewport.width && point.y >= 0 && point.y <= viewport.height &&
        (!round || (point - center).getDistanceSquared() <= radius * radius)
    }
  }
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun VoiceGestureLabel(
  label: WearVoiceLabel,
  accent: Color,
  muted: Color,
  modifier: Modifier = Modifier,
  onClick: (() -> Unit)? = null,
  onDoubleClick: (() -> Unit)? = null,
  onClickLabel: String? = null,
  contentPadding: PaddingValues = PaddingValues(vertical = 10.dp),
) {
  val labelStyle = wearVoiceLabelStyle()
  val interactionModifier =
    when {
      onDoubleClick != null -> {
        Modifier
          .pointerInput(onDoubleClick) {
            detectTapGestures(onDoubleTap = { onDoubleClick() })
          }.semantics(mergeDescendants = true) {
            role = Role.Button
            semanticsOnClick(label = onClickLabel) {
              onDoubleClick()
              true
            }
          }
      }

      onClick != null -> {
        Modifier.clickable(
          role = Role.Button,
          onClickLabel = onClickLabel,
          onClick = onClick,
        )
      }

      else -> {
        Modifier
      }
    }
  Column(
    modifier =
      modifier
        .then(interactionModifier)
        .then(
          if (onClick != null || onDoubleClick != null) {
            Modifier.minimumInteractiveComponentSize()
          } else {
            Modifier
          },
        ).padding(contentPadding),
    horizontalAlignment = Alignment.CenterHorizontally,
    verticalArrangement = Arrangement.Center,
  ) {
    Text(
      text = label.title,
      color = accent,
      fontWeight = FontWeight.SemiBold,
      style = labelStyle,
    )
    Text(
      text = label.detail,
      color = muted,
      style = labelStyle,
    )
  }
}

private fun realtimeVoiceButtonState(
  realtimeTalk: WearRealtimeTalkSnapshot,
  ttsOnly: Boolean,
  realtimeCapturing: Boolean,
  realtimePlaying: Boolean,
  realtimePlaybackFailed: Boolean,
  realtimeThinkingOverride: Boolean,
): RealtimeVoiceButtonState =
  when {
    realtimePlaybackFailed || realtimeTalk.status == WearRealtimeTalkStatus.ERROR -> {
      RealtimeVoiceButtonState.ERROR
    }

    realtimeThinkingOverride -> {
      RealtimeVoiceButtonState.THINKING
    }

    realtimePlaying || realtimeTalk.speaking || ttsOnly -> {
      RealtimeVoiceButtonState.SPEAKING
    }

    realtimeTalk.status == WearRealtimeTalkStatus.THINKING -> {
      RealtimeVoiceButtonState.THINKING
    }

    realtimeCapturing ||
      realtimeTalk.listening ||
      realtimeTalk.status == WearRealtimeTalkStatus.LISTENING -> {
      RealtimeVoiceButtonState.LISTENING
    }

    realtimeTalk.status == WearRealtimeTalkStatus.CONNECTING -> {
      RealtimeVoiceButtonState.CONNECTING
    }

    else -> {
      RealtimeVoiceButtonState.IDLE
    }
  }

private fun formatVoiceElapsedTime(totalSeconds: Long): String {
  val minutes = totalSeconds / 60L
  val seconds = totalSeconds % 60L
  return "$minutes:${seconds.toString().padStart(2, '0')}"
}

internal enum class RealtimeVoiceButtonState {
  IDLE,
  CONNECTING,
  LISTENING,
  THINKING,
  SPEAKING,
  ERROR,
}
