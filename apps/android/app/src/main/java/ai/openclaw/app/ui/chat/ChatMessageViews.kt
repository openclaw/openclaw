package ai.openclaw.app.ui.chat

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import ai.openclaw.app.chat.ChatCanvasPreview
import ai.openclaw.app.chat.ChatMessage
import ai.openclaw.app.chat.ChatMessageContent
import ai.openclaw.app.chat.ChatPendingToolCall
import ai.openclaw.app.chat.ChatTimelineMessageItem
import ai.openclaw.app.chat.ChatTimelineToolItem
import ai.openclaw.app.tools.ToolDisplayRegistry
import ai.openclaw.app.ui.mobileAccent
import ai.openclaw.app.ui.mobileAccentSoft
import ai.openclaw.app.ui.mobileBorder
import ai.openclaw.app.ui.mobileBorderStrong
import ai.openclaw.app.ui.mobileCallout
import ai.openclaw.app.ui.mobileCaption1
import ai.openclaw.app.ui.mobileCaption2
import ai.openclaw.app.ui.mobileCardSurface
import ai.openclaw.app.ui.mobileCodeBg
import ai.openclaw.app.ui.mobileCodeBorder
import ai.openclaw.app.ui.mobileCodeText
import ai.openclaw.app.ui.mobileText
import ai.openclaw.app.ui.mobileTextSecondary
import ai.openclaw.app.ui.mobileWarning
import ai.openclaw.app.ui.mobileWarningSoft
import java.util.Locale

private data class ChatBubbleStyle(
  val alignEnd: Boolean,
  val containerColor: Color,
  val borderColor: Color,
  val roleColor: Color,
)

@Composable
fun ChatTimelineMessageBubble(
  item: ChatTimelineMessageItem,
  uiState: ChatMessageUiState,
  onOpenCanvas: ((String) -> Unit)? = null,
  onRequestHideMessage: (String) -> Unit = {},
  onRequestDeleteMessage: (String) -> Unit = {},
  onConfirmDeleteMessage: (String) -> Unit = {},
  onCancelDeleteMessage: (String?) -> Unit = {},
  onToggleExpandedMessage: (String) -> Unit = {},
) {
  ChatMessageBubble(
    message = item.message,
    uiState = uiState,
    onOpenCanvas = onOpenCanvas,
    onRequestHideMessage = onRequestHideMessage,
    onRequestDeleteMessage = onRequestDeleteMessage,
    onConfirmDeleteMessage = onConfirmDeleteMessage,
    onCancelDeleteMessage = onCancelDeleteMessage,
    onToggleExpandedMessage = onToggleExpandedMessage,
  )
}

@Composable
fun ChatMessageBubble(
  message: ChatMessage,
  uiState: ChatMessageUiState = ChatMessageUiState(),
  onOpenCanvas: ((String) -> Unit)? = null,
  onRequestHideMessage: (String) -> Unit = {},
  onRequestDeleteMessage: (String) -> Unit = {},
  onConfirmDeleteMessage: (String) -> Unit = {},
  onCancelDeleteMessage: (String?) -> Unit = {},
  onToggleExpandedMessage: (String) -> Unit = {},
) {
  val role = message.role.trim().lowercase(Locale.US)
  val style = bubbleStyle(role)
  val displayableContent = remember(message, uiState) { filterDisplayableContent(message, uiState) }
  if (displayableContent.isEmpty()) return

  val meta = remember(message) { resolveChatMessageMeta(message) }
  val metaLine = remember(meta) { formatChatMessageMetaLine(meta) }
  val expanded = uiState.expandedMessageIds.contains(message.id)
  val needsExpansion = displayableContent.size > 1 || displayableContent.any { normalizeChatContentType(it.type) in setOf("thinking", "toolcall", "toolresult") }
  val visibleContent = if (expanded || !needsExpansion) displayableContent else listOf(displayableContent.first())
  val deletePending = uiState.pendingDeleteMessageId == message.id

  ChatBubbleContainer(style = style, roleLabel = meta.roleLabel) {
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
      if (!metaLine.isNullOrBlank()) {
        Text(text = metaLine, style = mobileCaption1, color = mobileTextSecondary)
      }

      ChatMessageBody(content = visibleContent, textColor = mobileText, onOpenCanvas = onOpenCanvas)

      if (needsExpansion) {
        BubbleActionLink(
          text = if (expanded) "Show less" else "Show more",
          onClick = { onToggleExpandedMessage(message.id) },
        )
      }

      if (deletePending) {
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
          Text(
            text = "Delete from this view?",
            style = mobileCaption1,
            color = mobileTextSecondary,
          )
          BubbleActionLink(text = "Confirm", accent = true, onClick = { onConfirmDeleteMessage(message.id) })
          BubbleActionLink(text = "Cancel", onClick = { onCancelDeleteMessage(message.id) })
        }
      } else {
        Row(horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.CenterVertically) {
          BubbleActionLink(text = "Hide", onClick = { onRequestHideMessage(message.id) })
          BubbleActionLink(text = "Delete", accent = true, onClick = { onRequestDeleteMessage(message.id) })
        }
      }
    }
  }
}

