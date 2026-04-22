package ai.openclaw.app.ui.chat

import ai.openclaw.app.chat.ChatCompactionStatus
import ai.openclaw.app.chat.ChatFallbackStatus
import ai.openclaw.app.chat.ChatMessage
import ai.openclaw.app.chat.ChatMessageContent
import ai.openclaw.app.chat.ChatSessionEntry
import ai.openclaw.app.chat.ChatTimelineItem
import ai.openclaw.app.chat.ChatTimelineMessageItem
import ai.openclaw.app.chat.ChatTimelineToolItem
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

data class PendingImageAttachment(
  val id: String,
  val fileName: String,
  val mimeType: String,
  val base64: String,
)

data class ChatMessageUiState(
  val hiddenMessageIds: Set<String> = emptySet(),
  val showReasoning: Boolean = false,
  val showToolDetails: Boolean = false,
  val expandedMessageIds: Set<String> = emptySet(),
  val pendingDeleteMessageId: String? = null,
)

data class ChatMessageMeta(
  val roleLabel: String,
  val timestampLabel: String?,
  val sourceIdLabel: String?,
  val toolLabel: String?,
  val technical: Boolean,
)

data class ContextUsageNotice(
  val usedTokens: Int,
  val limitTokens: Int,
  val percentUsed: Int,
  val severity: Severity,
) {
  enum class Severity {
    Warning,
    Danger,
  }
}

data class ChatStatusNotice(
  val title: String,
  val detail: String,
  val tone: Tone,
) {
  enum class Tone {
    Info,
    Warning,
    Success,
  }
}

internal fun computeContextUsageNotice(
  session: ChatSessionEntry?,
  defaultContextTokens: Int? = null,
): ContextUsageNotice? {
  if (session?.totalTokensFresh == false) return null
  val used = session?.totalTokens ?: return null
  val limit = session.contextTokens ?: defaultContextTokens ?: return null
  if (used <= 0 || limit <= 0) return null
  val ratio = used.toDouble() / limit.toDouble()
  if (ratio < 0.85) return null
  return ContextUsageNotice(
    usedTokens = used,
    limitTokens = limit,
    percentUsed = minOf(100, (ratio * 100.0).toInt()),
    severity = if (ratio >= 0.95) ContextUsageNotice.Severity.Danger else ContextUsageNotice.Severity.Warning,
  )
}

internal fun buildChatStatusNotices(
  compactionStatus: ChatCompactionStatus?,
  fallbackStatus: ChatFallbackStatus?,
): List<ChatStatusNotice> {
  val notices = mutableListOf<ChatStatusNotice>()
  when (compactionStatus?.phase) {
    ChatCompactionStatus.Phase.Active -> {
      notices += ChatStatusNotice("Context", "Compacting context…", ChatStatusNotice.Tone.Warning)
    }
    ChatCompactionStatus.Phase.Retrying -> {
      notices += ChatStatusNotice("Context", "Compaction retrying…", ChatStatusNotice.Tone.Warning)
    }
    ChatCompactionStatus.Phase.Complete -> {
      notices += ChatStatusNotice("Context", "Context compacted", ChatStatusNotice.Tone.Success)
    }
    null -> Unit
  }

  fallbackStatus?.let { status ->
    val detail = buildString {
      if (status.phase == ChatFallbackStatus.Phase.Cleared) {
        append("Fallback cleared: ${status.selectedModel}")
        status.previousModel?.takeIf { it.isNotBlank() }?.let {
          append(" · was $it")
        }
      } else {
        append("Fallback active: ${status.activeModel}")
        if (status.selectedModel != status.activeModel) {
          append(" · requested ${status.selectedModel}")
        }
      }
      status.reason?.takeIf { it.isNotBlank() }?.let {
        append(" · ")
        append(it)
      }
      status.attempts.take(2).takeIf { it.isNotEmpty() }?.let {
        append(" · ")
        append(it.joinToString(" | "))
      }
    }
    notices +=
      ChatStatusNotice(
        title = "Model fallback",
        detail = detail,
        tone = if (status.phase == ChatFallbackStatus.Phase.Cleared) ChatStatusNotice.Tone.Success else ChatStatusNotice.Tone.Info,
      )
  }
  return notices
}

