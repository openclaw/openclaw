package ai.openclaw.android.ui.chat

import android.graphics.BitmapFactory
import android.util.Base64
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.Image
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
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import ai.openclaw.android.chat.ChatMessage
import ai.openclaw.android.chat.ChatMessageContent
import ai.openclaw.android.chat.ChatPendingToolCall
import ai.openclaw.android.tools.ToolDisplayRegistry
import ai.openclaw.android.ui.mobileAccent
import ai.openclaw.android.ui.mobileAccentSoft
import ai.openclaw.android.ui.mobileBorder
import ai.openclaw.android.ui.mobileBorderStrong
import ai.openclaw.android.ui.mobileCallout
import ai.openclaw.android.ui.mobileCaption1
import ai.openclaw.android.ui.mobileCaption2
import ai.openclaw.android.ui.mobileCodeBg
import ai.openclaw.android.ui.mobileCodeText
import ai.openclaw.android.ui.mobileHeadline
import ai.openclaw.android.ui.mobileText
import ai.openclaw.android.ui.mobileTextSecondary
import ai.openclaw.android.ui.mobileWarning
import ai.openclaw.android.ui.mobileWarningSoft
import java.util.Locale
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

private data class ChatBubbleStyle(
  val alignEnd: Boolean,
  val containerColor: Color,
  val borderColor: Color,
  val roleColor: Color,
)

@Composable
fun ChatMessageBubble(message: ChatMessage) {
  val role = message.role.trim().lowercase(Locale.US)
  val style = bubbleStyle(role)

  // Filter to only displayable content parts (text with content, or base64 images).
  val displayableContent =
    message.content.filter { part ->
      when (part.type) {
        "text" -> !part.text.isNullOrBlank()
        else -> part.base64 != null
      }
    }

  if (displayableContent.isEmpty()) return

  ChatBubbleContainer(style = style, roleLabel = roleLabel(role)) {
    ChatMessageBody(content = displayableContent, textColor = mobileText)
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
private fun ChatMessageBody(content: List<ChatMessageContent>, textColor: Color) {
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
    roleLabel = "TOOLS",
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
    roleLabel = "ASSISTANT · LIVE",
  ) {
    ChatMarkdown(text = text, textColor = mobileText)
  }
}

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
        containerColor = Color.White,
        borderColor = mobileBorderStrong,
        roleColor = mobileTextSecondary,
      )
  }
}

private fun roleLabel(role: String): String {
  return when (role) {
    "user" -> "USER"
    "system" -> "SYSTEM"
    else -> "ASSISTANT"
  }
}

@Composable
private fun ChatBase64Image(base64: String, mimeType: String?) {
  var image by remember(base64) { mutableStateOf<androidx.compose.ui.graphics.ImageBitmap?>(null) }
  var failed by remember(base64) { mutableStateOf(false) }

  LaunchedEffect(base64) {
    failed = false
    image =
      withContext(Dispatchers.Default) {
        try {
          val bytes = Base64.decode(base64, Base64.DEFAULT)
          val bitmap = BitmapFactory.decodeByteArray(bytes, 0, bytes.size) ?: return@withContext null
          bitmap.asImageBitmap()
        } catch (_: Throwable) {
          null
        }
      }
    if (image == null) failed = true
  }

  if (image != null) {
    Surface(
      shape = RoundedCornerShape(10.dp),
      border = BorderStroke(1.dp, mobileBorder),
      color = Color.White,
      modifier = Modifier.fillMaxWidth(),
    ) {
      Image(
        bitmap = image!!,
        contentDescription = mimeType ?: "attachment",
        contentScale = ContentScale.Fit,
        modifier = Modifier.fillMaxWidth(),
      )
    }
  } else if (failed) {
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
  Surface(
    shape = RoundedCornerShape(8.dp),
    color = mobileCodeBg,
    border = BorderStroke(1.dp, Color(0xFF2B2E35)),
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
