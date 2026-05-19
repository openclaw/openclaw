package ai.openclaw.app.ui.chat

import ai.openclaw.app.MainViewModel
import ai.openclaw.app.chat.ChatMessage
import ai.openclaw.app.chat.ChatMessageContent
import ai.openclaw.app.chat.ChatPendingToolCall
import ai.openclaw.app.ui.design.ClawListItem
import ai.openclaw.app.ui.design.ClawPanel
import ai.openclaw.app.ui.design.ClawStatus
import ai.openclaw.app.ui.design.ClawStatusPill
import ai.openclaw.app.ui.design.ClawTheme
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material.icons.filled.AttachFile
import androidx.compose.material.icons.filled.Mic
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.StarBorder
import androidx.compose.material3.Icon
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.launch
import java.text.DateFormat
import java.util.Date
import java.util.Locale

@Composable
fun V2ChatScreen(
  viewModel: MainViewModel,
  onBack: () -> Unit,
  onVoice: () -> Unit,
) {
  val messages by viewModel.chatMessages.collectAsState()
  val errorText by viewModel.chatError.collectAsState()
  val pendingRunCount by viewModel.pendingRunCount.collectAsState()
  val healthOk by viewModel.chatHealthOk.collectAsState()
  val sessionKey by viewModel.chatSessionKey.collectAsState()
  val mainSessionKey by viewModel.mainSessionKey.collectAsState()
  val thinkingLevel by viewModel.chatThinkingLevel.collectAsState()
  val streamingAssistantText by viewModel.chatStreamingAssistantText.collectAsState()
  val pendingToolCalls by viewModel.chatPendingToolCalls.collectAsState()
  val sessions by viewModel.chatSessions.collectAsState()
  val chatDraft by viewModel.chatDraft.collectAsState()
  val pendingAssistantAutoSend by viewModel.pendingAssistantAutoSend.collectAsState()
  val scope = rememberCoroutineScope()

  LaunchedEffect(Unit) {
    viewModel.loadChat(mainSessionKey)
    viewModel.refreshChatSessions(limit = 100)
  }

  LaunchedEffect(pendingAssistantAutoSend, healthOk, pendingRunCount, thinkingLevel) {
    val accepted =
      dispatchPendingAssistantAutoSend(
        pendingPrompt = pendingAssistantAutoSend,
        healthOk = healthOk,
        pendingRunCount = pendingRunCount,
      ) { prompt ->
        viewModel.sendChatAwaitAcceptance(message = prompt, thinking = thinkingLevel, attachments = emptyList())
      }
    if (accepted) {
      viewModel.clearPendingAssistantAutoSend()
    }
  }

  var input by rememberSaveable { mutableStateOf("") }

  LaunchedEffect(chatDraft) {
    val draft = chatDraft?.trim()?.ifEmpty { null } ?: return@LaunchedEffect
    input = draft
    viewModel.clearChatDraft()
  }

  Column(
    modifier =
      Modifier
        .fillMaxSize()
        .padding(horizontal = 18.dp, vertical = 6.dp),
    verticalArrangement = Arrangement.spacedBy(5.dp),
  ) {
    V2ChatHeader(
      sessionTitle = currentSessionTitle(sessionKey = sessionKey, sessions = sessions),
      thinkingLevel = thinkingLevel,
      healthOk = healthOk,
      pendingRunCount = pendingRunCount,
      onBack = onBack,
      onPin = {},
      onMore = {
        viewModel.refreshChat()
        viewModel.refreshChatSessions(limit = 100)
      },
    )

    errorText?.takeIf { it.isNotBlank() }?.let { error ->
      V2ChatNotice(title = "Chat needs attention", body = userFacingChatError(error))
    }

    V2ChatMessageList(
      messages = messages,
      pendingRunCount = pendingRunCount,
      pendingToolCalls = pendingToolCalls,
      streamingAssistantText = streamingAssistantText,
      healthOk = healthOk,
      modifier = Modifier.weight(1f),
    )

    V2ChatComposer(
      value = input,
      onValueChange = { input = it },
      thinkingLevel = thinkingLevel,
      healthOk = healthOk,
      pendingRunCount = pendingRunCount,
      onThinkingLevelChange = viewModel::setChatThinkingLevel,
      onVoice = onVoice,
      onAbort = viewModel::abortChat,
      onSend = {
        val message = input.trim()
        if (message.isEmpty()) return@V2ChatComposer
        input = ""
        scope.launch {
          viewModel.sendChat(message = message, thinking = thinkingLevel, attachments = emptyList())
        }
      },
    )
  }
}

