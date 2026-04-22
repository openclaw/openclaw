package ai.openclaw.app.ui.chat

import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.WindowInsetsSides
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.only
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ArrowDropDown
import androidx.compose.material3.AlertDialog
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
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import ai.openclaw.app.MainViewModel
import ai.openclaw.app.chat.ChatCompactionStatus
import ai.openclaw.app.chat.ChatFallbackStatus
import ai.openclaw.app.chat.OutgoingAttachment
import ai.openclaw.app.ui.mobileAccent
import ai.openclaw.app.ui.mobileAccentSoft
import ai.openclaw.app.ui.mobileBorder
import ai.openclaw.app.ui.mobileBorderStrong
import ai.openclaw.app.ui.mobileCallout
import ai.openclaw.app.ui.mobileCaption1
import ai.openclaw.app.ui.mobileCardSurface
import ai.openclaw.app.ui.mobileDanger
import ai.openclaw.app.ui.mobileDangerSoft
import ai.openclaw.app.ui.mobileSuccess
import ai.openclaw.app.ui.mobileSuccessSoft
import ai.openclaw.app.ui.mobileText
import ai.openclaw.app.ui.mobileTextSecondary
import ai.openclaw.app.ui.mobileTextTertiary
import ai.openclaw.app.ui.mobileWarning
import ai.openclaw.app.ui.mobileWarningSoft

