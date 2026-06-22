package ai.openclaw.app.ui.chat

import ai.openclaw.app.MainViewModel
import ai.openclaw.app.chat.ChatPendingToolCall
import ai.openclaw.app.chat.ChatSessionEntry
import ai.openclaw.app.chat.OutgoingAttachment
import ai.openclaw.app.ui.design.ClawStatus
import ai.openclaw.app.ui.design.ClawTheme
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material.icons.filled.AttachFile
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Mic
import androidx.compose.material.icons.filled.MoreHoriz
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material3.Icon
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlin.math.roundToInt
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

// ── Chat screen ────────────────────────────────────────────────────────────

@Composable
fun ChatScreen(
  viewModel: MainViewModel,
  onVoice: () -> Unit,
  onOpenSessions: () -> Unit,
) {
  val messages by viewModel.chatMessages.collectAsState()
  val historyLoading by viewModel.chatHistoryLoading.collectAsState()
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
  val contextUsage = resolveChatContextUsage(sessionKey = sessionKey, mainSessionKey = mainSessionKey, sessions = sessions)
  val context = LocalContext.current
  val resolver = context.contentResolver
  val scope = rememberCoroutineScope()
  val attachments = remember { mutableStateListOf<PendingImageAttachment>() }
  val pickImages =
    rememberLauncherForActivityResult(ActivityResultContracts.GetMultipleContents()) { uris ->
      if (uris.isNullOrEmpty()) return@rememberLauncherForActivityResult
      scope.launch(Dispatchers.IO) {
        val next =
          uris.take(8).mapNotNull { uri ->
            try {
              loadSizedImageAttachment(resolver, uri)
            } catch (_: Throwable) {
              null
            }
          }
        withContext(Dispatchers.Main) {
          attachments.addAll(next)
        }
      }
    }

  LaunchedEffect(Unit) {
    val loadSessionKey = resolveInitialChatLoadSessionKey(sessionKey, mainSessionKey)
    if (loadSessionKey != null) {
      viewModel.loadChat(loadSessionKey)
    }
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
        .padding(horizontal = 4.dp),
    verticalArrangement = Arrangement.spacedBy(0.dp),
  ) {
    ChatHeader(
      sessionTitle = currentSessionTitle(sessionKey = sessionKey, sessions = sessions),
      thinkingLevel = thinkingLevel,
      healthOk = healthOk,
      pendingRunCount = pendingRunCount,
      onMore = {
        viewModel.refreshChat()
        viewModel.refreshChatSessions(limit = 100)
      },
    )

    ChatSessionSwitcher(
      sessionKey = sessionKey,
      sessions = sessions,
      mainSessionKey = mainSessionKey,
      onSelectSession = { key ->
        viewModel.switchChatSession(key)
        viewModel.refreshChatSessions(limit = 100)
      },
      onOpenSessions = onOpenSessions,
    )

    // Errors surface in header status pill — no chat interruption.

    ChatMessageListCard(
      messages = messages,
      historyLoading = historyLoading,
      pendingRunCount = pendingRunCount,
      pendingToolCalls = pendingToolCalls,
      streamingAssistantText = streamingAssistantText,
      healthOk = healthOk,
      modifier = Modifier.weight(1f),
    )

    ChatComposer(
      value = input,
      onValueChange = { input = it },
      attachments = attachments,
      thinkingLevel = thinkingLevel,
      contextUsage = contextUsage,
      healthOk = healthOk,
      pendingRunCount = pendingRunCount,
      onThinkingLevelChange = viewModel::setChatThinkingLevel,
      onPickImages = { pickImages.launch("image/*") },
      onRemoveAttachment = { id -> attachments.removeAll { it.id == id } },
      onVoice = onVoice,
      onAbort = viewModel::abortChat,
      onSend = {
        val message = input.trim()
        if (message.isEmpty() && attachments.isEmpty()) return@ChatComposer
        val outgoing =
          attachments.map { attachment ->
            OutgoingAttachment(
              type = "image",
              mimeType = attachment.mimeType,
              fileName = attachment.fileName,
              base64 = attachment.base64,
            )
          }
        input = ""
        attachments.clear()
        scope.launch {
          viewModel.sendChat(message = message, thinking = thinkingLevel, attachments = outgoing)
        }
      },
    )
  }
}