@Composable
fun ChatCompletedToolBubble(
  item: ChatTimelineToolItem,
  onOpenCanvas: ((String) -> Unit)? = null,
) {
  val context = LocalContext.current
  val display = remember(item.toolName, item.args, context) {
    ToolDisplayRegistry.resolve(context = context, name = item.toolName, args = item.args)
  }

  ChatBubbleContainer(
    style = bubbleStyle("assistant"),
    roleLabel = if (item.hasResult) "Tool output" else "Tool",
  ) {
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
      Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
        Text(
          text = "${display.emoji} ${display.label}",
          style = mobileCallout.copy(fontWeight = FontWeight.SemiBold),
          color = mobileText,
        )
        display.detailLine?.let { detail ->
          Text(
            text = detail,
            style = mobileCaption1,
            color = mobileTextSecondary,
            fontFamily = FontFamily.Monospace,
          )
        }
      }

      if (!item.inputText.isNullOrBlank()) {
        ChatCodeBlock(code = item.inputText, language = "json")
      }

      item.preview?.let { preview ->
        ChatCanvasPreviewCard(preview = preview, onOpenCanvas = onOpenCanvas)
      }

      if (!item.outputText.isNullOrBlank()) {
        ChatMarkdown(text = item.outputText, textColor = mobileText)
      } else if (item.preview != null) {
        Text(
          text = "Canvas preview available.",
          style = mobileCaption1,
          color = mobileTextSecondary,
        )
      }
    }
  }
}

@Composable
private fun ChatBubbleContainer(
  style: ChatBubbleStyle,
  roleLabel: String,
  modifier: Modifier = Modifier,
  content: @Composable () -> Unit,
) {
  Row(
    modifier = modifier.fillMaxWidth(),
    horizontalArrangement = if (style.alignEnd) Arrangement.End else Arrangement.Start,
  ) {
    Surface(
      shape = RoundedCornerShape(12.dp),
      border = BorderStroke(1.dp, style.borderColor),
      color = style.containerColor,
      tonalElevation = 0.dp,
      shadowElevation = 0.dp,
      modifier = Modifier.fillMaxWidth(0.90f),
    ) {
      Column(
        modifier = Modifier.padding(horizontal = 11.dp, vertical = 8.dp),
        verticalArrangement = Arrangement.spacedBy(3.dp),
      ) {
        Text(
          text = roleLabel,
          style = mobileCaption2.copy(fontWeight = FontWeight.SemiBold, letterSpacing = 0.6.sp),
          color = style.roleColor,
        )
        content()
      }
    }
  }
}

