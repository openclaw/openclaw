package ai.openclaw.android.ui.chat

import android.content.ClipData
import android.content.ClipboardManager
import android.content.ContentResolver
import android.content.Context
import android.net.Uri
import android.util.Base64
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.ime
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
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
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import ai.openclaw.android.MainViewModel
import ai.openclaw.android.chat.ChatConnectionState
import ai.openclaw.android.chat.ChatMessage
import ai.openclaw.android.chat.ChatSessionEntry
import ai.openclaw.android.chat.OutgoingAttachment
import ai.openclaw.android.ui.mobileAccent
import ai.openclaw.android.ui.mobileBorder
import ai.openclaw.android.ui.mobileBorderStrong
import ai.openclaw.android.ui.mobileCallout
import ai.openclaw.android.ui.mobileCaption1
import ai.openclaw.android.ui.mobileCaption2
import ai.openclaw.android.ui.mobileDanger
import ai.openclaw.android.ui.mobileSuccess
import ai.openclaw.android.ui.mobileSuccessSoft
import ai.openclaw.android.ui.mobileSurfaceStrong
import ai.openclaw.android.ui.mobileText
import ai.openclaw.android.ui.mobileTextSecondary
import ai.openclaw.android.ui.mobileWarning
import ai.openclaw.android.ui.mobileWarningSoft
import java.io.ByteArrayOutputStream
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

@Composable
fun ChatSheetContent(viewModel: MainViewModel) {
  val messages by viewModel.chatMessages.collectAsState()
  val errorText by viewModel.chatError.collectAsState()
  val pendingRunCount by viewModel.pendingRunCount.collectAsState()
  val healthOk by viewModel.chatHealthOk.collectAsState()
  val connectionState by viewModel.chatConnectionState.collectAsState()
  val sessionKey by viewModel.chatSessionKey.collectAsState()
  val mainSessionKey by viewModel.mainSessionKey.collectAsState()
  val thinkingLevel by viewModel.chatThinkingLevel.collectAsState()
  val streamingAssistantText by viewModel.chatStreamingAssistantText.collectAsState()
  val pendingToolCalls by viewModel.chatPendingToolCalls.collectAsState()
  val queuedItems by viewModel.chatQueuedItems.collectAsState()
  val sessions by viewModel.chatSessions.collectAsState()

  LaunchedEffect(mainSessionKey) {
    viewModel.loadChat(mainSessionKey)
    viewModel.refreshChatSessions(limit = 200)
  }

  val context = LocalContext.current
  val resolver = context.contentResolver
  val scope = rememberCoroutineScope()

  val attachments = remember { mutableStateListOf<PendingImageAttachment>() }
  var showSurfaceHint by rememberSaveable { mutableStateOf(true) }

  val pickImages =
    rememberLauncherForActivityResult(ActivityResultContracts.GetMultipleContents()) { uris ->
      if (uris.isNullOrEmpty()) return@rememberLauncherForActivityResult
      scope.launch(Dispatchers.IO) {
        val next =
          uris.take(8).mapNotNull { uri ->
            try {
              loadImageAttachment(resolver, uri)
            } catch (_: Throwable) {
              null
            }
          }
        withContext(Dispatchers.Main) {
          attachments.addAll(next)
        }
      }
    }

  val imeVisible = WindowInsets.ime.getBottom(LocalDensity.current) > 0
  val compactMode = imeVisible

  Column(
    modifier =
      Modifier
        .fillMaxSize()
        .padding(horizontal = if (compactMode) 16.dp else 20.dp, vertical = if (compactMode) 8.dp else 12.dp),
    verticalArrangement = Arrangement.spacedBy(if (compactMode) 6.dp else 8.dp),
  ) {
    ChatThreadSelector(
      sessionKey = sessionKey,
      sessions = sessions,
      messages = messages,
      mainSessionKey = mainSessionKey,
      healthOk = healthOk,
      connectionState = connectionState,
      compactMode = compactMode,
      onSelectSession = { key -> viewModel.switchChatSession(key) },
    )

    if (showSurfaceHint) {
      ChatSurfaceHint(onDismiss = { showSurfaceHint = false })
    }

    if (!errorText.isNullOrBlank()) {
      ChatErrorRail(errorText = errorText!!)
    }

    ChatMessageListCard(
      messages = messages,
      pendingRunCount = pendingRunCount,
      pendingToolCalls = pendingToolCalls,
      streamingAssistantText = streamingAssistantText,
      healthOk = healthOk,
      modifier = Modifier.weight(1f, fill = true),
    )

    Row(modifier = Modifier.fillMaxWidth().imePadding()) {
      ChatComposer(
        healthOk = healthOk,
        thinkingLevel = thinkingLevel,
        pendingRunCount = pendingRunCount,
        queuedCount = queuedItems.size,
        errorText = errorText,
        attachments = attachments,
        onPickImages = { pickImages.launch("image/*") },
        onRemoveAttachment = { id -> attachments.removeAll { it.id == id } },
        onSetThinkingLevel = { level -> viewModel.setChatThinkingLevel(level) },
        onRefresh = {
          viewModel.refreshChat()
          viewModel.refreshChatSessions(limit = 200)
        },
        onAbort = { viewModel.abortChat() },
        onRetryLast = {
          val retried = viewModel.retryLastChatMessage()
          if (!retried) {
            viewModel.refreshChat()
          }
        },
        onSend = { text, reEvaluateOnReconnect ->
          val outgoing =
            attachments.map { att ->
              OutgoingAttachment(
                type = "image",
                mimeType = att.mimeType,
                fileName = att.fileName,
                base64 = att.base64,
              )
            }
          viewModel.sendChat(
            message = text,
            thinking = thinkingLevel,
            attachments = outgoing,
            reEvaluateOnReconnect = reEvaluateOnReconnect,
          )
          attachments.clear()
        },
      )
    }
  }
}

