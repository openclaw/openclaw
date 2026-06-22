package ai.openclaw.app.ui.chat

import ai.openclaw.app.chat.ChatMessageContent
import ai.openclaw.app.chat.ChatPendingToolCall
import ai.openclaw.app.tools.ToolDisplayRegistry
import ai.openclaw.app.ui.mobileAccent
import ai.openclaw.app.ui.mobileAccentSoft
import ai.openclaw.app.ui.mobileBorder
import ai.openclaw.app.ui.mobileCallout
import ai.openclaw.app.ui.mobileCaption1
import ai.openclaw.app.ui.mobileCaption2
import ai.openclaw.app.ui.mobileCardSurface
import ai.openclaw.app.ui.mobileCodeBg
import ai.openclaw.app.ui.mobileCodeBorder
import ai.openclaw.app.ui.mobileCodeText
import ai.openclaw.app.ui.mobileHeadline
import ai.openclaw.app.ui.mobileText
import ai.openclaw.app.ui.mobileTextSecondary
import ai.openclaw.app.ui.mobileWarning
import ai.openclaw.app.ui.mobileWarningSoft
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
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
import java.util.Locale

private data class ChatBubbleStyle(
  val alignEnd: Boolean,
  val containerColor: Color,
  val borderColor: Color,
  val roleColor: Color,
)

/** Renders one persisted chat message as text and image parts. */
@Composable
fun ChatMessageBubble(message: ai.openclaw.app.chat.ChatMessage) {
  val role = message.role.trim().lowercase(Locale.US)

  val displayableContent =
    message.content.filter { part ->
      when (part.type) {
        "text" -> !part.text.isNullOrBlank()
        "image" -> !part.base64.isNullOrBlank()
        else -> false
      }
    }

  if (displayableContent.isEmpty()) return

  val style = bubbleStyle(role)

  ChatBubbleContainer(style = style) {
    ChatMessageBody(content = displayableContent, textColor = mobileText)
  }
}

// ── ChatGPT-style bubble container ────────────────────────────────────────

@Composable
private fun ChatBubbleContainer(
  style: ChatBubbleStyle,
  modifier: Modifier = Modifier,
  content: @Composable () -> Unit,
) {
  val bubbleShape =
    RoundedCornerShape(
      topStart = if (style.alignEnd) 20.dp else 4.dp,
      topEnd = if (style.alignEnd) 4.dp else 20.dp,
      bottomStart = 20.dp,
      bottomEnd = 20.dp,
    )

  Row(
    modifier = modifier.fillMaxWidth().padding(horizontal = 14.dp),
    horizontalArrangement = if (style.alignEnd) Arrangement.End else Arrangement.Start,
  ) {
    Surface(
      shape = bubbleShape,
      border = if (style.borderColor != Color.Transparent) BorderStroke(1.dp, style.borderColor) else null,
      color = style.containerColor,
      tonalElevation = 0.dp,
      shadowElevation = 0.dp,
      modifier = Modifier.widthIn(max = 520.dp),
    ) {
      Column(
        modifier = Modifier.padding(horizontal = 16.dp, vertical = 14.dp),
        verticalArrangement = Arrangement.spacedBy(6.dp),
      ) {
        content()
      }
    }
  }
}

@Composable
private fun ChatMessageBody(
  content: List<ChatMessageContent>,
  textColor: Color,
) {
  Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
    for (part in content) {
      when (part.type) {
        "text" -> {
          val text = part.text ?: continue
          ChatMarkdown(text = text, textColor = textColor)
        }
        else -> {
          val b64 = part.base64 ?: continue
          ChatBase64Image(base64 = b64, mimeType = part.mimeType)
        }
      }
    }
  }
}

// ── Thinking indicator (animated pulsing dots) ─────────────────────────────

@Composable
fun ChatTypingIndicatorBubble() {
  Row(
    modifier = Modifier.padding(horizontal = 14.dp, vertical = 6.dp),
    verticalAlignment = Alignment.CenterVertically,
    horizontalArrangement = Arrangement.spacedBy(4.dp),
  ) {
    PulseDot(alpha = 0.38f, color = mobileTextSecondary)
    PulseDot(alpha = 0.62f, color = mobileTextSecondary)
    PulseDot(alpha = 0.90f, color = mobileTextSecondary)
  }
}

// ── Pending tools (grouped, compact, non-intrusive) ───────────────────────

