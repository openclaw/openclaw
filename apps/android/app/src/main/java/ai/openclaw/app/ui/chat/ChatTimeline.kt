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
  val contentVersion: String,
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
      contentVersion = "",
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
    contentVersion = items.joinToString(separator = "|", transform = ::chatTimelineItemVersion),
  )
}

internal fun chatTimelineItemKey(item: ChatTimelineItem): String =
  when (item) {
    is ChatTimelineItem.Message -> "message:${item.message.id}"
    is ChatTimelineItem.PendingTools -> "tools"
    is ChatTimelineItem.StreamingAssistant -> "stream"
    ChatTimelineItem.Thinking -> "thinking"
  }

private fun chatTimelineItemVersion(item: ChatTimelineItem): String =
  when (item) {
    is ChatTimelineItem.Message ->
      buildString {
        append("message:")
        append(item.message.id)
        append(':')
        append(item.message.role)
        append(':')
        append(item.message.timestampMs ?: "")
        append(':')
        item.message.content.forEach { content ->
          append(content.type)
          append('=')
          append(content.text?.length ?: 0)
          append(';')
        }
      }
    is ChatTimelineItem.PendingTools ->
      buildString {
        append("tools:")
        append(
          item.toolCalls.joinToString(separator = ",") { call ->
            "${call.toolCallId}:${call.name}:${call.isError}"
          },
        )
      }
    is ChatTimelineItem.StreamingAssistant -> "stream:${item.text.length}"
    ChatTimelineItem.Thinking -> "thinking"
  }