internal fun resolveChatMessageMeta(message: ChatMessage): ChatMessageMeta {
  val role = message.role.trim().lowercase(Locale.US)
  val roleLabel =
    when {
      role == "user" -> "You"
      role == "system" -> "System"
      isToolLikeRole(role) -> "Tool result"
      else -> "OpenClaw"
    }
  val timestampLabel =
    message.timestampMs?.let {
      SimpleDateFormat("HH:mm", Locale.US).format(Date(it))
    }
  val sourceIdLabel = message.sourceId?.trim()?.takeIf { it.isNotEmpty() }
  val toolLabel = message.toolName?.trim()?.takeIf { it.isNotEmpty() } ?: firstToolName(message.content)
  return ChatMessageMeta(
    roleLabel = roleLabel,
    timestampLabel = timestampLabel,
    sourceIdLabel = sourceIdLabel,
    toolLabel = toolLabel,
    technical = isTechnicalMessage(message),
  )
}

internal fun formatChatMessageMetaLine(meta: ChatMessageMeta): String? {
  val parts = buildList {
    meta.timestampLabel?.let(::add)
    meta.sourceIdLabel?.let { add("source $it") }
    meta.toolLabel?.let { add("tool $it") }
  }
  return parts.takeIf { it.isNotEmpty() }?.joinToString(" · ")
}

internal fun firstToolName(content: List<ChatMessageContent>): String? {
  return content.firstNotNullOfOrNull { part ->
    part.toolName?.trim()?.takeIf { it.isNotEmpty() }
  }
}

internal fun shouldDisplayMessage(
  message: ChatMessage,
  uiState: ChatMessageUiState,
): Boolean {
  if (uiState.hiddenMessageIds.contains(message.id)) return false
  val role = message.role.trim().lowercase(Locale.US)
  val technical = isTechnicalMessage(message)
  if ((isToolLikeRole(role) || technical) && !uiState.showToolDetails) return false
  val hasVisibleContent =
    message.content.any { part ->
      when (normalizeChatContentType(part.type)) {
        "thinking" -> uiState.showReasoning && !part.thinking.isNullOrBlank()
        "toolcall" -> uiState.showToolDetails && (!part.toolArgumentsJson.isNullOrBlank() || !part.rawText.isNullOrBlank() || !part.toolName.isNullOrBlank())
        "toolresult" -> uiState.showToolDetails && (!part.text.isNullOrBlank() || !part.rawText.isNullOrBlank())
        "text" -> if (isToolLikeRole(role) || technical) uiState.showToolDetails && !part.text.isNullOrBlank() else !part.text.isNullOrBlank()
        else -> if (isToolLikeRole(role) || technical) uiState.showToolDetails && (!part.base64.isNullOrBlank() || part.canvasPreview != null) else !part.base64.isNullOrBlank() || part.canvasPreview != null
      }
    }
  return hasVisibleContent
}

internal fun shouldDisplayTimelineItem(
  item: ChatTimelineItem,
  uiState: ChatMessageUiState,
): Boolean {
  return when (item) {
    is ChatTimelineMessageItem -> shouldDisplayMessage(item.message, uiState)
    is ChatTimelineToolItem -> {
      uiState.showToolDetails && item.sourceMessageIds.none(uiState.hiddenMessageIds::contains)
    }
  }
}

internal fun requestDeleteMessage(
  uiState: ChatMessageUiState,
  messageId: String,
): ChatMessageUiState {
  val trimmed = messageId.trim()
  if (trimmed.isEmpty()) return uiState
  return uiState.copy(pendingDeleteMessageId = trimmed)
}