@Composable
fun ChatSheetContent(
  viewModel: MainViewModel,
  modifier: Modifier = Modifier,
  hideCronSessions: Boolean = true,
  onHideCronSessionsChange: (Boolean) -> Unit = {},
) {
  val context = LocalContext.current
  val timeline by viewModel.chatTimeline.collectAsState()
  val errorText by viewModel.chatError.collectAsState()
  val healthOk by viewModel.chatHealthOk.collectAsState()
  val thinkingLevel by viewModel.chatThinkingLevel.collectAsState()
  val streamingAssistantText by viewModel.chatStreamingAssistantText.collectAsState()
  val pendingRunCount by viewModel.pendingRunCount.collectAsState()
  val sessionActionInFlight by viewModel.chatSessionActionInFlight.collectAsState()
  val pendingToolCalls by viewModel.chatPendingToolCalls.collectAsState()
  val sessions by viewModel.chatSessions.collectAsState()
  val compactionStatus by viewModel.chatCompactionStatus.collectAsState()
  val fallbackStatus by viewModel.chatFallbackStatus.collectAsState()
  val draftText by viewModel.chatDraft.collectAsState()
  val pendingAssistantAutoSend by viewModel.pendingAssistantAutoSend.collectAsState()
  val currentSessionKey by viewModel.chatSessionKey.collectAsState()
  val mainSessionKey by viewModel.mainSessionKey.collectAsState()
  val sessionDefaults by viewModel.chatSessionDefaults.collectAsState()
  val modelCatalog by viewModel.chatModelCatalog.collectAsState()

  var messageUiState by remember(currentSessionKey) { mutableStateOf(ChatMessageUiState()) }
  val attachments = remember(currentSessionKey) { mutableStateListOf<PendingImageAttachment>() }
  var attachmentError by remember(currentSessionKey) { mutableStateOf<String?>(null) }

  val activeSession = remember(sessions, currentSessionKey, mainSessionKey) {
    sessions.firstOrNull { it.key == currentSessionKey }
      ?: if (currentSessionKey == "main" && mainSessionKey != "main") {
        sessions.firstOrNull { it.key == mainSessionKey }
      } else {
        null
      }
  }
  val sessionChoices = remember(currentSessionKey, sessions, mainSessionKey, hideCronSessions) {
    resolveVisibleSessionChoicesForCurrentAgent(
      currentSessionKey = currentSessionKey,
      sessions = sessions,
      mainSessionKey = mainSessionKey,
      hideCronSessions = hideCronSessions,
    )
  }
  val hiddenCronCount = remember(currentSessionKey, sessions, mainSessionKey) {
    countHiddenCronSessionChoices(
      currentSessionKey = currentSessionKey,
      sessions = sessions,
      mainSessionKey = mainSessionKey,
    )
  }
  val statusNotices = remember(compactionStatus, fallbackStatus) {
    buildChatStatusNotices(
      compactionStatus = compactionStatus,
      fallbackStatus = fallbackStatus,
    )
  }
  val contextNotice = remember(activeSession) { computeContextUsageNotice(activeSession) }
  val canDeleteCurrentSession = remember(currentSessionKey, mainSessionKey) {
    ai.openclaw.app.chat.canDeleteSession(currentSessionKey, mainSessionKey)
  }
  val canMutateSessions = remember(pendingRunCount, sessionActionInFlight) {
    pendingRunCount == 0 && !sessionActionInFlight
  }
  var showDeleteSessionConfirm by remember(currentSessionKey) { mutableStateOf(false) }

  val picker =
    rememberLauncherForActivityResult(ActivityResultContracts.GetMultipleContents()) { uris ->
      if (uris.isEmpty()) return@rememberLauncherForActivityResult
      var failed = 0
      uris.forEach { uri ->
        runCatching {
          loadSizedImageAttachment(context.contentResolver, uri)
        }.onSuccess { attachment ->
          attachments += attachment
        }.onFailure {
          failed += 1
        }
      }
      attachmentError =
        when {
          failed == 0 -> null
          failed == uris.size -> "Couldn't load selected images."
          else -> "Some selected images couldn't be loaded."
        }
    }

  LaunchedEffect(Unit) {
    viewModel.refreshChat()
    viewModel.refreshChatSessions(limit = 50)
    viewModel.refreshChatModelCatalog()
  }

  LaunchedEffect(pendingAssistantAutoSend, healthOk, pendingRunCount, thinkingLevel) {
    val consumed =
      dispatchPendingAssistantAutoSend(
        pendingPrompt = pendingAssistantAutoSend,
        healthOk = healthOk,
        pendingRunCount = pendingRunCount,
      ) { prompt ->
        viewModel.sendChatAwaitAcceptance(
          message = prompt,
          thinking = thinkingLevel,
          attachments = attachments.map { it.toOutgoingAttachment() },
        )
      }
    if (consumed) {
      attachments.clear()
      attachmentError = null
      viewModel.clearPendingAssistantAutoSend()
    }
  }

  Column(
    modifier =
      modifier
        .fillMaxSize()
        .imePadding()
        .windowInsetsPadding(WindowInsets.safeDrawing.only(WindowInsetsSides.Bottom))
        .padding(12.dp),
    verticalArrangement = Arrangement.spacedBy(10.dp),
  ) {
    if (sessionChoices.isNotEmpty()) {
      SessionChooserCard(
        sessions = sessionChoices,
        currentSessionKey = currentSessionKey,
        enabled = canMutateSessions,
        onSelect = viewModel::switchChatSession,
        onRefresh = {
          viewModel.refreshChatSessions(limit = 50)
          viewModel.refreshChatModelCatalog()
        },
      )
    }

    contextNotice?.let { notice ->
      DiagnosticNoticeCard(
        title = "Context usage",
        detail = "${notice.usedTokens} / ${notice.limitTokens} tokens used (${notice.percentUsed}%)",
        tone = if (notice.severity == ContextUsageNotice.Severity.Danger) NoticeTone.Danger else NoticeTone.Warning,
      )
    }

    statusNotices.forEach { notice ->
      DiagnosticNoticeCard(
        title = notice.title,
        detail = notice.detail,
        tone =
          when (notice.tone) {
            ChatStatusNotice.Tone.Info -> NoticeTone.Info
            ChatStatusNotice.Tone.Warning -> NoticeTone.Warning
            ChatStatusNotice.Tone.Success -> NoticeTone.Success
          },
      )
    }

    errorText?.takeIf { it.isNotBlank() }?.let { text ->
      DiagnosticNoticeCard(
        title = "Chat error",
        detail = text,
        tone = NoticeTone.Danger,
      )
    }

    attachmentError?.takeIf { it.isNotBlank() }?.let { text ->
      DiagnosticNoticeCard(
        title = "Attachments",
        detail = text,
        tone = NoticeTone.Warning,
      )
    }

    ChatMessageListCard(
      timeline = timeline,
      pendingRunCount = pendingRunCount,
      pendingToolCalls = pendingToolCalls,
      streamingAssistantText = streamingAssistantText,
      healthOk = healthOk,
      uiState = messageUiState,
      onRequestHideMessage = { id -> messageUiState = hideMessage(messageUiState, id) },
      onRequestDeleteMessage = { id -> messageUiState = requestDeleteMessage(messageUiState, id) },
      onConfirmDeleteMessage = { id -> messageUiState = confirmDeleteMessage(messageUiState, id) },
      onCancelDeleteMessage = { id -> messageUiState = cancelDeleteMessage(messageUiState, id) },
      onToggleExpandedMessage = { id -> messageUiState = toggleExpandedMessage(messageUiState, id) },
      onOpenCanvas = viewModel::openChatCanvasPreview,
      modifier = Modifier.weight(1f, fill = true),
    )

    ChatComposer(
      draftText = draftText,
      healthOk = healthOk,
      thinkingLevel = activeSession?.thinkingLevel ?: thinkingLevel,
      pendingRunCount = pendingRunCount,
      attachments = attachments,
      activeSession = activeSession,
      sessionDefaults = sessionDefaults,
      modelCatalog = modelCatalog,
      onDraftApplied = viewModel::clearChatDraft,
      onPickImages = { picker.launch("image/*") },
      onRemoveAttachment = { id -> attachments.removeAll { it.id == id } },
      onSetThinkingLevel = viewModel::setChatThinkingLevel,
      onSetModel = viewModel::setChatModel,
      onRefresh = {
        attachmentError = null
        viewModel.refreshChat()
        viewModel.refreshChatSessions(limit = 50)
        viewModel.refreshChatModelCatalog()
      },
      onAbort = viewModel::abortChat,
      onSend = { text ->
        val outgoing = attachments.map { it.toOutgoingAttachment() }
        attachments.clear()
        attachmentError = null
        viewModel.sendChat(message = text, thinking = activeSession?.thinkingLevel ?: thinkingLevel, attachments = outgoing)
      },
      footerContent = {
        ChatDisplayControlsRow(
          uiState = messageUiState,
          hideCronSessions = hideCronSessions,
          hiddenCronCount = hiddenCronCount,
          canMutateSessions = canMutateSessions,
          canDeleteCurrentSession = canDeleteCurrentSession,
          onToggleReasoning = { messageUiState = toggleShowReasoning(messageUiState) },
          onToggleToolDetails = { messageUiState = toggleShowToolDetails(messageUiState) },
          onToggleCronSessions = { onHideCronSessionsChange(!hideCronSessions) },
          onRestoreHidden = { messageUiState = clearHiddenMessages(messageUiState) },
          onNewChat = viewModel::createChatSession,
          onDeleteChat = { showDeleteSessionConfirm = true },
        )
      },
    )
  }

  if (showDeleteSessionConfirm) {
    AlertDialog(
      onDismissRequest = { showDeleteSessionConfirm = false },
      title = { Text("Delete chat?") },
      text = {
        Text(
          if (canDeleteCurrentSession) {
            "Delete ${activeSession?.let(::compactSessionDisplayName) ?: friendlySessionName(currentSessionKey)}? This removes the session from the list and deletes its transcript on the gateway."
          } else {
            "Main chat can't be deleted."
          },
        )
      },
      confirmButton = {
        Surface(
          onClick = {
            showDeleteSessionConfirm = false
            if (canDeleteCurrentSession) {
              viewModel.deleteCurrentChatSession()
            }
          },
          shape = RoundedCornerShape(999.dp),
          color = if (canDeleteCurrentSession) mobileDangerSoft else mobileCardSurface,
          border = BorderStroke(1.dp, if (canDeleteCurrentSession) mobileDanger else mobileBorder),
        ) {
          Text(
            text = if (canDeleteCurrentSession) "Delete" else "OK",
            style = mobileCaption1.copy(fontWeight = FontWeight.SemiBold),
            color = if (canDeleteCurrentSession) mobileDanger else mobileText,
            modifier = Modifier.padding(horizontal = 16.dp, vertical = 10.dp),
          )
        }
      },
      dismissButton = {
        if (canDeleteCurrentSession) {
          Surface(
            onClick = { showDeleteSessionConfirm = false },
            shape = RoundedCornerShape(999.dp),
            color = mobileCardSurface,
            border = BorderStroke(1.dp, mobileBorder),
          ) {
            Text(
              text = "Cancel",
              style = mobileCaption1.copy(fontWeight = FontWeight.SemiBold),
              color = mobileTextSecondary,
              modifier = Modifier.padding(horizontal = 16.dp, vertical = 10.dp),
            )
          }
        }
      },
    )
  }
}