@Composable
fun ChatPendingToolsBubble(toolCalls: List<ChatPendingToolCall>) {
  val context = LocalContext.current
  val displays =
    remember(toolCalls, context) {
      toolCalls.map { ToolDisplayRegistry.resolve(context, it.name, it.args) }
    }

  val total = toolCalls.size
  val collapsed = total > 2
  val visibleDisplays = if (collapsed) displays.take(2) else displays

  Row(
    modifier = Modifier.padding(horizontal = 14.dp, vertical = 2.dp),
    horizontalArrangement = Arrangement.Start,
  ) {
    Surface(
      shape = RoundedCornerShape(topStart = 4.dp, topEnd = 16.dp, bottomStart = 16.dp, bottomEnd = 16.dp),
      border = BorderStroke(1.dp, mobileBorder.copy(alpha = 0.25f)),
      color = mobileCardSurface.copy(alpha = 0.6f),
      modifier = Modifier.widthIn(max = 420.dp),
    ) {
      Column(
        modifier = Modifier.padding(horizontal = 14.dp, vertical = 10.dp),
        verticalArrangement = Arrangement.spacedBy(3.dp),
      ) {
        // Header
        Row(
          verticalAlignment = Alignment.CenterVertically,
          horizontalArrangement = Arrangement.spacedBy(6.dp),
        ) {
          Box(
            modifier =
              Modifier
                .size(5.dp)
                .background(mobileWarning, RoundedCornerShape(999.dp)),
          )
          Text(
            text = "Ran $total tool${if (total != 1) "s" else ""}",
            style = mobileCaption1.copy(fontWeight = FontWeight.Medium),
            color = mobileTextSecondary,
          )
        }

        // Tool names (compact, monospace)
        visibleDisplays.forEach { display ->
          Row(
            modifier = Modifier.padding(start = 11.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(4.dp),
          ) {
            Text(
              text = "·",
              style = mobileCaption1.copy(fontSize = 12.sp),
              color = mobileTextSecondary.copy(alpha = 0.5f),
            )
            Text(
              text = display.label,
              style = mobileCaption1.copy(fontFamily = FontFamily.Monospace),
              color = mobileTextSecondary,
              maxLines = 1,
            )
          }
        }

        // Expand/collapse for >2 tools
        if (total > 2) {
          Text(
            text = if (collapsed) "… +${total - 2} more" else "Show less",
            style = mobileCaption1.copy(fontSize = 11.sp),
            color = mobileTextSecondary.copy(alpha = 0.6f),
            modifier = Modifier.padding(start = 11.dp),
          )
        }
      }
    }
  }
}

// ── Streaming assistant bubble ─────────────────────────────────────────────

@Composable
fun ChatStreamingAssistantBubble(text: String) {
  ChatBubbleContainer(
    style = bubbleStyle("assistant").copy(borderColor = mobileAccent.copy(alpha = 0.4f)),
  ) {
    ChatMarkdown(text = text, textColor = mobileText)
  }
}

// ── Bubble style mapping ──────────────────────────────────────────────────

@Composable
private fun bubbleStyle(role: String): ChatBubbleStyle =
  when (role) {
    "user" ->
      ChatBubbleStyle(
        alignEnd = true,
        containerColor = mobileAccentSoft.copy(alpha = 0.8f),
        borderColor = Color.Transparent,
        roleColor = mobileAccent,
      )

    "system" ->
      ChatBubbleStyle(
        alignEnd = false,
        containerColor = mobileWarningSoft,
        borderColor = mobileWarning.copy(alpha = 0.30f),
        roleColor = mobileWarning,
      )

    else ->
      ChatBubbleStyle(
        alignEnd = false,
        containerColor = Color.Transparent,
        borderColor = mobileBorder.copy(alpha = 0.3f),
        roleColor = mobileTextSecondary,
      )
  }

// ── Inline base64 image ──────────────────────────────────────────────────

@Composable
private fun ChatBase64Image(
  base64: String,
  mimeType: String?,
) {
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

// ── Dot pulse (used by typing indicator) ──────────────────────────────────

@Composable
fun DotPulse(color: Color) {
  Row(horizontalArrangement = Arrangement.spacedBy(5.dp), verticalAlignment = Alignment.CenterVertically) {
    PulseDot(alpha = 0.38f, color = color)
    PulseDot(alpha = 0.62f, color = color)
    PulseDot(alpha = 0.90f, color = color)
  }
}

@Composable
private fun PulseDot(
  alpha: Float,
  color: Color,
) {
  Surface(
    modifier = Modifier.size(6.dp).alpha(alpha),
    shape = CircleShape,
    color = color,
  ) {}
}

// ── Code block (used by ChatMarkdown) ─────────────────────────────────────

@Composable
fun ChatCodeBlock(
  code: String,
  language: String?,
) {
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