@Composable
private fun ChatMessageBody(
  content: List<ChatMessageContent>,
  textColor: Color,
  onOpenCanvas: ((String) -> Unit)?,
) {
  Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
    for (part in content) {
      when (normalizeChatContentType(part.type)) {
        "text" -> {
          val text = part.text ?: continue
          val inlineCanvasPreview = extractInlineCanvasPreview(text)
          if (inlineCanvasPreview != null) {
            ChatCanvasPreviewCard(preview = inlineCanvasPreview, onOpenCanvas = onOpenCanvas)
          } else {
            ChatMarkdown(text = text, textColor = textColor)
          }
        }
        "canvas" -> {
          val preview = part.canvasPreview ?: continue
          ChatCanvasPreviewCard(preview = preview, onOpenCanvas = onOpenCanvas)
        }
        "thinking" -> {
          val text = part.thinking ?: continue
          DiagnosticSectionCard(title = "Reasoning", tone = DiagnosticTone.Warning) {
            Text(text = text, style = mobileCallout, color = mobileText)
          }
        }
        "toolcall" -> {
          val text = part.toolArgumentsJson ?: part.rawText ?: "{}"
          DiagnosticSectionCard(
            title = part.toolName?.let { "Tool input · $it" } ?: "Tool input",
            tone = DiagnosticTone.Info,
          ) {
            ChatCodeBlock(code = text, language = "json")
          }
        }
        "toolresult" -> {
          val text = part.text ?: part.rawText ?: continue
          DiagnosticSectionCard(
            title = part.toolName?.let { "Tool result · $it" } ?: "Tool result",
            tone = DiagnosticTone.Info,
          ) {
            ChatMarkdown(text = text, textColor = mobileText)
          }
        }
        else -> {
          val b64 = part.base64 ?: continue
          ChatBase64Image(base64 = b64, mimeType = part.mimeType)
        }
      }
    }
  }
}

@Composable
private fun ChatCanvasPreviewCard(
  preview: ChatCanvasPreview,
  onOpenCanvas: ((String) -> Unit)?,
) {
  val openUrl = preview.url?.trim()?.takeIf { it.isNotEmpty() }
  Surface(
    shape = RoundedCornerShape(10.dp),
    border = BorderStroke(1.dp, mobileBorderStrong),
    color = mobileCardSurface,
    modifier = Modifier.fillMaxWidth(),
  ) {
    Column(
      modifier =
        Modifier
          .fillMaxWidth()
          .then(
            if (openUrl != null && onOpenCanvas != null) {
              Modifier.clickable { onOpenCanvas(openUrl) }
            } else {
              Modifier
            },
          )
          .padding(10.dp),
      verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
      Text(
        text = preview.title ?: "Canvas preview",
        style = mobileCallout.copy(fontWeight = FontWeight.SemiBold),
        color = mobileText,
      )
      preview.viewId?.let {
        Text(
          text = it,
          style = mobileCaption1,
          color = mobileTextSecondary,
          fontFamily = FontFamily.Monospace,
        )
      }
      Box(
        modifier =
          Modifier
            .fillMaxWidth()
            .background(mobileAccentSoft, RoundedCornerShape(8.dp))
            .padding(horizontal = 10.dp, vertical = 12.dp),
      ) {
        Text(
          text = if (openUrl != null && onOpenCanvas != null) "Tap to open on Screen tab" else "Canvas ready",
          style = mobileCaption1,
          color = mobileTextSecondary,
        )
      }
    }
  }
}

@Composable
fun ChatTypingIndicatorBubble() {
  ChatBubbleContainer(
    style = bubbleStyle("assistant"),
    roleLabel = roleLabel("assistant"),
  ) {
    Row(
      verticalAlignment = Alignment.CenterVertically,
      horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
      DotPulse(color = mobileTextSecondary)
      Text("Thinking...", style = mobileCallout, color = mobileTextSecondary)
    }
  }
}

