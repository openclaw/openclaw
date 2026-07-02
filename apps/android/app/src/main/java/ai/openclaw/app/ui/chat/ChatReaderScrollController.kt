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

private enum class ChatScrollFollowTarget {
  ReadAnchor,
  LatestContent,
}

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
  val currentReadAnchorTarget by rememberUpdatedState(timeline.scrollTargetIndex)
  val currentLatestContentTarget by rememberUpdatedState(timeline.latestContentIndex)
  var hasAppliedInitialScroll by rememberSaveable(sessionKey) { mutableStateOf(false) }
  var followTarget by rememberSaveable(sessionKey) { mutableStateOf<ChatScrollFollowTarget?>(null) }
  var hasNewerContent by rememberSaveable(sessionKey) { mutableStateOf(false) }
  var observedContentVersion by rememberSaveable(sessionKey) { mutableStateOf<String?>(null) }
  var observedLatestUserMessageId by rememberSaveable(sessionKey) { mutableStateOf<String?>(null) }

  LaunchedEffect(sessionKey, timeline.initialScrollIndex, timeline.items.isNotEmpty()) {
    if (hasAppliedInitialScroll || timeline.items.isEmpty()) return@LaunchedEffect
    val initialIndex =
      timeline.initialScrollIndex ?: timeline.scrollTargetIndex ?: timeline.latestContentIndex ?: 0
    listState.scrollToItem(index = initialIndex)
    hasAppliedInitialScroll = true
    observedContentVersion = timeline.contentVersion
    observedLatestUserMessageId = timeline.latestUserMessageId
    hasNewerContent = false
    followTarget = timeline.followTargetForIndex(initialIndex)
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
    when {
      hasNewUserTurn -> {
        val target = timeline.scrollTargetIndex ?: timeline.latestContentIndex ?: return@LaunchedEffect
        followTarget = ChatScrollFollowTarget.ReadAnchor
        hasNewerContent = false
        listState.animateScrollToItem(index = target)
      }
      followTarget != null -> {
        val followedTarget = followTarget ?: return@LaunchedEffect
        val target = timeline.indexForFollowTarget(followedTarget) ?: return@LaunchedEffect
        hasNewerContent = followedTarget == ChatScrollFollowTarget.ReadAnchor && target != timeline.latestContentIndex
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
        if (!hasAppliedInitialScroll) return@collect
        val nextFollowTarget =
          when {
            isAtTarget(index, offset, currentLatestContentTarget) -> ChatScrollFollowTarget.LatestContent
            isAtTarget(index, offset, currentReadAnchorTarget) -> ChatScrollFollowTarget.ReadAnchor
            else -> null
          }
        followTarget = nextFollowTarget
        if (nextFollowTarget == ChatScrollFollowTarget.LatestContent) hasNewerContent = false
      }
  }

  return ChatReaderScrollController(
    listState = listState,
    showJumpToLatest = hasNewerContent && timeline.items.isNotEmpty(),
    jumpToLatest = {
      scope.launch {
        val target = currentLatestContentTarget ?: currentReadAnchorTarget ?: return@launch
        followTarget = ChatScrollFollowTarget.LatestContent
        hasNewerContent = false
        listState.animateScrollToItem(index = target)
      }
    },
  )
}

private fun ChatTimeline.indexForFollowTarget(target: ChatScrollFollowTarget): Int? =
  when (target) {
    ChatScrollFollowTarget.ReadAnchor -> scrollTargetIndex
    ChatScrollFollowTarget.LatestContent -> latestContentIndex
  }

private fun ChatTimeline.followTargetForIndex(index: Int): ChatScrollFollowTarget? =
  when (index) {
    latestContentIndex -> ChatScrollFollowTarget.LatestContent
    scrollTargetIndex -> ChatScrollFollowTarget.ReadAnchor
    else -> null
  }

private fun isAtTarget(
  index: Int,
  offset: Int,
  target: Int?,
): Boolean = target != null && index == target && offset <= FollowTargetOffsetPx
