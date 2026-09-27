package ai.openclaw.app.ui.chat

import ai.openclaw.app.i18n.nativeString
import ai.openclaw.app.ui.design.ClawTheme
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.size
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.MicNone
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp

@Composable
internal fun ChatComposerActivity(
  dictationState: ChatDictationState,
  partialTranscript: String,
  preparingAttachments: Boolean,
  queuingMessage: Boolean,
  modifier: Modifier = Modifier,
) {
  if (!dictationState.isActive && !preparingAttachments && !queuingMessage) return
  Column(modifier = modifier, verticalArrangement = Arrangement.spacedBy(4.dp)) {
    val dictationLabel =
      when (dictationState) {
        ChatDictationState.Starting -> nativeString("Starting dictation…")
        ChatDictationState.Listening -> nativeString("Listening…")
        ChatDictationState.Transcribing -> nativeString("Transcribing…")
        else -> null
      }
    if (dictationLabel != null) {
      ChatComposerActivityRow(dictationLabel, listening = dictationState is ChatDictationState.Listening)
      if (partialTranscript.isNotEmpty()) {
        Text(
          text = partialTranscript,
          style = ClawTheme.type.caption,
          color = ClawTheme.colors.textMuted,
          maxLines = 2,
          overflow = TextOverflow.Ellipsis,
        )
      }
    }
    if (preparingAttachments) ChatComposerActivityRow(nativeString("Preparing attachments…"))
    if (queuingMessage) ChatComposerActivityRow(nativeString("Queuing message…"))
  }
}

@Composable
private fun ChatComposerActivityRow(
  label: String,
  listening: Boolean = false,
) {
  Row(
    modifier = Modifier.semantics(mergeDescendants = true) { liveRegion = LiveRegionMode.Polite },
    verticalAlignment = Alignment.CenterVertically,
    horizontalArrangement = Arrangement.spacedBy(6.dp),
  ) {
    if (listening) {
      Icon(Icons.Outlined.MicNone, contentDescription = null, tint = ClawTheme.colors.primary, modifier = Modifier.size(14.dp))
    } else {
      CircularProgressIndicator(modifier = Modifier.size(14.dp), color = ClawTheme.colors.primary, strokeWidth = 2.dp)
    }
    Text(text = label, style = ClawTheme.type.caption, color = ClawTheme.colors.textMuted)
  }
}