// ── Session switcher ───────────────────────────────────────────────────────

@Composable
private fun ChatSessionSwitcher(
  sessionKey: String,
  sessions: List<ChatSessionEntry>,
  mainSessionKey: String,
  onSelectSession: (String) -> Unit,
  onOpenSessions: () -> Unit,
) {
  val choices =
    remember(sessionKey, sessions, mainSessionKey) {
      resolveCompactSessionChoices(
        currentSessionKey = sessionKey,
        sessions = sessions,
        mainSessionKey = mainSessionKey,
      )
    }
  if (choices.size <= 1 && sessions.size <= 1) return

  Row(
    modifier = Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(horizontal = 14.dp, vertical = 4.dp),
    verticalAlignment = Alignment.CenterVertically,
    horizontalArrangement = Arrangement.spacedBy(6.dp),
  ) {
    choices.forEach { entry ->
      ChatSessionChip(
        text = chatSessionChipText(entry = entry, mainSessionKey = mainSessionKey),
        active = isActiveSessionChoice(entry.key, sessionKey, mainSessionKey),
        onClick = { onSelectSession(entry.key) },
      )
      if (sessions.size > choices.size) {
        Surface(
          onClick = onOpenSessions,
          modifier = Modifier.heightIn(min = 36.dp),
          shape = RoundedCornerShape(ClawTheme.radii.pill),
          color = Color.Transparent,
          contentColor = ClawTheme.colors.textMuted,
          border = BorderStroke(1.dp, ClawTheme.colors.border),
        ) {
          Row(
            modifier = Modifier.padding(horizontal = 10.dp, vertical = 7.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(5.dp),
          ) {
            Icon(imageVector = Icons.Default.MoreHoriz, contentDescription = null, modifier = Modifier.size(16.dp))
            Text(text = "All", style = ClawTheme.type.caption, maxLines = 1)
          }
        }
      }
    }
  }
}

@Composable
private fun ChatSessionChip(
  text: String,
  active: Boolean,
  onClick: () -> Unit,
) {
  Surface(
    onClick = onClick,
    modifier = Modifier.heightIn(min = 36.dp),
    shape = RoundedCornerShape(ClawTheme.radii.pill),
    color = if (active) ClawTheme.colors.primary else Color.Transparent,
    contentColor = if (active) ClawTheme.colors.primaryText else ClawTheme.colors.textMuted,
    border = BorderStroke(1.dp, if (active) ClawTheme.colors.primary else ClawTheme.colors.border),
  ) {
    Text(
      text = text,
      modifier = Modifier.padding(horizontal = 11.dp, vertical = 7.dp),
      style = ClawTheme.type.caption,
      maxLines = 1,
      overflow = TextOverflow.Ellipsis,
    )
  }
}

// ── Header ─────────────────────────────────────────────────────────────────

@Composable
private fun ChatHeader(
  sessionTitle: String,
  thinkingLevel: String,
  healthOk: Boolean,
  pendingRunCount: Int,
  onMore: () -> Unit,
) {
  Row(
    modifier = Modifier.fillMaxWidth().padding(horizontal = 14.dp, vertical = 8.dp),
    verticalAlignment = Alignment.CenterVertically,
    horizontalArrangement = Arrangement.spacedBy(6.dp),
  ) {
    Spacer(modifier = Modifier.size(40.dp)) // balance

    Column(
      modifier = Modifier.weight(1f),
      horizontalAlignment = Alignment.CenterHorizontally,
      verticalArrangement = Arrangement.spacedBy(2.dp),
    ) {
      Text(
        text = sessionTitle,
        style = ClawTheme.type.title.copy(fontSize = 17.sp, lineHeight = 22.sp),
        color = ClawTheme.colors.text,
        maxLines = 1,
        overflow = TextOverflow.Ellipsis,
        textAlign = TextAlign.Center,
      )
      ModelPill(
        text =
          when {
            pendingRunCount > 0 -> "Working…"
            healthOk -> "Ready"
            else -> "Offline"
          },
        status =
          when {
            pendingRunCount > 0 -> ClawStatus.Warning
            healthOk -> ClawStatus.Neutral
            else -> ClawStatus.Danger
          },
      )
    }

    Surface(
      onClick = onMore,
      modifier = Modifier.size(40.dp),
      shape = CircleShape,
      color = Color.Transparent,
      contentColor = ClawTheme.colors.text,
    ) {
      Box(contentAlignment = Alignment.Center) {
        Icon(imageVector = Icons.Default.Refresh, contentDescription = "Refresh chat", modifier = Modifier.size(20.dp))
      }
    }
  }
}

@Composable
private fun ModelPill(
  text: String,
  status: ClawStatus,
) {
  val borderColor =
    when (status) {
      ClawStatus.Warning -> ClawTheme.colors.warning
      ClawStatus.Danger -> ClawTheme.colors.danger
      else -> ClawTheme.colors.border
    }
  Surface(
    shape = RoundedCornerShape(ClawTheme.radii.pill),
    color = Color.Transparent,
    contentColor = ClawTheme.colors.textMuted,
    border = BorderStroke(1.dp, borderColor),
  ) {
    Text(
      text = text,
      modifier = Modifier.padding(horizontal = 7.dp, vertical = 1.5.dp),
      style = ClawTheme.type.caption.copy(fontSize = 12.sp, lineHeight = 15.sp),
      maxLines = 1,
    )
  }
}

// ── Composer ───────────────────────────────────────────────────────────────

@Composable
private fun ChatComposer(
  value: String,
  onValueChange: (String) -> Unit,
  attachments: List<PendingImageAttachment>,
  thinkingLevel: String,
  contextUsage: ChatContextUsage,
  healthOk: Boolean,
  pendingRunCount: Int,
  onThinkingLevelChange: (String) -> Unit,
  onPickImages: () -> Unit,
  onRemoveAttachment: (String) -> Unit,
  onVoice: () -> Unit,
  onAbort: () -> Unit,
  onSend: () -> Unit,
) {
  Column(
    modifier =
      Modifier
        .fillMaxWidth()
        .imePadding()
        .padding(horizontal = 14.dp, vertical = 8.dp),
    verticalArrangement = Arrangement.spacedBy(8.dp),
  ) {
    if (attachments.isNotEmpty()) {
      AttachmentStrip(attachments = attachments, onRemoveAttachment = onRemoveAttachment)
    }

    // Input row
    Surface(
      shape = RoundedCornerShape(24.dp),
      color = ClawTheme.colors.surfaceRaised,
      border = BorderStroke(1.dp, ClawTheme.colors.border),
    ) {
      Row(
        modifier = Modifier.padding(horizontal = 4.dp, vertical = 4.dp),
        verticalAlignment = Alignment.Bottom,
        horizontalArrangement = Arrangement.spacedBy(2.dp),
      ) {
        // Attach button
        Surface(
          onClick = onPickImages,
          modifier = Modifier.size(40.dp),
          shape = CircleShape,
          color = Color.Transparent,
        ) {
          Box(contentAlignment = Alignment.Center) {
            Icon(
              imageVector = Icons.Default.AttachFile,
              contentDescription = "Attach image",
              modifier = Modifier.size(18.dp),
              tint = ClawTheme.colors.textMuted,
            )
          }
        }

        // Text field
        Box(modifier = Modifier.weight(1f).padding(vertical = 6.dp)) {
          BasicTextField(
            value = value,
            onValueChange = onValueChange,
            textStyle = ClawTheme.type.body.copy(fontSize = 15.sp, lineHeight = 22.sp, color = ClawTheme.colors.text),
            cursorBrush = SolidColor(ClawTheme.colors.primary),
            minLines = 1,
            maxLines = 6,
            modifier = Modifier.fillMaxWidth(),
            decorationBox = { innerTextField ->
              Box(contentAlignment = Alignment.CenterStart) {
                if (value.isEmpty()) {
                  Text(
                    text = "Message OpenClaw",
                    style = ClawTheme.type.body.copy(fontSize = 15.sp),
                    color = ClawTheme.colors.textSubtle,
                  )
                }
                innerTextField()
              }
            },
          )
        }

        // Voice or send button
        if (value.trim().isEmpty() && attachments.isEmpty()) {
          Surface(
            onClick = onVoice,
            modifier = Modifier.size(40.dp),
            shape = CircleShape,
            color = ClawTheme.colors.text,
            contentColor = ClawTheme.colors.canvas,
          ) {
            Box(contentAlignment = Alignment.Center) {
              Icon(imageVector = Icons.Default.Mic, contentDescription = "Voice", modifier = Modifier.size(18.dp))
            }
          }
        } else {
          val canSend = healthOk && pendingRunCount == 0
          Surface(
            onClick = onSend,
            enabled = canSend,
            modifier = Modifier.size(40.dp),
            shape = CircleShape,
            color = if (canSend) ClawTheme.colors.text else ClawTheme.colors.surfacePressed,
            contentColor = if (canSend) ClawTheme.colors.canvas else ClawTheme.colors.textSubtle,
          ) {
            Box(contentAlignment = Alignment.Center) {
              Icon(
                imageVector = Icons.AutoMirrored.Filled.Send,
                contentDescription = "Send",
                modifier = Modifier.size(18.dp),
              )
            }
          }
        }
      }
    }

    // Context meter + thinking level (single row)
    Row(
      modifier = Modifier.fillMaxWidth(),
      verticalAlignment = Alignment.CenterVertically,
      horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
      // Thinking level chip
      val thinkingLabel = thinkingDisplay(thinkingLevel)
      Surface(
        onClick = { onThinkingLevelChange(nextThinkingValue(thinkingLevel)) },
        shape = RoundedCornerShape(999.dp),
        color = Color.Transparent,
        border = BorderStroke(1.dp, ClawTheme.colors.border),
      ) {
        Text(
          text = thinkingLabel,
          modifier = Modifier.padding(horizontal = 8.dp, vertical = 3.dp),
          style = ClawTheme.type.caption.copy(fontSize = 11.sp, lineHeight = 14.sp),
          color = ClawTheme.colors.textMuted,
        )
      }

      // Context bar
      val fraction = contextMeterWidth(contextUsage) ?: 0f
      if (fraction > 0f) {
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
                .fillMaxWidth(fraction)
                .height(3.dp)
                .background(ClawTheme.colors.primary, RoundedCornerShape(999.dp)),
          )
        }
      } else {
        Spacer(modifier = Modifier.weight(1f))
      }
    }

    // Stop button
    if (pendingRunCount > 0) {
      Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.Center) {
        Surface(
          onClick = onAbort,
          shape = RoundedCornerShape(999.dp),
          color = ClawTheme.colors.dangerSoft,
          border = BorderStroke(1.dp, ClawTheme.colors.danger.copy(alpha = 0.3f)),
        ) {
          Row(
            modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(6.dp),
          ) {
            Box(
              modifier =
                Modifier
                  .size(7.dp)
                  .background(ClawTheme.colors.danger, RoundedCornerShape(2.dp)),
            )
            Text(text = "Stop", style = ClawTheme.type.label.copy(fontSize = 13.sp))
          }
        }
      }
    }
  }
}

