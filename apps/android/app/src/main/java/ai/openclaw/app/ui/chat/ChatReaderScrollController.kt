package ai.openclaw.app.ui.chat

import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import kotlinx.coroutines.launch

private const val FollowTargetOffsetPx = 24

internal data class ChatReaderScrollController(
  val listState: LazyListState,
  val showJumpToLatest: Boolean,
  val jumpToLatest: () -> Unit,
)

@Composable
internal fun rememberChatReaderScrollController(
  sessionKey: String,
  timeline: ChatTimeline,
): ChatReaderScrollController {
  val listState = rememberLazyListState()
  val scope = rememberCoroutineScope()
  val currentFollowTarget by rememberUpdatedState(timeline.scrollTargetIndex)
  var hasAppliedInitialScroll by rememberSaveable(sessionKey) { mutableStateOf(false) }
  var isFollowingLiveEdge by rememberSaveable(sessionKey) { mutableStateOf(false) }
  var hasNewerContent by rememberSaveable(sessionKey) { mutableStateOf(false) }
  var observedContentVersion by rememberSaveable(sessionKey) { mutableStateOf<String?>(null) }
  var observedLatestUserMessageId by rememberSaveable(sessionKey) { mutableStateOf<String?>(null) }

  LaunchedEffect(sessionKey, timeline.initialScrollIndex, timeline.items.isNotEmpty()) {
    if (hasAppliedInitialScroll || timeline.items.isEmpty()) return@LaunchedEffect
    listState.scrollToItem(index = timeline.initialScrollIndex ?: timeline.scrollTargetIndex ?: 0)
    hasAppliedInitialScroll = true
    observedContentVersion = timeline.contentVersion
    observedLatestUserMessageId = timeline.latestUserMessageId
    hasNewerContent = false
    isFollowingLiveEdge = timeline.initialScrollIndex == timeline.scrollTargetIndex
  }

  LaunchedEffect(sessionKey, timeline.contentVersion) {
    if (!hasAppliedInitialScroll || timeline.items.isEmpty()) return@LaunchedEffect
    val previousContentVersion = observedContentVersion
    val previousUserMessageId = observedLatestUserMessageId
    observedContentVersion = timeline.contentVersion
    observedLatestUserMessageId = timeline.latestUserMessageId
    if (previousContentVersion == null || previousContentVersion == timeline.contentVersion) return@LaunchedEffect

    val hasNewUserTurn =
      previousUserMessageId != null &&
        timeline.latestUserMessageId != null &&
        previousUserMessageId != timeline.latestUserMessageId
    val target = timeline.scrollTargetIndex ?: return@LaunchedEffect
    when {
      hasNewUserTurn -> {
        isFollowingLiveEdge = true
        hasNewerContent = false
        listState.animateScrollToItem(index = target)
      }
      isFollowingLiveEdge -> {
        hasNewerContent = false
        listState.scrollToItem(index = target)
      }
      else -> {
        hasNewerContent = true
      }
    }
  }

  LaunchedEffect(sessionKey) {
    snapshotFlow { listState.firstVisibleItemIndex to listState.firstVisibleItemScrollOffset }
      .collect { (index, offset) ->
        if (!hasAppliedInitialScroll || currentFollowTarget == null) return@collect
        val isAtFollowTarget = index == currentFollowTarget && offset <= FollowTargetOffsetPx
        isFollowingLiveEdge = isAtFollowTarget
        if (isAtFollowTarget) hasNewerContent = false
      }
  }

  return ChatReaderScrollController(
    listState = listState,
    showJumpToLatest = hasNewerContent && timeline.items.isNotEmpty(),
    jumpToLatest = {
      scope.launch {
        val target = currentFollowTarget ?: return@launch
        isFollowingLiveEdge = true
        hasNewerContent = false
        listState.animateScrollToItem(index = target)
      }
    },
  )
}
