package ai.openclaw.android.ui.chat

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ArrowCircleDown
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.unit.dp
import ai.openclaw.android.chat.ChatMessage
import ai.openclaw.android.chat.ChatPendingToolCall

@Composable
fun ChatMessageListCard(
  messages: List<ChatMessage>,
  pendingRunCount: Int,
  pendingToolCalls: List<ChatPendingToolCall>,
  streamingAssistantText: String?,
  modifier: Modifier = Modifier,
) {
  val listState = rememberLazyListState()

  // With reverseLayout the newest item is at index 0 (bottom of screen).
  LaunchedEffect(messages.size, pendingRunCount, pendingToolCalls.size, streamingAssistantText) {
    listState.animateScrollToItem(index = 0)
  }

  Card(
    modifier = modifier.fillMaxWidth(),
    shape = MaterialTheme.shapes.large,
    colors =
      CardDefaults.cardColors(
        containerColor = MaterialTheme.colorScheme.surfaceContainer,
      ),
    elevation = CardDefaults.cardElevation(defaultElevation = 0.dp),
  ) {
    Box(modifier = Modifier.fillMaxSize()) {
      LazyColumn(
        modifier = Modifier.fillMaxSize(),
        state = listState,
        reverseLayout = true,
        verticalArrangement = Arrangement.spacedBy(14.dp),
        contentPadding = androidx.compose.foundation.layout.PaddingValues(top = 12.dp, bottom = 12.dp, start = 12.dp, end = 12.dp),
      ) {
        // With reverseLayout = true, index 0 renders at the BOTTOM.
        // So we emit newest items first: streaming → tools → typing → messages (newest→oldest).

        val stream = streamingAssistantText?.trim()
        if (!stream.isNullOrEmpty()) {
          item(key = "stream") {
            ChatStreamingAssistantBubble(text = stream)
          }
        }

        if (pendingToolCalls.isNotEmpty()) {
          item(key = "tools") {
            ChatPendingToolsBubble(toolCalls = pendingToolCalls)
          }
        }

        if (pendingRunCount > 0) {
          item(key = "typing") {
            ChatTypingIndicatorBubble()
          }
        }

        items(count = messages.size, key = { idx -> messages[messages.size - 1 - idx].id }) { idx ->
          ChatMessageBubble(message = messages[messages.size - 1 - idx])
        }
      }

      if (messages.isEmpty() && pendingRunCount == 0 && pendingToolCalls.isEmpty() && streamingAssistantText.isNullOrBlank()) {
        EmptyChatHint(modifier = Modifier.align(Alignment.Center))
      }
    }
  }
}

@Composable
private fun EmptyChatHint(modifier: Modifier = Modifier) {
  Row(
    modifier = modifier.alpha(0.7f),
    verticalAlignment = Alignment.CenterVertically,
    horizontalArrangement = Arrangement.spacedBy(8.dp),
  ) {
    Icon(
      imageVector = Icons.Default.ArrowCircleDown,
      contentDescription = null,
      tint = MaterialTheme.colorScheme.onSurfaceVariant,
    )
    Text(
      text = "Message OpenClaw…",
      style = MaterialTheme.typography.bodyMedium,
      color = MaterialTheme.colorScheme.onSurfaceVariant,
    )
  }
}
