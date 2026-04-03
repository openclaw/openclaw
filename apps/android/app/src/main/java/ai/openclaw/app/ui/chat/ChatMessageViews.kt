package ai.openclaw.app.ui.chat

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
import androidx.compose.runtime.remember
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.input.pointer.pointerInput
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
import ai.openclaw.app.chat.ChatMessage
import ai.openclaw.app.chat.ChatMessageContent
import ai.openclaw.app.chat.ChatPendingToolCall
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
import ai.openclaw.app.ui.mobileHeadline
import ai.openclaw.app.ui.mobileText
import ai.openclaw.app.ui.mobileTextSecondary
import ai.openclaw.app.ui.mobileWarning
import ai.openclaw.app.ui.mobileWarningSoft
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.gestures.waitForUpOrCancellation
import androidx.compose.foundation.layout.heightIn
import kotlinx.coroutines.withTimeoutOrNull
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.TextButton
import java.util.Locale
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.width
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Reply
import androidx.compose.material.icons.filled.ContentCopy
import androidx.compose.material.icons.filled.SelectAll
import androidx.compose.material.icons.filled.Share
import androidx.compose.material3.BottomSheetDefaults
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.ui.graphics.vector.ImageVector

private data class ChatBubbleStyle(
  val alignEnd: Boolean,
  val containerColor: Color,
  val borderColor: Color,
  val roleColor: Color,
)

@Composable
fun ChatMessageBubble(message: ChatMessage, onReply: (ChatMessage) -> Unit = {}) {
  val role = message.role.trim().lowercase(Locale.US)
  val style = bubbleStyle(role)
  var showContextMenu by remember { mutableStateOf(false) }
  var selectCopyText by remember { mutableStateOf<String?>(null) }

  // Filter to only displayable content parts (text with content, or base64 images).
  val displayableContent =
    message.content.filter { part ->
      when (part.type) {
        "text" -> !part.text.isNullOrBlank()
        else -> part.base64 != null
      }
    }

  if (displayableContent.isEmpty()) return

  Box {
    ChatBubbleContainer(
      style = style,
      roleLabel = roleLabel(role),
      onLongPress = { showContextMenu = true }
    ) {
      ChatMessageBody(content = displayableContent, textColor = mobileText)
    }

    ChatContextMenu(
      isVisible = showContextMenu,
      onDismiss = { showContextMenu = false },
      message = message,
      onSelectCopy = { textSelection -> selectCopyText = textSelection },
      onReply = { messageToReply -> onReply(messageToReply) }
    )

    selectCopyText?.let { textToCopy ->
      ChatSelectCopyDialog(
        text = textToCopy,
        onDismiss = { selectCopyText = null }
      )
    }

  }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ChatContextMenu(
  isVisible: Boolean,
  onDismiss: () -> Unit,
  message: ChatMessage,
  onSelectCopy: (String) -> Unit,
  onReply: (ChatMessage) -> Unit,
) {
  if (!isVisible) return

  val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)
  val context = LocalContext.current
  val fullText = message.content.filter { it.type == "text" }.joinToString("\n") { it.text ?: "" }

  ModalBottomSheet(
    onDismissRequest = onDismiss,
    sheetState = sheetState,
    dragHandle = { BottomSheetDefaults.DragHandle() },
  ) {
    Column(
      modifier = Modifier
        .fillMaxWidth()
        .padding(bottom = 16.dp)
    ) {
      ContextMenuItem(
        icon = Icons.AutoMirrored.Filled.Reply,
        label = "Reply",
        onClick = {
          onReply(message)
          onDismiss()
        }
      )
      if (fullText.isNotBlank()) {
        ContextMenuItem(
          icon = Icons.Default.ContentCopy,
          label = "Copy",
          onClick = {
            copyToClipboard(context, fullText)
            onDismiss()
          }
        )
        ContextMenuItem(
          icon = Icons.Default.SelectAll,
          label = "Select Copy",
          onClick = {
            onSelectCopy(fullText)
            onDismiss()
          }
        )
        ContextMenuItem(
          icon = Icons.Default.Share,
          label = "Share",
          onClick = {
            shareText(context, fullText)
            onDismiss()
          }
        )
      }
    }
  }
}

@Composable
private fun ContextMenuItem(
  icon: ImageVector,
  label: String,
  onClick: () -> Unit
) {
  Row(
    modifier = Modifier
      .fillMaxWidth()
      .clickable(onClick = onClick)
      .padding(horizontal = 24.dp, vertical = 16.dp),
    verticalAlignment = Alignment.CenterVertically
  ) {
    Icon(
      imageVector = icon,
      contentDescription = null,
      tint = mobileText,
      modifier = Modifier.size(24.dp)
    )
    Spacer(modifier = Modifier.width(20.dp))
    Text(
      text = label,
      style = mobileCallout.copy(fontWeight = FontWeight.Medium, fontSize = 16.sp),
      color = mobileText
    )
  }
}

private fun copyToClipboard(context: Context, text: String) {
  val clipboard = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
  val clip = ClipData.newPlainText("OpenClaw Message", text)
  clipboard.setPrimaryClip(clip)
}

private fun shareText(context: Context, text: String) {
  val sendIntent = Intent().apply {
    action = Intent.ACTION_SEND
    putExtra(Intent.EXTRA_TEXT, text)
    type = "text/plain"
  }
  val shareIntent = Intent.createChooser(sendIntent, null)
  context.startActivity(shareIntent)
}

@Composable
fun ChatSelectCopyDialog(
  text: String,
  onDismiss: () -> Unit,
) {
  AlertDialog(
    onDismissRequest = onDismiss,
    confirmButton = {
      TextButton(onClick = onDismiss) {
        Text("Done")
      }
    },
    title = {
      Text("Select Text to Copy")
    },
    text = {
      Box(
        modifier = Modifier
          .fillMaxWidth()
          .heightIn(max = 300.dp)
          .verticalScroll(rememberScrollState())
      ) {
        SelectionContainer {
          ChatMarkdown(text = text, textColor = mobileText)
        }
      }
    }
  )
}

@Composable
private fun ChatBubbleContainer(
  style: ChatBubbleStyle,
  roleLabel: String,
  modifier: Modifier = Modifier,
  onLongPress: (() -> Unit)? = null,
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
      modifier = Modifier
        .fillMaxWidth(0.90f)
        .pointerInput(onLongPress) {
          awaitEachGesture {
            awaitFirstDown(requireUnconsumed = false)
            val longPressTimeout = withTimeoutOrNull(viewConfiguration.longPressTimeoutMillis) {
              waitForUpOrCancellation()
              true
            }
            if (longPressTimeout == null) {
              onLongPress?.invoke()
            }
          }
        },
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