@Composable
private fun ChatThreadSelector(
  sessionKey: String,
  sessions: List<ChatSessionEntry>,
  messages: List<ChatMessage>,
  mainSessionKey: String,
  healthOk: Boolean,
  connectionState: ChatConnectionState,
  compactMode: Boolean,
  onSelectSession: (String) -> Unit,
) {
  val sessionOptions = resolveSessionChoices(sessionKey, sessions, mainSessionKey = mainSessionKey)
  val currentSessionLabel =
    friendlySessionName(sessionOptions.firstOrNull { it.key == sessionKey }?.displayName ?: sessionKey)
  val context = LocalContext.current
  var copiedAll by remember(messages, sessionKey) { mutableStateOf(false) }

  LaunchedEffect(copiedAll) {
    if (!copiedAll) return@LaunchedEffect
    kotlinx.coroutines.delay(1500)
    copiedAll = false
  }

  val threadTranscript =
    remember(messages) {
      messages
        .mapNotNull { msg ->
          val text =
            msg.content
              .asSequence()
              .filter { it.type == "text" }
              .mapNotNull { it.text?.trim() }
              .filter { it.isNotEmpty() }
              .joinToString("\n\n")
              .trim()
          if (text.isBlank()) null else "${msg.role.uppercase()}:\n$text"
        }
        .joinToString("\n\n")
        .trim()
    }

  Column(modifier = Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(8.dp)) {
    if (!compactMode) {
      Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.SpaceBetween,
        verticalAlignment = androidx.compose.ui.Alignment.CenterVertically,
      ) {
        Text(
          text = "SESSION",
          style = mobileCaption1.copy(fontWeight = FontWeight.Bold, letterSpacing = 0.8.sp),
          color = mobileTextSecondary,
        )
        Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = androidx.compose.ui.Alignment.CenterVertically) {
          Text(
            text = currentSessionLabel,
            style = mobileCallout.copy(fontWeight = FontWeight.SemiBold),
            color = mobileText,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
          )
          if (threadTranscript.isNotBlank()) {
            Surface(
              shape = RoundedCornerShape(999.dp),
              color = if (copiedAll) mobileSuccessSoft else mobileSurfaceStrong,
              border = BorderStroke(1.dp, if (copiedAll) mobileSuccess.copy(alpha = 0.4f) else mobileBorder),
              onClick = {
                val manager = context.getSystemService(Context.CLIPBOARD_SERVICE) as? ClipboardManager
                manager?.setPrimaryClip(ClipData.newPlainText("chat-thread", threadTranscript))
                copiedAll = true
              },
            ) {
              Text(
                text = if (copiedAll) "Copied all" else "Copy all",
                style = mobileCaption2.copy(fontWeight = FontWeight.SemiBold),
                color = if (copiedAll) mobileSuccess else mobileTextSecondary,
                modifier = Modifier.padding(horizontal = 8.dp, vertical = 4.dp),
              )
            }
          }
          ChatConnectionPill(
            healthOk = healthOk,
            connectionState = connectionState,
          )
        }
      }
    }

    if (compactMode) {
      Surface(
        modifier = Modifier.fillMaxWidth(),
        shape = RoundedCornerShape(12.dp),
        color = mobileSurfaceStrong,
        border = BorderStroke(1.dp, mobileBorder),
      ) {
        Row(
          modifier = Modifier.fillMaxWidth().padding(horizontal = 10.dp, vertical = 8.dp),
          horizontalArrangement = Arrangement.SpaceBetween,
          verticalAlignment = androidx.compose.ui.Alignment.CenterVertically,
        ) {
          Text(
            text = "Session: $currentSessionLabel",
            style = mobileCaption1.copy(fontWeight = FontWeight.SemiBold),
            color = mobileText,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.weight(1f),
          )
          Text(
            text = "Typing mode",
            style = mobileCaption2,
            color = mobileTextSecondary,
          )
        }
      }
    } else {
      Row(
        modifier = Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
      ) {
        for (entry in sessionOptions) {
          val active = entry.key == sessionKey
          Surface(
            onClick = { onSelectSession(entry.key) },
            shape = RoundedCornerShape(14.dp),
            color = if (active) mobileAccent else mobileSurfaceStrong,
            border = BorderStroke(1.dp, if (active) Color(0xFF154CAD) else mobileBorderStrong),
            tonalElevation = 0.dp,
            shadowElevation = 0.dp,
          ) {
            Text(
              text = friendlySessionName(entry.displayName ?: entry.key),
              style = mobileCaption1.copy(fontWeight = if (active) FontWeight.Bold else FontWeight.SemiBold),
              color = if (active) Color.White else mobileText,
              maxLines = 1,
              overflow = TextOverflow.Ellipsis,
              modifier = Modifier.padding(horizontal = 12.dp, vertical = 8.dp),
            )
          }
        }
      }
    }
  }
}

