package ai.openclaw.app.ui

import ai.openclaw.app.GatewayExecApprovalSummary
import ai.openclaw.app.chat.ChatQuestionPrompt
import ai.openclaw.app.chat.ChatQuestionStatus
import ai.openclaw.app.i18n.nativeString
import ai.openclaw.app.i18n.resolveNativeText
import ai.openclaw.app.takeUtf16Safe
import ai.openclaw.app.ui.design.ClawTheme
import androidx.compose.foundation.background
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsFocusedAsState
import androidx.compose.foundation.interaction.collectIsHoveredAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.HelpOutline
import androidx.compose.material.icons.outlined.Shield
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LocalMinimumInteractiveComponentSize
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.onPreviewKeyEvent
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Popup
import androidx.compose.ui.window.PopupProperties

internal enum class SidebarAttentionKind { Question, Approval }

internal data class SidebarAttentionRequest(
  val kind: SidebarAttentionKind,
  val id: String,
  val sessionKey: String,
  val preview: String,
  val count: Int,
  val createdAtMs: Long,
)

internal data class SidebarAttention(
  val requests: List<SidebarAttentionRequest>,
  val gatewayStableId: String?,
) {
  val first: SidebarAttentionRequest get() = requests.first()
  val disclosureIdentity: SidebarAttentionDisclosureIdentity get() =
    SidebarAttentionDisclosureIdentity(gatewayStableId, first.kind, first.id, first.sessionKey, first.createdAtMs)
  val count: Int get() = requests.filter { it.kind == first.kind }.sumOf { it.count }
  val status: String get() =
    when (first.kind) {
      SidebarAttentionKind.Question -> if (count == 1) nativeString("Waiting for answer") else nativeString("\${count} questions need answers", count)
      SidebarAttentionKind.Approval -> if (count == 1) nativeString("Waiting for approval") else nativeString("\${count} approvals need review", count)
    }
  val more: String? get() = (count - 1).takeIf { it > 0 }?.let { nativeString("+\${count} more", it) }
  val label: String get() = listOfNotNull(status, first.preview.takeIf { it.isNotBlank() }, more).joinToString("\n")
}

internal data class SidebarAttentionDisclosureIdentity(
  val gatewayStableId: String?,
  val kind: SidebarAttentionKind,
  val id: String,
  val sessionKey: String,
  val createdAtMs: Long,
)

internal fun sidebarAttentionSessionKey(
  key: String,
  agentId: String?,
): String {
  val trimmed = key.trim()
  return if (trimmed.startsWith("agent:")) trimmed else "agent:${agentId?.trim()?.takeIf { it.isNotEmpty() } ?: "main"}:$trimmed"
}

internal fun sidebarAttentionRequests(
  questions: List<ChatQuestionPrompt>,
  approvals: List<GatewayExecApprovalSummary>,
  defaultAgentId: String?,
  nowMs: Long = System.currentTimeMillis(),
): List<SidebarAttentionRequest> {
  val pendingQuestions =
    questions.mapNotNull { prompt ->
      val record = prompt.record
      val key = record.sessionKey?.takeIf { it.isNotBlank() } ?: return@mapNotNull null
      if (prompt.status(nowMs) !in setOf(ChatQuestionStatus.Pending, ChatQuestionStatus.Submitting)) return@mapNotNull null
      SidebarAttentionRequest(
        SidebarAttentionKind.Question,
        record.id,
        sidebarAttentionSessionKey(key, record.agentId ?: defaultAgentId),
        attentionPreview(
          record.questions
            .firstOrNull()
            ?.question
            .orEmpty(),
        ),
        record.questions.size,
        record.createdAtMs,
      )
    }
  val pendingApprovals =
    approvals.mapNotNull { approval ->
      val key = approval.sessionKey?.takeIf { it.isNotBlank() } ?: return@mapNotNull null
      if (approval.expiresAtMs?.let { it <= nowMs } == true) return@mapNotNull null
      SidebarAttentionRequest(SidebarAttentionKind.Approval, approval.id, sidebarAttentionSessionKey(key, approval.agentId ?: defaultAgentId), attentionPreview(approval.title ?: approval.commandText.resolveNativeText()), 1, approval.createdAtMs ?: Long.MAX_VALUE)
    }
  return pendingQuestions + pendingApprovals
}

internal fun summarizeSidebarAttention(
  requests: List<SidebarAttentionRequest>,
  gatewayStableId: String?,
): SidebarAttention? =
  requests
    .distinctBy { it.kind to it.id }
    .sortedWith(compareBy<SidebarAttentionRequest> { it.createdAtMs }.thenBy { it.id }.thenBy { it.kind.name })
    .takeIf { it.isNotEmpty() }
    ?.let { SidebarAttention(it, gatewayStableId) }

private fun attentionPreview(text: String): String {
  val line = text.replace(Regex("\\s+"), " ").trim()
  return if (line.length > 240) line.takeUtf16Safe(239) + "…" else line
}

@Composable
internal fun SidebarAttentionIndicator(
  attention: SidebarAttention,
  palette: SidebarPalette,
) {
  val interactions = remember { MutableInteractionSource() }
  val hovered by interactions.collectIsHoveredAsState()
  val focused by interactions.collectIsFocusedAsState()
  val popupOffset = with(LocalDensity.current) { 32.dp.roundToPx() }
  // Background requests and summary updates do not replace the request being read.
  val identity = attention.disclosureIdentity
  var opened by remember(identity) { mutableStateOf(false) }
  var dismissed by remember(identity, hovered, focused) { mutableStateOf(false) }
  Box {
    CompositionLocalProvider(LocalMinimumInteractiveComponentSize provides 0.dp) {
      IconButton(
        onClick = {
          opened = !opened
          dismissed = !opened
        },
        interactionSource = interactions,
        modifier =
          Modifier.size(28.dp).semantics { contentDescription = attention.label }.testTag("sidebar-attention-${attention.first.kind.name.lowercase()}").onPreviewKeyEvent {
            if (it.key == Key.Escape) {
              opened = false
              dismissed = true
              true
            } else {
              false
            }
          },
      ) {
        Icon(if (attention.first.kind == SidebarAttentionKind.Question) Icons.AutoMirrored.Outlined.HelpOutline else Icons.Outlined.Shield, contentDescription = null, tint = ClawTheme.colors.primary, modifier = Modifier.size(17.dp))
      }
    }
    if (!dismissed && (opened || hovered || focused)) {
      Popup(alignment = Alignment.TopEnd, offset = IntOffset(0, popupOffset), onDismissRequest = {
        opened = false
        dismissed = true
      }, properties = PopupProperties(focusable = opened)) {
        Column(
          Modifier
            .widthIn(max = 280.dp)
            .background(palette.elevated, RoundedCornerShape(10.dp))
            .padding(12.dp)
            .testTag("sidebar-attention-detail"),
          verticalArrangement = Arrangement.spacedBy(6.dp),
        ) {
          Text(attention.status, color = palette.text, style = ClawTheme.type.caption.copy(fontWeight = FontWeight.SemiBold))
          if (attention.first.preview.isNotBlank()) Text(attention.first.preview, color = palette.text, style = ClawTheme.type.caption)
          attention.more?.let { Text(it, color = palette.muted, style = ClawTheme.type.caption) }
        }
      }
    }
  }
}