@Composable
private fun AttachmentStrip(
  attachments: List<PendingImageAttachment>,
  onRemoveAttachment: (String) -> Unit,
) {
  Row(
    modifier = Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()),
    horizontalArrangement = Arrangement.spacedBy(6.dp),
  ) {
    attachments.forEach { attachment ->
      AttachmentChip(fileName = attachment.fileName, onRemove = { onRemoveAttachment(attachment.id) })
    }
  }
}

@Composable
private fun AttachmentChip(
  fileName: String,
  onRemove: () -> Unit,
) {
  Surface(
    shape = RoundedCornerShape(999.dp),
    color = ClawTheme.colors.surfaceRaised,
    border = BorderStroke(1.dp, ClawTheme.colors.border),
  ) {
    Row(
      modifier = Modifier.padding(start = 10.dp, top = 5.dp, end = 4.dp, bottom = 5.dp),
      verticalAlignment = Alignment.CenterVertically,
      horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
      Text(text = fileName, style = ClawTheme.type.caption, color = ClawTheme.colors.textMuted, maxLines = 1, overflow = TextOverflow.Ellipsis)
      Surface(onClick = onRemove, modifier = Modifier.size(20.dp), shape = CircleShape, color = ClawTheme.colors.canvas) {
        Box(contentAlignment = Alignment.Center) {
          Icon(imageVector = Icons.Default.Close, contentDescription = "Remove", modifier = Modifier.size(12.dp))
        }
      }
    }
  }
}

