package ai.openclaw.app.ui.chat

import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.saveable.listSaver
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch

internal enum class ChatScrollFollowTarget {
  ReadAnchor,
  LatestContent,
}

internal data class ChatReaderState(
  val initialized: Boolean = false,
  val followTarget: ChatScrollFollowTarget? = null,
  val hasNewerContent: Boolean = false,
  val latestUserMessageId: String? = null,
  val latestContentVersion: String? = null,
)

internal val ChatReaderStateSaver =
  listSaver<ChatReaderState, Any>(
    save = { state ->
      listOf(
        state.initialized,
        state.followTarget?.name.orEmpty(),
        state.hasNewerContent,
        state.latestUserMessageId != null,
        state.latestUserMessageId.orEmpty(),
        state.latestContentVersion != null,
        state.latestContentVersion.orEmpty(),
      )
    },
    restore = { saved ->
      ChatReaderState(
        initialized = saved[0] as Boolean,
        followTarget =
          (saved[1] as String).takeIf(String::isNotEmpty)?.let(ChatScrollFollowTarget::valueOf),
        hasNewerContent = saved[2] as Boolean,
        latestUserMessageId = (saved[4] as String).takeIf { saved[3] as Boolean },
        latestContentVersion = (saved[6] as String).takeIf { saved[5] as Boolean },
      )
    },
  )

internal data class ChatReaderTransition(
  val state: ChatReaderState,
  val scrollIndex: Int? = null,
  val animated: Boolean = false,
)

internal data class ChatReaderScrollController(
  val listState: LazyListState,
  val showJumpToLatest: Boolean,
  val jumpToLatest: () -> Unit,
)

@Composable
internal fun rememberChatReaderScrollController(
  sessionKey: String,
  timeline: ChatTimeline,
  historyLoading: Boolean,
): ChatReaderScrollController {
  val listState = rememberLazyListState()
  val scope = rememberCoroutineScope()
  val targetTolerancePx = with(LocalDensity.current) { 24.dp.roundToPx() }
  val currentTimeline by rememberUpdatedState(timeline)
  var readerState by
    rememberSaveable(sessionKey, stateSaver = ChatReaderStateSaver) {
      mutableStateOf(ChatReaderState())
    }
  var isApplyingScroll by remember(sessionKey) { mutableStateOf(false) }

  suspend fun applyTransition(transition: ChatReaderTransition) {
    readerState = transition.state
    val index = transition.scrollIndex ?: return
    isApplyingScroll = true
    try {
      if (transition.animated) {
        listState.animateScrollToItem(index)
      } else {
        listState.scrollToItem(index)
      }
    } finally {
      isApplyingScroll = false
    }
  }

  LaunchedEffect(sessionKey, timeline, historyLoading) {
    val transition =
      if (readerState.initialized) {
        readerState.onTimelineChanged(timeline, historyLoading)
      } else {
        initialChatReaderTransition(timeline)
      }
    applyTransition(transition)
  }

  LaunchedEffect(sessionKey) {
    snapshotFlow { listState.firstVisibleItemIndex to listState.firstVisibleItemScrollOffset }
      .collect { (index, offset) ->
        if (!readerState.initialized || isApplyingScroll) return@collect
        readerState = readerState.onViewportChanged(index, offset, currentTimeline, targetTolerancePx)
      }
  }

  return ChatReaderScrollController(
    listState = listState,
    showJumpToLatest = readerState.hasNewerContent && timeline.items.isNotEmpty(),
    jumpToLatest = {
      scope.launch {
        applyTransition(readerState.jumpToLatest(currentTimeline))
      }
    },
  )
}

internal fun initialChatReaderTransition(timeline: ChatTimeline): ChatReaderTransition {
  val initialIndex = timeline.readAnchorIndex ?: timeline.latestContentIndex
  return ChatReaderTransition(
    state =
      ChatReaderState(
        initialized = initialIndex != null,
        followTarget = timeline.followTargetForIndex(initialIndex),
        latestUserMessageId = timeline.latestUserMessageId,
        latestContentVersion = timeline.latestContentVersion,
      ),
    scrollIndex = initialIndex,
  )
}