internal fun resolvePendingAssistantAutoSend(
  pendingPrompt: String?,
  healthOk: Boolean,
  pendingRunCount: Int,
): String? {
  val prompt = pendingPrompt?.trim()?.takeIf { it.isNotEmpty() } ?: return null
  if (!healthOk) return null
  if (pendingRunCount > 0) return null
  return prompt
}

internal suspend fun dispatchPendingAssistantAutoSend(
  pendingPrompt: String?,
  healthOk: Boolean,
  pendingRunCount: Int,
  dispatch: suspend (String) -> Boolean,
): Boolean {
  val prompt =
    resolvePendingAssistantAutoSend(
      pendingPrompt = pendingPrompt,
      healthOk = healthOk,
      pendingRunCount = pendingRunCount,
    ) ?: return false
  return dispatch(prompt)
}

private fun PendingImageAttachment.toOutgoingAttachment(): OutgoingAttachment =
  OutgoingAttachment(
    type = "input_image",
    mimeType = mimeType,
    fileName = fileName,
    base64 = base64,
  )

@Composable
private fun ChatDisplayControlsRow(
  uiState: ChatMessageUiState,
  hideCronSessions: Boolean,
  hiddenCronCount: Int,
  canMutateSessions: Boolean,
  canDeleteCurrentSession: Boolean,
  onToggleReasoning: () -> Unit,
  onToggleToolDetails: () -> Unit,
  onToggleCronSessions: () -> Unit,
  onRestoreHidden: () -> Unit,
  onNewChat: () -> Unit,
  onDeleteChat: () -> Unit,
) {
  Row(
    modifier = Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()),
    horizontalArrangement = Arrangement.spacedBy(8.dp),
  ) {
    ToggleChip(
      label = if (uiState.showReasoning) "Assistant thinking/working output on" else "Assistant thinking/working output off",
      active = uiState.showReasoning,
      onClick = onToggleReasoning,
    )
    ToggleChip(
      label = if (uiState.showToolDetails) "Tools result on" else "Tools result off",
      active = uiState.showToolDetails,
      onClick = onToggleToolDetails,
    )
    ToggleChip(
      label =
        if (hideCronSessions) {
          if (hiddenCronCount > 0) "Show cron session ($hiddenCronCount)" else "Show cron session"
        } else {
          "Hide cron session"
        },
      active = !hideCronSessions,
      onClick = onToggleCronSessions,
    )
    if (uiState.hiddenMessageIds.isNotEmpty()) {
      ToggleChip(
        label = "Restore hidden (${uiState.hiddenMessageIds.size})",
        active = false,
        accent = true,
        onClick = onRestoreHidden,
      )
    }
    ToggleChip(
      label = if (canMutateSessions) "New chat" else "New chat busy",
      active = false,
      accent = true,
      enabled = canMutateSessions,
      onClick = onNewChat,
    )
    ToggleChip(
      label = if (canDeleteCurrentSession) "Delete chat" else "Main chat protected",
      active = false,
      danger = true,
      enabled = canMutateSessions && canDeleteCurrentSession,
      onClick = onDeleteChat,
    )
  }
}