@Composable
fun ChatPendingToolsBubble(toolCalls: List<ChatPendingToolCall>) {
  val context = LocalContext.current
  val displays =
    remember(toolCalls, context) {
      toolCalls.map { ToolDisplayRegistry.resolve(context, it.name, it.args) }
    }

  ChatBubbleContainer(
    style = bubbleStyle("assistant"),
    roleLabel = "Tools",
  ) {
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
      Text("Running tools...", style = mobileCaption1.copy(fontWeight = FontWeight.SemiBold), color = mobileTextSecondary)
      for (display in displays.take(6)) {
        Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
          Text(
            "${display.emoji} ${display.label}",
            style = mobileCallout,
            color = mobileTextSecondary,
            fontFamily = FontFamily.Monospace,
          )
          display.detailLine?.let { detail ->
            Text(
              detail,
              style = mobileCaption1,
              color = mobileTextSecondary,
              fontFamily = FontFamily.Monospace,
            )
          }
        }
      }
      if (toolCalls.size > 6) {
        Text(
          text = "... +${toolCalls.size - 6} more",
          style = mobileCaption1,
          color = mobileTextSecondary,
        )
      }
    }
  }
}

@Composable
fun ChatStreamingAssistantBubble(text: String) {
  ChatBubbleContainer(
    style = bubbleStyle("assistant").copy(borderColor = mobileAccent),
    roleLabel = "OpenClaw · Live",
  ) {
    ChatMarkdown(text = text, textColor = mobileText)
  }
}

@Composable
private fun ChatBase64Image(base64: String, mimeType: String?) {
  val imageState = rememberBase64ImageState(base64)
  val image = imageState.image

  if (image != null) {
    Surface(
      shape = RoundedCornerShape(10.dp),
      border = BorderStroke(1.dp, mobileBorder),
      color = mobileCardSurface,
      modifier = Modifier.fillMaxWidth(),
    ) {
      Image(
        bitmap = image,
        contentDescription = mimeType ?: "attachment",
        contentScale = ContentScale.Fit,
        modifier = Modifier.fillMaxWidth(),
      )
    }
  } else if (imageState.failed) {
    Text("Unsupported attachment", style = mobileCaption1, color = mobileTextSecondary)
  }
}

@Composable
private fun DotPulse(color: Color) {
  Row(horizontalArrangement = Arrangement.spacedBy(5.dp), verticalAlignment = Alignment.CenterVertically) {
    PulseDot(alpha = 0.38f, color = color)
    PulseDot(alpha = 0.62f, color = color)
    PulseDot(alpha = 0.90f, color = color)
  }
}

@Composable
private fun PulseDot(alpha: Float, color: Color) {
  Surface(
    modifier = Modifier.size(6.dp).alpha(alpha),
    shape = CircleShape,
    color = color,
  ) {}
}

