package ai.openclaw.app.ui.chat

import ai.openclaw.app.chat.ChatMessage
import ai.openclaw.app.chat.ChatPendingToolCall

internal sealed class ChatTimelineItem {
  data class Message(
    val message: ChatMessage,
  ) : ChatTimelineItem()

  data class StreamingAssistant(
    val text: String,
  ) : ChatTimelineItem()

  data class PendingTools(
    val toolCalls: List<ChatPendingToolCall>,
  ) : ChatTimelineItem()

  object Thinking : ChatTimelineItem()
}

internal data class ChatTimeline(
  val items: List<ChatTimelineItem>,
  val scrollTargetIndex: Int?,
  val latestContentIndex: Int?,
  val initialScrollIndex: Int?,
  val latestUserMessageId: String?,
  val latestContentVersion: String,
)

internal fun buildChatTimeline(
  messages: List<ChatMessage>,
  pendingRunCount: Int,
  pendingToolCalls: List<ChatPendingToolCall>,
  streamingAssistantText: String?,
): ChatTimeline {
  val stream = streamingAssistantText?.trim()?.takeIf { it.isNotEmpty() }
  val hasActiveRun = pendingRunCount > 0 || pendingToolCalls.isNotEmpty() || stream != null
  val items =
    buildList {
      if (stream != null) add(ChatTimelineItem.StreamingAssistant(stream))
      if (pendingToolCalls.isNotEmpty()) add(ChatTimelineItem.PendingTools(pendingToolCalls))
      if (pendingRunCount > 0) add(ChatTimelineItem.Thinking)
      messages.asReversed().forEach { message -> add(ChatTimelineItem.Message(message)) }
    }
  if (items.isEmpty()) {
    return ChatTimeline(
      items = items,
      scrollTargetIndex = null,
      latestContentIndex = null,
      initialScrollIndex = null,
      latestUserMessageId = null,
      latestContentVersion = "",
    )
  }

  // In reverseLayout, index 0 is bottom-most. During an active run, keep the prompt
  // anchored so streaming/tool rows do not immediately push the just-sent message away.
  val activePromptIndex =
    if (hasActiveRun) {
      items.indexOfFirst { item ->
        item is ChatTimelineItem.Message &&
          item.message.role
            .trim()
            .equals("user", ignoreCase = true)
      }
    } else {
      -1
    }
  val latestUserMessage =
    items.firstNotNullOfOrNull { item ->
      val message = (item as? ChatTimelineItem.Message)?.message ?: return@firstNotNullOfOrNull null
      message.takeIf { it.role.trim().equals("user", ignoreCase = true) }
    }
  val latestUserIndex =
    items.indexOfFirst { item ->
      item is ChatTimelineItem.Message &&
        item.message.id == latestUserMessage?.id
    }
  val latestContentIndex = 0
  val scrollTargetIndex = activePromptIndex.takeIf { it >= 0 } ?: latestContentIndex

  return ChatTimeline(
    items = items,
    scrollTargetIndex = scrollTargetIndex,
    latestContentIndex = latestContentIndex,
    initialScrollIndex = latestUserIndex.takeIf { it >= 0 } ?: scrollTargetIndex,
    latestUserMessageId = latestUserMessage?.id,
    latestContentVersion = latestContentVersion(messages, pendingRunCount, pendingToolCalls, stream),
  )
}

// Reader restoration only needs to detect changes at the live edge. Avoid hashing
// the full transcript whenever a streamed response updates.
private fun latestContentVersion(
  messages: List<ChatMessage>,
  pendingRunCount: Int,
  pendingToolCalls: List<ChatPendingToolCall>,
  stream: String?,
): String {
  val latest = messages.lastOrNull()
  return buildString {
    append(messages.size)
    append(':')
    append(latest?.id.orEmpty())
    append(':')
    append(latest?.role.orEmpty())
    append(':')
    append(latest?.timestampMs ?: "")
    latest?.content?.forEach { content ->
      append(':')
      append(content.type)
      append('=')
      append(content.text?.hashCode() ?: 0)
      append(',')
      append(content.mimeType.orEmpty())
      append(',')
      append(content.fileName.orEmpty())
      append(',')
      append(content.base64?.length ?: 0)
    }
    append(":runs=")
    append(pendingRunCount)
    append(":tools=")
    pendingToolCalls.forEach { call ->
      append(call.toolCallId)
      append(',')
      append(call.name)
      append(',')
      append(call.isError)
      append(';')
    }
    append(":stream=")
    append(stream?.hashCode() ?: 0)
  }
}

internal fun chatTimelineItemKey(item: ChatTimelineItem): String =
  when (item) {
    is ChatTimelineItem.Message -> "message:${item.message.id}"
    is ChatTimelineItem.PendingTools -> "tools"
    is ChatTimelineItem.StreamingAssistant -> "stream"
    ChatTimelineItem.Thinking -> "thinking"
  }