@Composable
private fun SessionChooserCard(
  sessions: List<ai.openclaw.app.chat.ChatSessionEntry>,
  currentSessionKey: String,
  enabled: Boolean,
  onSelect: (String) -> Unit,
  onRefresh: () -> Unit,
) {
  var expanded by remember { mutableStateOf(false) }
  val selected = remember(sessions, currentSessionKey) {
    sessions.firstOrNull { it.key == currentSessionKey } ?: ai.openclaw.app.chat.ChatSessionEntry(key = currentSessionKey, updatedAtMs = null)
  }

  androidx.compose.foundation.layout.Box(modifier = Modifier.fillMaxWidth()) {
    Surface(
      onClick = {
        if (!enabled) return@Surface
        onRefresh()
        expanded = true
      },
      modifier = Modifier.fillMaxWidth(),
      shape = RoundedCornerShape(16.dp),
      color = mobileAccentSoft,
      border = BorderStroke(1.dp, mobileAccent),
    ) {
      Row(
        modifier = Modifier
          .fillMaxWidth()
          .padding(horizontal = 14.dp, vertical = 12.dp),
        horizontalArrangement = Arrangement.SpaceBetween,
        verticalAlignment = Alignment.CenterVertically,
      ) {
        Text(
          text = compactSessionDisplayName(selected),
          style = mobileCallout.copy(fontWeight = FontWeight.SemiBold),
          color = mobileText,
          maxLines = 1,
          modifier = Modifier.weight(1f),
        )
        Icon(
          imageVector = Icons.Default.ArrowDropDown,
          contentDescription = "Open chat session selector",
          modifier = Modifier.padding(start = 8.dp),
          tint = mobileTextSecondary,
        )
      }
    }

    androidx.compose.material3.DropdownMenu(
      expanded = expanded && enabled,
      onDismissRequest = { expanded = false },
      shape = RoundedCornerShape(16.dp),
      containerColor = mobileCardSurface,
      tonalElevation = 0.dp,
      shadowElevation = 8.dp,
      border = BorderStroke(1.dp, mobileBorder),
    ) {
      for (entry in sessions) {
        val isCurrent = entry.key == selected.key
        androidx.compose.material3.DropdownMenuItem(
          text = {
            Text(
              text = compactSessionDisplayName(entry),
              style = mobileCallout,
              color = mobileText,
              maxLines = 1,
            )
          },
          trailingIcon = {
            if (isCurrent) {
              Text(text = "✓", style = mobileCallout, color = mobileAccent)
            }
          },
          onClick = {
            expanded = false
            if (!isCurrent) {
              onSelect(entry.key)
            }
          },
        )
      }
    }
  }
}