internal fun ChatReaderState.onTimelineChanged(
  timeline: ChatTimeline,
  historyLoading: Boolean = false,
): ChatReaderTransition {
  if (timeline.items.isEmpty()) {
    return ChatReaderTransition(state = if (historyLoading) this else ChatReaderState())
  }
  if (timeline.latestContentVersion == latestContentVersion) {
    return ChatReaderTransition(state = this)
  }
  val previousUserStillPresent = latestUserMessageId?.let(timeline::containsMessage) ?: true
  if (!previousUserStillPresent) {
    return ChatReaderTransition(
      state =
        copy(
          followTarget = null,
          hasNewerContent = false,
          latestUserMessageId = timeline.latestUserMessageId,
          latestContentVersion = timeline.latestContentVersion,
        ),
    )
  }
  val hasNewUserTurn =
    timeline.latestUserMessageId != null && timeline.latestUserMessageId != latestUserMessageId
  if (hasNewUserTurn) {
    return ChatReaderTransition(
      state =
        copy(
          followTarget = ChatScrollFollowTarget.ReadAnchor,
          hasNewerContent = false,
          latestUserMessageId = timeline.latestUserMessageId,
          latestContentVersion = timeline.latestContentVersion,
        ),
      scrollIndex = timeline.readAnchorIndex ?: timeline.latestContentIndex,
      animated = true,
    )
  }

  val target = followTarget
  if (target == null) {
    return ChatReaderTransition(
      state =
        copy(
          hasNewerContent = true,
          latestUserMessageId = timeline.latestUserMessageId,
          latestContentVersion = timeline.latestContentVersion,
        ),
    )
  }

  val targetIndex = timeline.indexForFollowTarget(target)
  return ChatReaderTransition(
    state =
      copy(
        hasNewerContent = target == ChatScrollFollowTarget.ReadAnchor && targetIndex != timeline.latestContentIndex,
        latestUserMessageId = timeline.latestUserMessageId,
        latestContentVersion = timeline.latestContentVersion,
      ),
    scrollIndex = targetIndex,
  )
}

internal fun ChatReaderState.onViewportChanged(
  index: Int,
  offset: Int,
  timeline: ChatTimeline,
  targetTolerancePx: Int,
): ChatReaderState {
  val nextTarget =
    if (isAtTarget(index, offset, timeline.latestContentIndex, targetTolerancePx)) {
      ChatScrollFollowTarget.LatestContent
    } else {
      null
    }
  return copy(
    followTarget = nextTarget,
    hasNewerContent = if (nextTarget == ChatScrollFollowTarget.LatestContent) false else hasNewerContent,
  )
}

internal fun ChatReaderState.jumpToLatest(timeline: ChatTimeline): ChatReaderTransition =
  ChatReaderTransition(
    state = copy(followTarget = ChatScrollFollowTarget.LatestContent, hasNewerContent = false),
    scrollIndex = timeline.latestContentIndex ?: timeline.readAnchorIndex,
    animated = true,
  )

private fun ChatTimeline.indexForFollowTarget(target: ChatScrollFollowTarget): Int? =
  when (target) {
    ChatScrollFollowTarget.ReadAnchor -> readAnchorIndex
    ChatScrollFollowTarget.LatestContent -> latestContentIndex
  }

private fun ChatTimeline.containsMessage(id: String): Boolean =
  items
    .filterIsInstance<ChatTimelineItem.Message>()
    .any { item -> item.message.id == id }

private fun ChatTimeline.followTargetForIndex(index: Int?): ChatScrollFollowTarget? =
  when (index) {
    latestContentIndex -> ChatScrollFollowTarget.LatestContent
    readAnchorIndex -> ChatScrollFollowTarget.ReadAnchor
    else -> null
  }

private fun isAtTarget(
  index: Int,
  offset: Int,
  target: Int?,
  tolerancePx: Int,
): Boolean = target != null && index == target && offset <= tolerancePx
