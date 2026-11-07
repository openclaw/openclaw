package ai.openclaw.app.ui.chat

import ai.openclaw.app.chat.ChatPendingInputsPage
import ai.openclaw.app.i18n.nativeString
import ai.openclaw.app.ui.design.ClawTheme
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.key
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp

/** Read-only server custody lives with the composer, including its compact-height Details view. */
@Composable
internal fun ChatGatewayQueue(page: ChatPendingInputsPage) {
  val inputs = page.items.filter { it.message != null && it.state in setOf("queued", "cancelled") }
  if (inputs.isEmpty() && page.queuedCount != null && page.queuedCount == 0) return
  if (inputs.isEmpty() && page.queuedCount == null && page.nextBefore == null) return
  Column(
    modifier =
      Modifier
        .fillMaxWidth()
        .heightIn(max = 180.dp)
        .verticalScroll(rememberScrollState())
        .testTag("chat-gateway-queue")
        .padding(horizontal = 8.dp, vertical = 4.dp),
    verticalArrangement = Arrangement.spacedBy(4.dp),
  ) {
    Text(nativeString("Gateway inputs"), style = ClawTheme.type.label, color = ClawTheme.colors.textMuted)
    page.queuedCount?.let { count ->
      Text(nativeString("Queued on Gateway: \$count", count), style = ClawTheme.type.caption, color = ClawTheme.colors.textMuted)
    }
    if (page.nextBefore != null || (page.queuedCount ?: 0) > inputs.count { it.queued }) {
      Text(nativeString("Showing recent inputs only."), style = ClawTheme.type.caption, color = ClawTheme.colors.textMuted)
    }
    inputs.forEach { input ->
      key(input.id) {
        val message = checkNotNull(input.message)
        val preview =
          chatMessagePlainText(message.content).ifBlank {
            message.content
              .mapNotNull { it.fileName }
              .joinToString(", ")
              .ifBlank { nativeString("Attachment") }
          }
        val status =
          when {
            input.state == "cancelled" -> nativeString("Cancelled")
            input.queued -> nativeString("Queued on Gateway")
            else -> nativeString("Accepted by Gateway")
          }
        Column(Modifier.fillMaxWidth().semantics(mergeDescendants = true) {}) {
          Text(
            text = preview,
            style = ClawTheme.type.caption,
            color = ClawTheme.colors.text,
            maxLines = 2,
            overflow = TextOverflow.Ellipsis,
          )
          Text(
            text = listOfNotNull(message.senderLabel, status).joinToString(" · "),
            style = ClawTheme.type.captionSmall,
            color = ClawTheme.colors.textMuted,
          )
        }
      }
    }
  }
}