// ── Utility ────────────────────────────────────────────────────────────────

private fun currentSessionTitle(
  sessionKey: String,
  sessions: List<ChatSessionEntry>,
): String {
  val entry = sessions.firstOrNull { it.key == sessionKey }
  val name = entry?.displayName?.takeIf { it.isNotBlank() } ?: return "New chat"
  return friendlySessionName(name)
}

private fun chatSessionChipText(
  entry: ChatSessionEntry,
  mainSessionKey: String,
): String {
  val mainKey = mainSessionKey.trim().ifEmpty { "main" }
  if (entry.key == mainKey || (entry.key == "main" && mainKey == "main")) return "Main"
  val name = entry.displayName?.takeIf { it.isNotBlank() } ?: entry.key.takeIf { entry.updatedAtMs != null } ?: "Current"
  return friendlySessionName(name)
}

private fun isActiveSessionChoice(
  choiceKey: String,
  sessionKey: String,
  mainSessionKey: String,
): Boolean {
  val mainKey = mainSessionKey.trim().ifEmpty { "main" }
  val current = sessionKey.trim().let { if (it == "main" && mainKey != "main") mainKey else it }
  return choiceKey == current
}

internal data class ChatContextUsage(
  val totalTokens: Long?,
  val totalTokensFresh: Boolean?,
  val contextTokens: Long?,
)

