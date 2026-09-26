package ai.openclaw.app.ui.chat

import ai.openclaw.app.chat.ChatMessage
import ai.openclaw.app.chat.isTranscriptOnlyOpenClawAssistant
import ai.openclaw.app.i18n.nativeString
import ai.openclaw.app.ui.design.ClawTheme
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.sizeIn
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import java.text.DateFormat
import java.util.Date

/** A bubble describes its own recorded call, never the latest session/run snapshot. */
internal fun chatMessageMetadata(message: ChatMessage): List<Pair<String, String>> {
  if (message.role != "assistant" || message.isSyntheticDisplay || message.isTranscriptOnlyOpenClawAssistant() || message.isForwardedBoundary()) return emptyList()
  return buildList {
    fun tokens(
      label: String,
      value: Long?,
    ) {
      if (value != null && value > 0) add(label to formatCompactTokenCount(value))
    }
    tokens(nativeString("Input tokens"), message.usage?.input)
    tokens(nativeString("Output tokens"), message.usage?.output)
    tokens(nativeString("Cache read"), message.usage?.cacheRead)
    tokens(nativeString("Cache write"), message.usage?.cacheWrite)
    message.cost?.total?.takeIf { it.isFinite() && it > 0 }?.let {
      add(nativeString("Est. cost") to formatContextEstimatedCost(it))
    }
    message.model?.takeIf { it.isNotBlank() && it != "gateway-injected" && it != "delivery-mirror" }?.let {
      add(nativeString("Model") to it.substringAfterLast('/'))
    }
    // chat.history has no message-bound context limit. The current session limit
    // may belong to a different model/run and cannot describe an earlier call.
  }
}

@Composable
internal fun ChatMessageTimestamp(
  timestampMs: Long,
  metadata: List<Pair<String, String>>,
  modifier: Modifier = Modifier,
) {
  val density = LocalDensity.current
  val locale = LocalConfiguration.current.locales[0]
  var expanded by remember(timestampMs, metadata) { mutableStateOf(false) }
  val date = Date(timestampMs)
  val label = DateFormat.getTimeInstance(DateFormat.SHORT, locale).format(date)
  val absolute = DateFormat.getDateTimeInstance(DateFormat.MEDIUM, DateFormat.LONG, locale).format(date)
  Box(modifier) {
    Text(
      text = label,
      style = ClawTheme.type.caption.copy(fontSize = 11.5.sp, lineHeight = 14.sp, fontWeight = FontWeight.Normal),
      color = ClawTheme.colors.textSubtle,
      modifier =
        if (metadata.isEmpty()) {
          Modifier.semantics { contentDescription = absolute }
        } else {
          Modifier
            .sizeIn(minWidth = ClawTheme.spacing.touchTarget, minHeight = ClawTheme.spacing.touchTarget)
            .clickable(role = Role.Button, onClickLabel = nativeString("Message information")) { expanded = !expanded }
            .padding(vertical = 8.dp)
            .semantics { contentDescription = nativeString("Message information for \$timestamp", absolute) }
        },
    )
    DropdownMenu(expanded = expanded && metadata.isNotEmpty(), onDismissRequest = { expanded = false }) {
      CompositionLocalProvider(LocalDensity provides density) {
        Column(modifier = Modifier.padding(horizontal = 12.dp, vertical = 4.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
          Text(absolute, style = ClawTheme.type.caption, color = ClawTheme.colors.textMuted)
          metadata.forEach { (name, value) ->
            Text(nativeString("\$label: \$value", name, value), style = ClawTheme.type.caption, color = ClawTheme.colors.text)
          }
        }
      }
    }
  }
}