internal fun cancelDeleteMessage(
  uiState: ChatMessageUiState,
  messageId: String? = uiState.pendingDeleteMessageId,
): ChatMessageUiState {
  val pending = uiState.pendingDeleteMessageId ?: return uiState
  if (messageId != null && pending != messageId) return uiState
  return uiState.copy(pendingDeleteMessageId = null)
}

internal fun hideMessage(
  uiState: ChatMessageUiState,
  messageId: String,
): ChatMessageUiState {
  val trimmed = messageId.trim()
  if (trimmed.isEmpty()) return uiState
  return uiState.copy(
    hiddenMessageIds = uiState.hiddenMessageIds + trimmed,
    expandedMessageIds = uiState.expandedMessageIds - trimmed,
    pendingDeleteMessageId = if (uiState.pendingDeleteMessageId == trimmed) null else uiState.pendingDeleteMessageId,
  )
}

internal fun confirmDeleteMessage(
  uiState: ChatMessageUiState,
  messageId: String,
): ChatMessageUiState {
  val trimmed = messageId.trim()
  if (trimmed.isEmpty() || uiState.pendingDeleteMessageId != trimmed) return uiState
  return hideMessage(uiState.copy(pendingDeleteMessageId = null), trimmed)
}

internal fun clearHiddenMessages(uiState: ChatMessageUiState): ChatMessageUiState {
  return uiState.copy(hiddenMessageIds = emptySet(), pendingDeleteMessageId = null)
}

internal fun toggleShowReasoning(uiState: ChatMessageUiState): ChatMessageUiState {
  return uiState.copy(showReasoning = !uiState.showReasoning)
}

internal fun toggleShowToolDetails(uiState: ChatMessageUiState): ChatMessageUiState {
  return uiState.copy(showToolDetails = !uiState.showToolDetails)
}

internal fun toggleExpandedMessage(
  uiState: ChatMessageUiState,
  messageId: String,
): ChatMessageUiState {
  val trimmed = messageId.trim()
  if (trimmed.isEmpty()) return uiState
  val expanded = uiState.expandedMessageIds
  return uiState.copy(
    expandedMessageIds = if (trimmed in expanded) expanded - trimmed else expanded + trimmed,
  )
}

internal fun normalizeChatContentType(type: String): String {
  return type.trim().replace("_", "").replace("-", "").lowercase(Locale.US)
}

internal fun isToolLikeRole(role: String): Boolean {
  val normalized = role.trim().lowercase(Locale.US)
  return normalized == "toolresult" || normalized == "tool_result" || normalized == "tool" || normalized == "function"
}

internal fun isTechnicalMessage(message: ChatMessage): Boolean {
  val role = message.role.trim().lowercase(Locale.US)
  if (role == "system") return true
  if (isToolLikeRole(role)) return true

  val sender = message.senderLabel?.trim().orEmpty().lowercase(Locale.US)
  if (
    sender.contains("subagent") ||
    sender == "system" ||
    sender.startsWith("system:") ||
    sender.startsWith("system (")
  ) {
    return true
  }

  val sourceId = message.sourceId?.trim().orEmpty().lowercase(Locale.US)
  if (
    sourceId.contains(":subagent:") ||
    sourceId.contains(":cron:") ||
    sourceId.startsWith("system")
  ) {
    return true
  }

  if (!message.toolCallId.isNullOrBlank() || !message.toolName.isNullOrBlank()) return true

  return message.content.any { part ->
    normalizeChatContentType(part.type) == "text" &&
      isSystemPrefixedText(part.text)
  }
}

private fun isSystemPrefixedText(text: String?): Boolean {
  val trimmed = text?.trim().orEmpty()
  if (trimmed.isEmpty()) return false
  return trimmed.startsWith("System:", ignoreCase = true) ||
    trimmed.startsWith("System (", ignoreCase = true) ||
    trimmed.startsWith("<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>", ignoreCase = true)
}