@Composable
private fun ChatConnectionPill(
  healthOk: Boolean,
  connectionState: ChatConnectionState,
) {
  val (label, fg, bg) =
    when {
      healthOk -> Triple("Connected", mobileSuccess, mobileSuccessSoft)
      connectionState == ChatConnectionState.Connecting -> Triple("Connecting…", mobileWarning, mobileWarningSoft)
      else -> Triple("Reconnecting…", mobileWarning, mobileWarningSoft)
    }

  Surface(
    shape = RoundedCornerShape(999.dp),
    color = bg,
    border = BorderStroke(1.dp, fg.copy(alpha = 0.35f)),
  ) {
    Text(
      text = label,
      style = mobileCaption1.copy(fontWeight = FontWeight.SemiBold),
      color = fg,
      modifier = Modifier.padding(horizontal = 8.dp, vertical = 3.dp),
    )
  }
}

@Composable
private fun ChatSurfaceHint(onDismiss: () -> Unit) {
  Surface(
    modifier = Modifier.fillMaxWidth(),
    color = mobileWarningSoft,
    shape = RoundedCornerShape(12.dp),
    border = BorderStroke(1.dp, mobileWarning.copy(alpha = 0.35f)),
  ) {
    Row(
      modifier = Modifier.fillMaxWidth().padding(horizontal = 10.dp, vertical = 8.dp),
      horizontalArrangement = Arrangement.SpaceBetween,
      verticalAlignment = androidx.compose.ui.Alignment.CenterVertically,
    ) {
      Text(
        text = "Tip: use one primary chat surface at a time (App or Telegram) to avoid overlap.",
        style = mobileCaption1,
        color = mobileText,
        modifier = Modifier.weight(1f),
      )
      Surface(
        onClick = onDismiss,
        shape = RoundedCornerShape(999.dp),
        color = mobileSurfaceStrong,
        border = BorderStroke(1.dp, mobileBorderStrong),
      ) {
        Text(
          text = "Dismiss",
          style = mobileCaption2.copy(fontWeight = FontWeight.SemiBold),
          color = mobileText,
          modifier = Modifier.padding(horizontal = 8.dp, vertical = 4.dp),
        )
      }
    }
  }
}

@Composable
private fun ChatErrorRail(errorText: String) {
  Surface(
    modifier = Modifier.fillMaxWidth(),
    color = androidx.compose.ui.graphics.Color.White,
    shape = RoundedCornerShape(12.dp),
    border = androidx.compose.foundation.BorderStroke(1.dp, mobileDanger),
  ) {
    Column(modifier = Modifier.padding(horizontal = 10.dp, vertical = 8.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) {
      Text(
        text = "CHAT ERROR",
        style = mobileCaption2.copy(letterSpacing = 0.6.sp),
        color = mobileDanger,
      )
      Text(text = errorText, style = mobileCallout, color = mobileText)
    }
  }
}

data class PendingImageAttachment(
  val id: String,
  val fileName: String,
  val mimeType: String,
  val base64: String,
)

private suspend fun loadImageAttachment(resolver: ContentResolver, uri: Uri): PendingImageAttachment {
  val mimeType = resolver.getType(uri) ?: "image/*"
  val fileName = (uri.lastPathSegment ?: "image").substringAfterLast('/')
  val bytes =
    withContext(Dispatchers.IO) {
      resolver.openInputStream(uri)?.use { input ->
        val out = ByteArrayOutputStream()
        input.copyTo(out)
        out.toByteArray()
      } ?: ByteArray(0)
    }
  if (bytes.isEmpty()) throw IllegalStateException("empty attachment")
  val base64 = Base64.encodeToString(bytes, Base64.NO_WRAP)
  return PendingImageAttachment(
    id = uri.toString() + "#" + System.currentTimeMillis().toString(),
    fileName = fileName,
    mimeType = mimeType,
    base64 = base64,
  )
}
