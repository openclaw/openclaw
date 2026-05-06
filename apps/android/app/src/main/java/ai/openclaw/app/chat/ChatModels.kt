package ai.openclaw.app.chat

import kotlinx.serialization.json.JsonObject

data class ChatMessage(
  val id: String,
  val role: String,
  val content: List<ChatMessageContent>,
  val timestampMs: Long?,
  val sourceId: String? = null,
  val toolCallId: String? = null,
  val toolName: String? = null,
  val senderLabel: String? = null,
  val isError: Boolean? = null,
)

data class ChatCanvasPreview(
  val kind: String = "canvas",
  val surface: String = "assistant_message",
  val render: String = "url",
  val title: String? = null,
  val preferredHeight: Int? = null,
  val url: String? = null,
  val viewId: String? = null,
  val className: String? = null,
  val style: String? = null,
)

data class ChatMessageContent(
  val type: String = "text",
  val text: String? = null,
  val mimeType: String? = null,
  val fileName: String? = null,
  val base64: String? = null,
  val thinking: String? = null,
  val thinkingSignature: String? = null,
  val toolName: String? = null,
  val toolCallId: String? = null,
  val toolArgumentsJson: String? = null,
  val canvasPreview: ChatCanvasPreview? = null,
  val rawText: String? = null,
)

data class ChatPendingToolCall(
  val toolCallId: String,
  val name: String,
  val args: JsonObject? = null,
  val startedAtMs: Long,
  val isError: Boolean? = null,
)

data class ChatSessionEntry(
  val key: String,
  val updatedAtMs: Long?,
  val displayName: String? = null,
  val label: String? = null,
  val derivedTitle: String? = null,
  val model: String? = null,
  val topicId: String? = null,
  val channel: String? = null,
  val subject: String? = null,
  val chatType: String? = null,
  val lastThreadId: String? = null,
  val lastTo: String? = null,
  val lastChannel: String? = null,
  val modelProvider: String? = null,
  val thinkingLevel: String? = null,
  val reasoningLevel: String? = null,
  val contextTokens: Int? = null,
  val totalTokens: Int? = null,
  val totalTokensFresh: Boolean? = null,
)

data class ChatSessionDefaults(
  val model: String? = null,
  val modelProvider: String? = null,
)

data class ChatModelCatalogEntry(
  val id: String,
  val name: String,
  val provider: String,
  val alias: String? = null,
  val reasoning: Boolean? = null,
)

data class ChatHistory(
  val sessionKey: String,
  val sessionId: String?,
  val thinkingLevel: String?,
  val messages: List<ChatMessage>,
)

sealed interface ChatTimelineItem {
  val id: String
  val timestampMs: Long?
}

data class ChatTimelineMessageItem(
  override val id: String,
  val message: ChatMessage,
) : ChatTimelineItem {
  override val timestampMs: Long?
    get() = message.timestampMs
}

data class ChatTimelineToolItem(
  override val id: String,
  override val timestampMs: Long?,
  val toolCallId: String?,
  val toolName: String,
  val args: JsonObject? = null,
  val inputText: String? = null,
  val outputText: String? = null,
  val preview: ChatCanvasPreview? = null,
  val isError: Boolean? = null,
  val sourceMessageIds: List<String> = emptyList(),
  val completedAtMs: Long? = null,
) : ChatTimelineItem {
  val hasResult: Boolean
    get() = !outputText.isNullOrBlank() || preview != null || completedAtMs != null
}

data class OutgoingAttachment(
  val type: String,
  val mimeType: String,
  val fileName: String,
  val base64: String,
)

data class ChatCompactionStatus(
  val phase: Phase,
  val runId: String? = null,
  val startedAtMs: Long? = null,
  val completedAtMs: Long? = null,
) {
  enum class Phase {
    Active,
    Retrying,
    Complete,
  }
}

data class ChatFallbackStatus(
  val phase: Phase = Phase.Active,
  val selectedModel: String,
  val activeModel: String,
  val previousModel: String? = null,
  val reason: String? = null,
  val attempts: List<String> = emptyList(),
  val occurredAtMs: Long,
) {
  enum class Phase {
    Active,
    Cleared,
  }
}
