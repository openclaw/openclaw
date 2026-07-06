package ai.openclaw.app.ui.chat

import ai.openclaw.app.chat.ChatMessage
import ai.openclaw.app.chat.ChatOutboxItem
import ai.openclaw.app.chat.ChatPendingToolCall
import ai.openclaw.app.ui.mobileBorder
import ai.openclaw.app.ui.mobileCallout
import ai.openclaw.app.ui.mobileCardSurface
import ai.openclaw.app.ui.mobileHeadline
import ai.openclaw.app.ui.mobileText
import ai.openclaw.app.ui.mobileTextSecondary
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ArrowDropDown
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp

/** Renders chat history newest-first while preserving stable scroll behavior during streaming. */
@Composable
fun ChatMessageListCard(
  sessionKey: String,
  messages: List<ChatMessage>,
  historyLoading: Boolean,
  pendingRunCount: Int,
  pendingToolCalls: List<ChatPendingToolCall>,
  streamingAssistantText: String?,
  healthOk: Boolean,
  gatewayOffline: Boolean,
  modifier: Modifier = Modifier,
  outboxItems: List<ChatOutboxItem> = emptyList(),
  onRetryOutbox: (String) -> Unit = {},
  onDeleteOutbox: (String) -> Unit = {},
  onReplyMessage: (String) -> Unit = {},
) {
  val timeline =
    remember(messages, pendingRunCount, pendingToolCalls, streamingAssistantText, outboxItems) {
      buildChatTimeline(
        messages = messages,
        pendingRunCount = pendingRunCount,
        pendingToolCalls = pendingToolCalls,
        streamingAssistantText = streamingAssistantText,
        outboxItems = outboxItems,
      )
    }
  val readerScroll =
    rememberChatReaderScrollController(
      sessionKey = sessionKey,
      timeline = timeline,
      historyLoading = historyLoading,
    )

  Box(modifier = modifier.fillMaxWidth()) {
    LazyColumn(
      modifier = Modifier.fillMaxSize(),
      state = readerScroll.listState,
      reverseLayout = true,
      verticalArrangement = Arrangement.spacedBy(10.dp),
      contentPadding =
        androidx.compose.foundation.layout
          .PaddingValues(bottom = 8.dp),
    ) {
      itemsIndexed(items = timeline.items, key = { _, item -> chatTimelineItemKey(item) }) { _, item ->
        when (item) {
          is ChatTimelineItem.Message ->
            ChatMessageBubble(
              message = item.message,
              onReplyMessage = onReplyMessage,
            )
          is ChatTimelineItem.OutboxCommand ->
            ChatOutboxBubble(
              item = item.item,
              onRetry = { onRetryOutbox(item.item.id) },
              onDelete = { onDeleteOutbox(item.item.id) },
            )
          is ChatTimelineItem.PendingTools -> ChatPendingToolsBubble(toolCalls = item.toolCalls)
          is ChatTimelineItem.StreamingAssistant -> ChatStreamingAssistantBubble(text = item.text)
          ChatTimelineItem.Thinking -> ChatTypingIndicatorBubble()
        }
      }
    }

    if (timeline.items.isEmpty()) {
      if (showChatLoadingPlaceholder(historyLoading = historyLoading, healthOk = healthOk, gatewayOffline = gatewayOffline)) {
        LoadingChatHint(modifier = Modifier.align(Alignment.Center))
      } else {
        EmptyChatHint(modifier = Modifier.align(Alignment.Center), healthOk = healthOk)
      }
    }

    if (readerScroll.showJumpToLatest) {
      Surface(
        onClick = readerScroll.jumpToLatest,
        modifier = Modifier.align(Alignment.BottomCenter).padding(bottom = 10.dp),
        shape = RoundedCornerShape(999.dp),
        color = mobileCardSurface.copy(alpha = 0.96f),
        border = androidx.compose.foundation.BorderStroke(1.dp, mobileBorder),
        shadowElevation = 6.dp,
      ) {
        Row(
          modifier = Modifier.padding(horizontal = 12.dp, vertical = 7.dp),
          horizontalArrangement = Arrangement.spacedBy(6.dp),
          verticalAlignment = Alignment.CenterVertically,
        ) {
          Icon(imageVector = Icons.Default.ArrowDropDown, contentDescription = null, tint = mobileText)
          Text("Jump to latest", style = mobileCallout.copy(fontWeight = FontWeight.SemiBold), color = mobileText)
        }
      }
    }
  }
}

@Composable
private fun LoadingChatHint(modifier: Modifier = Modifier) {
  Surface(
    modifier = modifier.fillMaxWidth(),
    shape = RoundedCornerShape(14.dp),
    color = mobileCardSurface.copy(alpha = 0.9f),
    border = androidx.compose.foundation.BorderStroke(1.dp, mobileBorder),
  ) {
    Column(
      modifier = Modifier.padding(horizontal = 12.dp, vertical = 12.dp),
      horizontalAlignment = Alignment.CenterHorizontally,
      verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
      CircularProgressIndicator(color = mobileText, strokeWidth = 2.dp)
      Text("Loading session", style = mobileCallout, color = mobileTextSecondary)
    }
  }
}

@Composable
private fun EmptyChatHint(
  modifier: Modifier = Modifier,
  healthOk: Boolean,
) {
  Surface(
    modifier = modifier.fillMaxWidth(),
    shape = RoundedCornerShape(14.dp),
    color = mobileCardSurface.copy(alpha = 0.9f),
    border = androidx.compose.foundation.BorderStroke(1.dp, mobileBorder),
  ) {
    androidx.compose.foundation.layout.Column(
      modifier = Modifier.padding(horizontal = 12.dp, vertical = 12.dp),
      verticalArrangement = Arrangement.spacedBy(4.dp),
    ) {
      Text("No messages yet", style = mobileHeadline, color = mobileText)
      Text(
        text =
          if (healthOk) {
            "Send the first prompt to start this session."
          } else {
            "Connect gateway first, then return to chat."
          },
        style = mobileCallout,
        color = mobileTextSecondary,
      )
    }
  }
}