@Composable
private fun V2ChatHeader(
  sessionTitle: String,
  thinkingLevel: String,
  healthOk: Boolean,
  pendingRunCount: Int,
  onBack: () -> Unit,
  onPin: () -> Unit,
  onMore: () -> Unit,
) {
  Row(
    modifier = Modifier.fillMaxWidth(),
    verticalAlignment = Alignment.CenterVertically,
    horizontalArrangement = Arrangement.spacedBy(6.dp),
  ) {
    V2HeaderIcon(icon = Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back", onClick = onBack)

    Column(
      modifier = Modifier.weight(1f),
      horizontalAlignment = Alignment.CenterHorizontally,
      verticalArrangement = Arrangement.spacedBy(3.dp),
    ) {
      Text(
        text = sessionTitle,
        style = ClawTheme.type.title.copy(fontSize = 18.sp, lineHeight = 23.sp),
        color = ClawTheme.colors.text,
        maxLines = 1,
        overflow = TextOverflow.Ellipsis,
        textAlign = TextAlign.Center,
      )
      V2ModelPill(
        text =
          when {
            pendingRunCount > 0 -> "Working"
            healthOk -> "auto"
            else -> "offline"
          },
        status =
          when {
            pendingRunCount > 0 -> ClawStatus.Warning
            healthOk -> ClawStatus.Neutral
            else -> ClawStatus.Danger
          },
      )
    }

    V2HeaderIcon(icon = Icons.Default.StarBorder, contentDescription = "Pin chat", onClick = onPin)
    V2HeaderIcon(icon = Icons.Default.MoreVert, contentDescription = "Chat options", onClick = onMore)
  }
}

@Composable
private fun V2ModelPill(
  text: String,
  status: ClawStatus,
) {
  val borderColor =
    if (status == ClawStatus.Warning) {
      ClawTheme.colors.warning
    } else {
      ClawTheme.colors.border
    }
  Surface(
    shape = RoundedCornerShape(ClawTheme.radii.pill),
    color = ClawTheme.colors.surfaceRaised,
    contentColor = ClawTheme.colors.textMuted,
    border = BorderStroke(1.dp, borderColor),
  ) {
    Text(
      text = text,
      modifier = Modifier.padding(horizontal = 7.dp, vertical = 1.5.dp),
      style = ClawTheme.type.caption.copy(fontSize = 12.5.sp, lineHeight = 16.sp),
      maxLines = 1,
    )
  }
}

@Composable
private fun V2HeaderIcon(
  icon: androidx.compose.ui.graphics.vector.ImageVector,
  contentDescription: String,
  onClick: () -> Unit,
) {
  Surface(
    onClick = onClick,
    modifier = Modifier.size(23.dp),
    shape = CircleShape,
    color = Color.Transparent,
    contentColor = ClawTheme.colors.text,
  ) {
    Box(contentAlignment = Alignment.Center) {
      Icon(imageVector = icon, contentDescription = contentDescription, modifier = Modifier.size(15.dp))
    }
  }
}

@Composable
private fun V2ChatMessageList(
  messages: List<ChatMessage>,
  pendingRunCount: Int,
  pendingToolCalls: List<ChatPendingToolCall>,
  streamingAssistantText: String?,
  healthOk: Boolean,
  modifier: Modifier = Modifier,
) {
  val listState = rememberLazyListState()
  val displayMessages = remember(messages) { messages.asReversed() }
  val stream = streamingAssistantText?.trim()

  LaunchedEffect(messages.size, pendingRunCount, pendingToolCalls.size) {
    listState.animateScrollToItem(index = 0)
  }
  LaunchedEffect(stream) {
    if (!stream.isNullOrEmpty()) {
      listState.scrollToItem(index = 0)
    }
  }

  Box(modifier = modifier.fillMaxWidth()) {
    LazyColumn(
      modifier = Modifier.fillMaxSize(),
      state = listState,
      reverseLayout = true,
      verticalArrangement = Arrangement.spacedBy(5.dp),
      contentPadding = PaddingValues(top = 6.dp, bottom = 3.dp),
    ) {
      if (!stream.isNullOrEmpty()) {
        item(key = "stream") {
          V2ChatBubble(role = "assistant", live = true, content = listOf(ChatMessageContent(text = stream)), timestampMs = null)
        }
      }

      if (pendingToolCalls.isNotEmpty()) {
        item(key = "tools") {
          V2ToolBubble(toolCalls = pendingToolCalls)
        }
      }

      if (pendingRunCount > 0) {
        item(key = "thinking") {
          V2ChatThinkingBubble()
        }
      }

      items(items = displayMessages, key = { it.id }) { message ->
        V2ChatBubble(role = message.role, live = false, content = message.content, timestampMs = message.timestampMs)
      }
    }

    if (messages.isEmpty() && pendingRunCount == 0 && pendingToolCalls.isEmpty() && stream.isNullOrBlank()) {
      V2EmptyChatHint(healthOk = healthOk, modifier = Modifier.align(Alignment.Center))
    }
  }
}

@Composable
private fun V2EmptyChatHint(
  healthOk: Boolean,
  modifier: Modifier = Modifier,
) {
  Column(modifier = modifier.padding(horizontal = 32.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(7.dp)) {
    Text(text = "No messages yet", style = ClawTheme.type.title.copy(fontSize = 14.sp, lineHeight = 18.sp), color = ClawTheme.colors.text)
    Text(
      text =
        if (healthOk) {
          "Ask OpenClaw anything."
        } else {
          "Reconnect your Gateway from Settings."
        },
      style = ClawTheme.type.body,
      color = ClawTheme.colors.textMuted,
      textAlign = TextAlign.Center,
    )
  }
}

@Composable
private fun V2ChatBubble(
  role: String,
  live: Boolean,
  content: List<ChatMessageContent>,
  timestampMs: Long?,
) {
  val normalizedRole = role.trim().lowercase(Locale.US)
  val isUser = normalizedRole == "user"
  val displayableContent =
    content.filter { part ->
      when (part.type) {
        "text" -> !part.text.isNullOrBlank()
        else -> part.base64 != null
      }
    }
  if (displayableContent.isEmpty()) return

  Row(
    modifier = Modifier.fillMaxWidth(),
    horizontalArrangement = if (isUser) Arrangement.End else Arrangement.Start,
  ) {
    Surface(
      modifier = Modifier.fillMaxWidth(if (isUser) 0.64f else 0.56f),
      shape = RoundedCornerShape(7.dp),
      color = ClawTheme.colors.surfaceRaised,
      contentColor = ClawTheme.colors.text,
      border = BorderStroke(1.dp, if (live) ClawTheme.colors.borderStrong else ClawTheme.colors.border),
    ) {
      Column(modifier = Modifier.padding(horizontal = 7.dp, vertical = 3.5.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) {
        Text(
          text =
            when {
              live -> "OpenClaw · Live"
              isUser -> "You"
              normalizedRole == "system" -> "System"
              else -> "OpenClaw"
            },
          style = ClawTheme.type.caption.copy(fontSize = 12.5.sp, lineHeight = 16.sp, fontWeight = FontWeight.SemiBold),
          color = ClawTheme.colors.text,
        )
        displayableContent.forEach { part ->
          if (part.type == "text") {
            V2ChatText(text = part.text.orEmpty(), textColor = ClawTheme.colors.text)
          } else {
            Text(text = part.fileName ?: "Attachment", style = ClawTheme.type.body, color = ClawTheme.colors.textMuted)
          }
        }
        timestampMs?.let {
          Text(
            text = formatChatTimestamp(it),
            style = ClawTheme.type.caption.copy(fontSize = 12.5.sp, lineHeight = 16.sp),
            color = ClawTheme.colors.textMuted,
            modifier = Modifier.align(Alignment.End),
          )
        }
      }
    }
  }
}

@Composable
private fun V2ChatText(
  text: String,
  textColor: Color,
) {
  if (text.hasMarkdownSyntax()) {
    ChatMarkdown(text = text, textColor = textColor)
  } else {
    Text(
      text = text,
      style = ClawTheme.type.body,
      color = textColor,
    )
  }
}

@Composable
private fun V2ToolBubble(toolCalls: List<ChatPendingToolCall>) {
  ClawPanel {
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
      ClawStatusPill(text = "Tools running", status = ClawStatus.Warning)
      toolCalls.take(4).forEach { tool ->
        ClawListItem(title = tool.name, subtitle = "OpenClaw is working")
      }
      if (toolCalls.size > 4) {
        Text(text = "+${toolCalls.size - 4} more", style = ClawTheme.type.caption, color = ClawTheme.colors.textSubtle)
      }
    }
  }
}

@Composable
private fun V2ChatThinkingBubble() {
  ClawPanel {
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
      ClawStatusPill(text = "Thinking", status = ClawStatus.Warning)
      Text(text = "OpenClaw is preparing a response.", style = ClawTheme.type.body, color = ClawTheme.colors.textMuted)
    }
  }
}

@Composable
private fun V2ChatNotice(
  title: String,
  body: String,
) {
  Surface(
    modifier = Modifier.fillMaxWidth(),
    shape = RoundedCornerShape(ClawTheme.radii.panel),
    color = ClawTheme.colors.surface,
    contentColor = ClawTheme.colors.text,
    border = BorderStroke(1.dp, ClawTheme.colors.border),
  ) {
    Row(
      modifier = Modifier.padding(horizontal = 11.dp, vertical = 8.dp),
      verticalAlignment = Alignment.CenterVertically,
      horizontalArrangement = Arrangement.spacedBy(9.dp),
    ) {
      Box(modifier = Modifier.size(6.dp).background(ClawTheme.colors.warning, CircleShape))
      Column(modifier = Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
        Text(text = title, style = ClawTheme.type.section, color = ClawTheme.colors.text)
        Text(text = body, style = ClawTheme.type.caption, color = ClawTheme.colors.textMuted, maxLines = 1, overflow = TextOverflow.Ellipsis)
      }
    }
  }
}

@Composable
private fun V2ChatComposer(
  value: String,
  onValueChange: (String) -> Unit,
  thinkingLevel: String,
  healthOk: Boolean,
  pendingRunCount: Int,
  onThinkingLevelChange: (String) -> Unit,
  onVoice: () -> Unit,
  onAbort: () -> Unit,
  onSend: () -> Unit,
) {
  Column(modifier = Modifier.fillMaxWidth().imePadding(), verticalArrangement = Arrangement.spacedBy(4.dp)) {
    V2ChatContextMeter(thinkingLevel = thinkingLevel, onClick = { onThinkingLevelChange(nextThinkingValue(thinkingLevel)) })

    Row(modifier = Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
      V2ChatInputPill(value = value, onValueChange = onValueChange, onVoice = onVoice, modifier = Modifier.weight(1f))
      V2SendButton(
        enabled = healthOk && pendingRunCount == 0 && value.trim().isNotEmpty(),
        onClick = onSend,
      )
    }

    if (pendingRunCount > 0) {
      Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.Center) {
        Surface(
          onClick = onAbort,
          shape = RoundedCornerShape(ClawTheme.radii.pill),
          color = ClawTheme.colors.canvas,
          contentColor = ClawTheme.colors.text,
        ) {
          Row(
            modifier = Modifier.padding(horizontal = 10.dp, vertical = 5.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp),
          ) {
            Box(modifier = Modifier.size(8.dp).background(ClawTheme.colors.danger, RoundedCornerShape(2.dp)))
            Text(text = "Stop", style = ClawTheme.type.label)
          }
        }
      }
    }
  }
}

