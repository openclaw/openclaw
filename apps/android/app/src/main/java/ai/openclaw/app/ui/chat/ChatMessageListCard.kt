package ai.openclaw.app.ui.chat

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import ai.openclaw.app.chat.ChatPendingToolCall
import ai.openclaw.app.chat.ChatTimelineItem
import ai.openclaw.app.chat.ChatTimelineMessageItem
import ai.openclaw.app.chat.ChatTimelineToolItem
import ai.openclaw.app.ui.mobileBorder
import ai.openclaw.app.ui.mobileCallout
import ai.openclaw.app.ui.mobileCardSurface
import ai.openclaw.app.ui.mobileHeadline
import ai.openclaw.app.ui.mobileText
import ai.openclaw.app.ui.mobileTextSecondary

@Composable
fun ChatMessageListCard(
  timeline: List<ChatTimelineItem>,
  pendingRunCount: Int,
  pendingToolCalls: List<ChatPendingToolCall>,
  streamingAssistantText: String?,
  healthOk: Boolean,
  uiState: ChatMessageUiState,
  onRequestHideMessage: (String) -> Unit,
  onRequestDeleteMessage: (String) -> Unit,
  onConfirmDeleteMessage: (String) -> Unit,
  onCancelDeleteMessage: (String?) -> Unit,
  onToggleExpandedMessage: (String) -> Unit,
  onOpenCanvas: ((String) -> Unit)? = null,
  modifier: Modifier = Modifier,
) {
  val listState = rememberLazyListState()
  val visibleItems = remember(timeline, uiState) { timeline.filter { shouldDisplayTimelineItem(it, uiState) } }
  val displayItems = remember(visibleItems) { visibleItems.asReversed() }
  val stream = streamingAssistantText?.trim()

  LaunchedEffect(displayItems.size, pendingRunCount, pendingToolCalls.size) {
    listState.animateScrollToItem(index = 0)
  }
  LaunchedEffect(stream) {
    if (!stream.isNullOrEmpty()) {
      listState.scrollToItem(index = 0)
    }
  }

  Box(modifier = modifier.fillMaxWidth()) {
    LazyColumn(
      modifier = Modifier.fillMaxSize(),
      state = listState,
      reverseLayout = true,
      verticalArrangement = Arrangement.spacedBy(10.dp),
      contentPadding = androidx.compose.foundation.layout.PaddingValues(bottom = 8.dp),
    ) {
      if (!stream.isNullOrEmpty()) {
        item(key = "stream") {
          ChatStreamingAssistantBubble(text = stream)
        }
      }

      if (uiState.showToolDetails && pendingToolCalls.isNotEmpty()) {
        item(key = "tools") {
          ChatPendingToolsBubble(toolCalls = pendingToolCalls)
        }
      }

      if (pendingRunCount > 0) {
        item(key = "typing") {
          ChatTypingIndicatorBubble()
        }
      }

      items(items = displayItems, key = { it.id }) { item ->
        when (item) {
          is ChatTimelineMessageItem ->
            ChatTimelineMessageBubble(
              item = item,
              uiState = uiState,
              onOpenCanvas = onOpenCanvas,
              onRequestHideMessage = onRequestHideMessage,
              onRequestDeleteMessage = onRequestDeleteMessage,
              onConfirmDeleteMessage = onConfirmDeleteMessage,
              onCancelDeleteMessage = onCancelDeleteMessage,
              onToggleExpandedMessage = onToggleExpandedMessage,
            )
          is ChatTimelineToolItem -> ChatCompletedToolBubble(item = item, onOpenCanvas = onOpenCanvas)
        }
      }
    }

    if (displayItems.isEmpty() && pendingRunCount == 0 && (pendingToolCalls.isEmpty() || !uiState.showToolDetails) && streamingAssistantText.isNullOrBlank()) {
      EmptyChatHint(
        modifier = Modifier.align(Alignment.Center),
        healthOk = healthOk,
        hasFilteredHistory = timeline.isNotEmpty(),
      )
    }
  }
}

@Composable
private fun EmptyChatHint(
  modifier: Modifier = Modifier,
  healthOk: Boolean,
  hasFilteredHistory: Boolean,
) {
  Surface(
    modifier = modifier.fillMaxWidth(),
    shape = RoundedCornerShape(14.dp),
    color = mobileCardSurface.copy(alpha = 0.9f),
    border = BorderStroke(1.dp, mobileBorder),
  ) {
    androidx.compose.foundation.layout.Column(
      modifier = Modifier.padding(horizontal = 12.dp, vertical = 12.dp),
      verticalArrangement = Arrangement.spacedBy(4.dp),
    ) {
      Text(
        text = if (hasFilteredHistory) "No visible messages" else "No messages yet",
        style = mobileHeadline,
        color = mobileText,
      )
      Text(
        text =
          when {
            hasFilteredHistory -> "Current filters or hidden-message controls are hiding this conversation."
            healthOk -> "Send the first prompt to start this session."
            else -> "Connect gateway first, then return to chat."
          },
        style = mobileCallout,
        color = mobileTextSecondary,
      )
    }
  }
}