private enum class NoticeTone {
  Info,
  Warning,
  Success,
  Danger,
}

@Composable
private fun ToggleChip(
  label: String,
  active: Boolean,
  accent: Boolean = false,
  danger: Boolean = false,
  enabled: Boolean = true,
  onClick: () -> Unit,
) {
  val containerColor =
    when {
      !enabled -> mobileCardSurface
      danger -> mobileDangerSoft
      active -> mobileAccentSoft
      accent -> mobileCardSurface
      else -> mobileCardSurface
    }
  val borderColor =
    when {
      !enabled -> mobileBorder
      danger -> mobileDanger
      active -> mobileAccent
      accent -> mobileBorderStrong
      else -> mobileBorder
    }
  val textColor =
    when {
      !enabled -> mobileTextTertiary
      danger -> mobileDanger
      active -> mobileAccent
      else -> mobileTextSecondary
    }

  Surface(
    shape = RoundedCornerShape(999.dp),
    color = containerColor,
    border = BorderStroke(1.dp, borderColor),
    modifier = Modifier.clickable(enabled = enabled, onClick = onClick),
  ) {
    Text(
      text = label,
      style = mobileCaption1.copy(fontWeight = FontWeight.SemiBold),
      color = textColor,
      modifier = Modifier.padding(horizontal = 12.dp, vertical = 8.dp),
    )
  }
}

@Composable
private fun DiagnosticNoticeCard(
  title: String,
  detail: String,
  tone: NoticeTone,
) {
  val containerColor =
    when (tone) {
      NoticeTone.Info -> mobileCardSurface
      NoticeTone.Warning -> mobileWarningSoft
      NoticeTone.Success -> mobileSuccessSoft
      NoticeTone.Danger -> mobileDangerSoft
    }
  val borderColor =
    when (tone) {
      NoticeTone.Info -> mobileBorderStrong
      NoticeTone.Warning -> mobileWarning
      NoticeTone.Success -> mobileSuccess
      NoticeTone.Danger -> mobileDanger
    }
  val titleColor =
    when (tone) {
      NoticeTone.Info -> mobileText
      NoticeTone.Warning -> mobileWarning
      NoticeTone.Success -> mobileSuccess
      NoticeTone.Danger -> mobileDanger
    }

  Surface(
    shape = RoundedCornerShape(14.dp),
    color = containerColor,
    border = BorderStroke(1.dp, borderColor),
    modifier = Modifier.fillMaxWidth(),
  ) {
    Column(
      modifier = Modifier.padding(horizontal = 12.dp, vertical = 10.dp),
      verticalArrangement = Arrangement.spacedBy(4.dp),
    ) {
      Text(
        text = title,
        style = mobileCaption1.copy(fontWeight = FontWeight.SemiBold),
        color = titleColor,
      )
      Text(
        text = detail,
        style = mobileCallout,
        color = mobileTextSecondary,
      )
    }
  }
}