@Composable
private fun V2ChatContextMeter(
  thinkingLevel: String,
  onClick: () -> Unit,
) {
  Row(
    modifier = Modifier.width(178.dp),
    verticalAlignment = Alignment.CenterVertically,
    horizontalArrangement = Arrangement.spacedBy(7.dp),
  ) {
    Surface(
      onClick = onClick,
      shape = RoundedCornerShape(ClawTheme.radii.pill),
      color = ClawTheme.colors.canvas,
      contentColor = ClawTheme.colors.text,
    ) {
      Row(
        modifier = Modifier.padding(horizontal = 1.dp, vertical = 2.5.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(6.dp),
      ) {
        Icon(imageVector = Icons.Default.Refresh, contentDescription = null, modifier = Modifier.size(12.dp), tint = ClawTheme.colors.textSubtle)
        Text(text = "Context ${contextPercent(thinkingLevel)}%", style = ClawTheme.type.caption.copy(fontSize = 12.5.sp, lineHeight = 16.sp), color = ClawTheme.colors.textMuted)
      }
    }
    Box(
      modifier =
        Modifier
          .weight(1f)
          .height(3.dp)
          .background(ClawTheme.colors.surfacePressed, RoundedCornerShape(999.dp)),
    ) {
      Box(
        modifier =
          Modifier
            .fillMaxWidth(thinkingMeterWidth(thinkingLevel))
            .height(3.dp)
            .background(ClawTheme.colors.primary, RoundedCornerShape(999.dp)),
      )
    }
  }
}

@Composable
private fun V2ChatInputPill(
  value: String,
  onValueChange: (String) -> Unit,
  onVoice: () -> Unit,
  modifier: Modifier = Modifier,
) {
  Surface(
    modifier = modifier.heightIn(min = 30.dp),
    shape = RoundedCornerShape(12.dp),
    color = ClawTheme.colors.surfaceRaised,
    contentColor = ClawTheme.colors.text,
    border = BorderStroke(1.dp, ClawTheme.colors.border),
  ) {
    Row(
      modifier = Modifier.padding(horizontal = 8.dp, vertical = 3.dp),
      verticalAlignment = Alignment.CenterVertically,
      horizontalArrangement = Arrangement.spacedBy(7.dp),
    ) {
      Icon(imageVector = Icons.Default.AttachFile, contentDescription = "Attach file", modifier = Modifier.size(13.dp), tint = ClawTheme.colors.text)
      Box(modifier = Modifier.weight(1f)) {
        BasicTextField(
          value = value,
          onValueChange = onValueChange,
          textStyle = ClawTheme.type.body.copy(color = ClawTheme.colors.text),
          cursorBrush = SolidColor(ClawTheme.colors.primary),
          minLines = 1,
          maxLines = 4,
          modifier = Modifier.fillMaxWidth(),
          decorationBox = { innerTextField ->
            Box(modifier = Modifier.fillMaxWidth(), contentAlignment = Alignment.CenterStart) {
              if (value.isEmpty()) {
                Text(text = "Message OpenClaw", style = ClawTheme.type.body, color = ClawTheme.colors.textSubtle)
              }
              innerTextField()
            }
          },
        )
      }
      Surface(
        onClick = onVoice,
        modifier = Modifier.size(20.dp),
        shape = CircleShape,
        color = ClawTheme.colors.surfaceRaised,
        contentColor = ClawTheme.colors.text,
      ) {
        Box(contentAlignment = Alignment.Center) {
          Icon(imageVector = Icons.Default.Mic, contentDescription = "Voice", modifier = Modifier.size(12.dp))
        }
      }
    }
  }
}

private fun currentSessionTitle(
  sessionKey: String,
  sessions: List<ai.openclaw.app.chat.ChatSessionEntry>,
): String {
  val entry = sessions.firstOrNull { it.key == sessionKey }
  val name = entry?.displayName?.takeIf { it.isNotBlank() } ?: return "New chat"
  return friendlySessionName(name)
}

@Composable
private fun V2SendButton(
  enabled: Boolean,
  onClick: () -> Unit,
) {
  Surface(
    onClick = onClick,
    enabled = enabled,
    modifier = Modifier.size(31.dp),
    shape = CircleShape,
    color = if (enabled) ClawTheme.colors.primary else ClawTheme.colors.surfacePressed,
    contentColor = if (enabled) ClawTheme.colors.primaryText else ClawTheme.colors.textSubtle,
    border = BorderStroke(1.dp, if (enabled) ClawTheme.colors.primary else ClawTheme.colors.border),
  ) {
    Box(contentAlignment = Alignment.Center) {
      Icon(imageVector = Icons.AutoMirrored.Filled.Send, contentDescription = "Send", modifier = Modifier.size(14.dp))
    }
  }
}

private fun userFacingChatError(error: String): String {
  val lower = error.lowercase(Locale.US)
  return when {
    lower.contains("not connected") -> "Gateway is offline. Open Settings to reconnect."
    lower.contains("unauthorized") || lower.contains("auth") -> "Gateway authentication needs attention."
    else -> error
  }
}

private fun thinkingDisplay(value: String): String =
  when (value.lowercase(Locale.US)) {
    "low" -> "Low"
    "medium" -> "Medium"
    "high" -> "High"
    else -> "Off"
  }

private fun thinkingValue(display: String): String =
  when (display.lowercase(Locale.US)) {
    "low" -> "low"
    "medium" -> "medium"
    "high" -> "high"
    else -> "off"
  }

private fun nextThinkingValue(value: String): String =
  when (value.lowercase(Locale.US)) {
    "off" -> "low"
    "low" -> "medium"
    "medium" -> "high"
    else -> "off"
  }

private fun thinkingMeterWidth(value: String): Float =
  when (value.lowercase(Locale.US)) {
    "low" -> 0.34f
    "medium" -> 0.58f
    "high" -> 0.82f
    else -> 0.18f
  }

private fun contextPercent(value: String): Int = (thinkingMeterWidth(value) * 100).toInt()

private fun formatChatTimestamp(timestampMs: Long): String = DateFormat.getTimeInstance(DateFormat.SHORT, Locale.getDefault()).format(Date(timestampMs))

private fun String.hasMarkdownSyntax(): Boolean =
  any { it == '#' || it == '*' || it == '`' || it == '[' || it == '|' } ||
    contains("\n- ") ||
    contains("\n1. ")