@Composable
fun ChatCodeBlock(code: String, language: String?) {
  androidx.compose.foundation.text.selection.SelectionContainer {
    Surface(
      shape = RoundedCornerShape(8.dp),
      color = mobileCodeBg,
      border = BorderStroke(1.dp, mobileCodeBorder),
      modifier = Modifier.fillMaxWidth(),
    ) {
      Column(modifier = Modifier.padding(horizontal = 10.dp, vertical = 8.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        if (!language.isNullOrBlank()) {
          Text(
            text = language.uppercase(Locale.US),
            style = mobileCaption2.copy(letterSpacing = 0.4.sp),
            color = mobileTextSecondary,
          )
        }
        Text(
          text = code.trimEnd(),
          fontFamily = FontFamily.Monospace,
          style = mobileCallout,
          color = mobileCodeText,
        )
      }
    }
  }
}

@Composable
private fun BubbleActionLink(
  text: String,
  accent: Boolean = false,
  onClick: () -> Unit,
) {
  Text(
    text = text,
    style = mobileCaption1.copy(fontWeight = FontWeight.SemiBold),
    color = if (accent) mobileAccent else mobileTextSecondary,
    modifier = Modifier.clickable(onClick = onClick),
  )
}

private enum class DiagnosticTone {
  Info,
  Warning,
}

@Composable
private fun DiagnosticSectionCard(
  title: String,
  tone: DiagnosticTone,
  content: @Composable () -> Unit,
) {
  val borderColor = if (tone == DiagnosticTone.Warning) mobileWarning else mobileBorderStrong
  val surfaceColor = if (tone == DiagnosticTone.Warning) mobileWarningSoft else mobileCardSurface
  Surface(
    shape = RoundedCornerShape(10.dp),
    border = BorderStroke(1.dp, borderColor),
    color = surfaceColor,
    modifier = Modifier.fillMaxWidth(),
  ) {
    Column(
      modifier = Modifier.padding(horizontal = 10.dp, vertical = 9.dp),
      verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
      Text(
        text = title,
        style = mobileCaption1.copy(fontWeight = FontWeight.SemiBold),
        color = mobileTextSecondary,
      )
      content()
    }
  }
}

private fun filterDisplayableContent(
  message: ChatMessage,
  uiState: ChatMessageUiState,
): List<ChatMessageContent> {
  val role = message.role.trim().lowercase(Locale.US)
  val toolLikeRole = isToolLikeRole(role)
  val technical = isTechnicalMessage(message)
  return message.content.filter { part ->
    when (normalizeChatContentType(part.type)) {
      "text" -> if (toolLikeRole || technical) uiState.showToolDetails && !part.text.isNullOrBlank() else !part.text.isNullOrBlank()
      "canvas" -> if (toolLikeRole || technical) uiState.showToolDetails && part.canvasPreview != null else part.canvasPreview != null
      "thinking" -> uiState.showReasoning && !part.thinking.isNullOrBlank()
      "toolcall" -> uiState.showToolDetails && (!part.toolArgumentsJson.isNullOrBlank() || !part.rawText.isNullOrBlank() || !part.toolName.isNullOrBlank())
      "toolresult" -> uiState.showToolDetails && (!part.text.isNullOrBlank() || !part.rawText.isNullOrBlank())
      else -> if (toolLikeRole || technical) uiState.showToolDetails && part.base64 != null else part.base64 != null
    }
  }
}

private fun extractInlineCanvasPreview(text: String?): ChatCanvasPreview? {
  val trimmed = text?.trim()?.takeIf { it.isNotEmpty() } ?: return null
  val matchUrl = Regex("\"url\"\\s*:\\s*\"([^\"]+)\"").find(trimmed)?.groupValues?.getOrNull(1)
  val matchTitle = Regex("\"title\"\\s*:\\s*\"([^\"]+)\"").find(trimmed)?.groupValues?.getOrNull(1)
  val matchId = Regex("\"id\"\\s*:\\s*\"([^\"]+)\"").find(trimmed)?.groupValues?.getOrNull(1)
  if (!Regex("\"kind\"\\s*:\\s*\"canvas\"").containsMatchIn(trimmed) || matchUrl.isNullOrBlank()) return null
  return ChatCanvasPreview(
    title = matchTitle,
    url = matchUrl,
    viewId = matchId,
  )
}

@Composable
private fun bubbleStyle(role: String): ChatBubbleStyle {
  return when (role) {
    "user" ->
      ChatBubbleStyle(
        alignEnd = true,
        containerColor = mobileAccentSoft,
        borderColor = mobileAccent,
        roleColor = mobileAccent,
      )

    "system" ->
      ChatBubbleStyle(
        alignEnd = false,
        containerColor = mobileWarningSoft,
        borderColor = mobileWarning.copy(alpha = 0.45f),
        roleColor = mobileWarning,
      )

    else ->
      ChatBubbleStyle(
        alignEnd = false,
        containerColor = mobileCardSurface,
        borderColor = mobileBorderStrong,
        roleColor = mobileTextSecondary,
      )
  }
}

private fun roleLabel(role: String): String {
  return when (role) {
    "user" -> "You"
    "system" -> "System"
    else -> "OpenClaw"
  }
}