internal fun resolveChatContextUsage(
  sessionKey: String,
  mainSessionKey: String,
  sessions: List<ChatSessionEntry>,
): ChatContextUsage {
  val entry =
    sessions.firstOrNull {
      isActiveSessionChoice(choiceKey = it.key, sessionKey = sessionKey, mainSessionKey = mainSessionKey)
    }
  return ChatContextUsage(
    totalTokens = entry?.totalTokens,
    totalTokensFresh = entry?.totalTokensFresh,
    contextTokens = entry?.contextTokens,
  )
}

private fun thinkingDisplay(value: String): String =
  when (value.lowercase(java.util.Locale.US)) {
    "low" -> "Low"
    "medium" -> "Medium"
    "high" -> "High"
    else -> "Off"
  }

private fun nextThinkingValue(value: String): String =
  when (value.lowercase(java.util.Locale.US)) {
    "off" -> "low"
    "low" -> "medium"
    "medium" -> "high"
    else -> "off"
  }

internal fun contextMeterWidth(usage: ChatContextUsage): Float? {
  if (usage.totalTokensFresh == false) return null
  val total = usage.totalTokens?.takeIf { it >= 0L } ?: return null
  val context = usage.contextTokens?.takeIf { it > 0L } ?: return null
  return (total.toDouble() / context.toDouble()).coerceIn(0.0, 1.0).toFloat()
}

internal fun contextMeterLabel(
  usage: ChatContextUsage,
  thinkingValue: String,
): String {
  val percent = contextMeterWidth(usage)
  val percentText = if (percent == null) "--" else "${(percent * 100).roundToInt()}%"
  return "Context $percentText · ${thinkingDisplay(thinkingValue)}"
}

internal fun contextMeterThinkingLabel(value: String): String =
  when (value.lowercase(java.util.Locale.US)) {
    "low" -> "low"
    "medium" -> "medium"
    "high" -> "high"
    else -> "off"
  }

/** Quick markdown detector. */
private fun String.hasMarkdownSyntax(): Boolean =
  any { it == '#' || it == '*' || it == '`' || it == '[' || it == '|' } ||
    contains("\n- ") ||
    contains("\n1. ")
