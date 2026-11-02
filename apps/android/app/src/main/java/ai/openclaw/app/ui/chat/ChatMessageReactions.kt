package ai.openclaw.app.ui.chat

import ai.openclaw.app.chat.ChatReactionSummary
import ai.openclaw.app.chat.isReactionEmoji
import ai.openclaw.app.i18n.nativeStringResource
import ai.openclaw.app.ui.AppModalBottomSheet
import ai.openclaw.app.ui.design.ClawIconButton
import ai.openclaw.app.ui.design.ClawPill
import ai.openclaw.app.ui.design.ClawTheme
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.AddReaction
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.TextFieldValue
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

private val quickReactions = listOf("👍", "❤️", "🎉", "👀", "🚀", "😂")

@Composable
internal fun ChatMessageReactions(
  reactions: List<ChatReactionSummary>,
  viewerId: String?,
  onReact: ((String, Boolean) -> Unit)?,
  onAddReaction: (() -> Unit)?,
) {
  if (reactions.isEmpty()) return
  val you = nativeStringResource("You")
  FlowRow(
    horizontalArrangement = Arrangement.spacedBy(6.dp),
    verticalArrangement = Arrangement.spacedBy(4.dp),
    itemVerticalAlignment = Alignment.CenterVertically,
  ) {
    reactions.forEach { reaction ->
      val own = reaction.identities.any { it.id == viewerId }
      val names = reaction.identities.map { if (it.id == viewerId) you else it.label ?: it.id }.sortedByDescending { it == you }
      val shown = names.take(3).joinToString(", ")
      val reactorNames = if (names.size > 3) nativeStringResource("\$names and \$count others", shown, names.size - 3) else shown
      val reactors = nativeStringResource("\$names reacted with \$emoji", reactorNames, reaction.emoji)
      val description = nativeStringResource("\$emoji \$count. \$reactors", reaction.emoji, reaction.count, reactors)
      ClawPill(
        text = nativeStringResource("\$emoji \$count", reaction.emoji, reaction.count),
        selected = own,
        modifier =
          Modifier.semantics {
            contentDescription = description
            selected = own
          },
        onClick = onReact?.let { react -> { react(reaction.emoji, own) } },
      )
    }
    onAddReaction?.let {
      ClawIconButton(Icons.Default.AddReaction, nativeStringResource("Add reaction"), it)
    }
  }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun ChatReactionPicker(
  reactions: List<ChatReactionSummary>,
  viewerId: String?,
  onDismiss: () -> Unit,
  onSelect: (String, Boolean) -> Unit,
) {
  var custom by remember { mutableStateOf(false) }
  var value by remember { mutableStateOf(TextFieldValue()) }
  var invalid by remember { mutableStateOf(false) }
  val focusRequester = remember { FocusRequester() }
  val activeEmoji = reactions.filter { reaction -> reaction.identities.any { it.id == viewerId } }.map { it.emoji }.toSet()
  val select: (String) -> Unit = { emoji -> onSelect(emoji, emoji in activeEmoji) }
  val applyCustom: () -> Unit = {
    if (value.composition == null) {
      val emoji = value.text.trim()
      if (isReactionEmoji(emoji)) select(emoji) else invalid = emoji.isNotEmpty()
    }
  }
  LaunchedEffect(custom) {
    if (custom) focusRequester.requestFocus()
  }
  AppModalBottomSheet(
    onDismissRequest = onDismiss,
    sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
    containerColor = ClawTheme.colors.surface,
    contentColor = ClawTheme.colors.text,
  ) {
    Column(
      modifier = Modifier.fillMaxWidth().padding(horizontal = 20.dp).padding(bottom = 24.dp),
      verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
      Text(if (custom) nativeStringResource("Add reaction") else nativeStringResource("Quick reactions"), style = ClawTheme.type.title)
      if (custom) {
        TextButton(onClick = {
          custom = false
          value = TextFieldValue()
          invalid = false
        }) { Text(nativeStringResource("Back to quick reactions")) }
        OutlinedTextField(
          value = value,
          onValueChange = { next ->
            value = next
            invalid = false
            // Commit the IME's completed emoji, never an intermediate composition.
            val emoji = next.text.trim()
            if (next.composition == null && isReactionEmoji(emoji)) select(emoji)
          },
          modifier = Modifier.fillMaxWidth().focusRequester(focusRequester),
          label = { Text(nativeStringResource("Emoji")) },
          placeholder = { Text(nativeStringResource("Any emoji")) },
          supportingText = { Text(if (invalid) nativeStringResource("Reactions are a single emoji.") else nativeStringResource("Type or paste an emoji.")) },
          isError = invalid,
          singleLine = true,
          keyboardOptions = KeyboardOptions(autoCorrectEnabled = false, imeAction = ImeAction.Done),
          keyboardActions = KeyboardActions(onDone = { applyCustom() }),
        )
        TextButton(onClick = applyCustom, modifier = Modifier.align(Alignment.End)) { Text(nativeStringResource("Add reaction")) }
      } else {
        FlowRow(horizontalArrangement = Arrangement.spacedBy(4.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
          quickReactions.forEach { emoji ->
            val own = emoji in activeEmoji
            Surface(
              onClick = { select(emoji) },
              modifier = Modifier.size(48.dp).semantics { selected = own },
              shape = CircleShape,
              color = if (own) ClawTheme.colors.accentSoft else ClawTheme.colors.surfaceRaised,
              border = BorderStroke(1.dp, if (own) ClawTheme.colors.accent else ClawTheme.colors.border),
            ) {
              Box(contentAlignment = Alignment.Center) { Text(emoji, fontSize = 26.sp) }
            }
          }
        }
        TextButton(onClick = { custom = true }) { Text(nativeStringResource("More…")) }
      }
    }
  }
}
