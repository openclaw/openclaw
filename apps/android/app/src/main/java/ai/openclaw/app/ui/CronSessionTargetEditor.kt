package ai.openclaw.app.ui

import ai.openclaw.app.GatewayCronPayloadEdit
import ai.openclaw.app.chat.ChatSessionEntry
import ai.openclaw.app.chat.filterSessionEntries
import ai.openclaw.app.i18n.nativeString
import ai.openclaw.app.ui.design.ClawSecondaryButton
import ai.openclaw.app.ui.design.ClawTheme
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material.icons.filled.KeyboardArrowUp
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.unit.dp

@Composable
internal fun CronSessionTargetEditor(
  value: String,
  payload: GatewayCronPayloadEdit,
  onChange: (String) -> Unit,
  enabled: Boolean,
  sessions: List<ChatSessionEntry>,
  loadingMore: Boolean,
  hasMore: Boolean,
  loadFailed: Boolean,
  onLoadMore: () -> Unit,
) {
  var open by remember { mutableStateOf(false) }
  val focus = remember { FocusRequester() }
  val keyboard = LocalSoftwareKeyboardController.current

  fun close() {
    open = false
    keyboard?.hide()
    focus.requestFocus()
  }
  val supportsConversation = payload is GatewayCronPayloadEdit.AgentTurn || payload is GatewayCronPayloadEdit.Command
  val modes = listOf("main" to nativeString("Main session"), "isolated" to nativeString("Isolated run"), "current" to nativeString("Linked run"))
  // Present the Gateway-supported payload/target combinations without rewriting saved values.
  val allowedModes =
    modes.filter { (code, _) ->
      when (payload) {
        is GatewayCronPayloadEdit.SystemEvent -> code == "main"
        is GatewayCronPayloadEdit.ReadOnlyScript -> code != "current"
        is GatewayCronPayloadEdit.Command -> code != "main"
        is GatewayCronPayloadEdit.AgentTurn -> true
      }
    }
  val selected = sessions.firstOrNull { "session:" + it.key == value }
  val label =
    modes.firstOrNull { it.first == value }?.second
      ?: selected?.let { sessionPresentationTitle(it) { it.key } }
      ?: value
  Text(nativeString("Session target"), style = ClawTheme.type.label)
  ClawSecondaryButton(
    text = label,
    onClick = { if (open) close() else open = true },
    enabled = enabled,
    modifier = Modifier.fillMaxWidth().focusRequester(focus).semantics { stateDescription = nativeString(if (open) "Expanded" else "Collapsed") },
    icon = if (open) Icons.Default.KeyboardArrowUp else Icons.Default.KeyboardArrowDown,
  )
  if (selected != null && sessions.count { sessionPresentationTitle(it) { it.key } == label } > 1) {
    Text(selected.key, style = ClawTheme.type.caption, color = ClawTheme.colors.textMuted)
  }
  if (!open || !enabled) return
  var search by remember { mutableStateOf("") }
  var custom by remember { mutableStateOf(false) }
  var key by remember { mutableStateOf(value.takeIf { it.startsWith("session:") }?.removePrefix("session:").orEmpty()) }

  fun select(target: String) {
    onChange(target)
    close()
  }
  BackHandler { close() }
  Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
    Column(Modifier.heightIn(max = 480.dp).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(8.dp)) {
      allowedModes.forEach { (code, title) ->
        CronTargetOption(
          title = title,
          subtitle =
            when (code) {
              "main" -> nativeString("Run in the agent’s main session.")
              "current" -> nativeString("Separate run linked to the creating conversation.")
              else -> nativeString("Run separately from existing conversations.")
            },
          selected = value == code,
          onSelect = { select(code) },
        )
      }
      if (supportsConversation) {
        HorizontalDivider()
        OutlinedTextField(value = search, onValueChange = { search = it }, label = { Text(nativeString("Search loaded sessions")) }, singleLine = true, modifier = Modifier.fillMaxWidth())
        val choices = filterSessionEntries(sessions.filter { it.archived != true && it.modelSelectionLocked != true }, search)
        choices.forEach { session ->
          CronTargetOption(
            title = sessionPresentationTitle(session) { session.key },
            subtitle = session.key,
            selected = value == "session:" + session.key,
            onSelect = { select("session:" + session.key) },
          )
        }
        if (loadFailed) Text(nativeString("Could not load more sessions. Try again."), color = ClawTheme.colors.warning)
        if (loadingMore) {
          Text(nativeString("Loading"))
        } else if (choices.isEmpty()) {
          Text(if (search.isBlank()) nativeString("No loaded sessions.") else nativeString("No matching loaded sessions."), color = ClawTheme.colors.textMuted)
        }
        if (hasMore) TextButton(onClick = onLoadMore, enabled = !loadingMore) { Text(nativeString("Load more sessions")) }
        if (custom) {
          OutlinedTextField(value = key, onValueChange = { key = it }, label = { Text(nativeString("Session key")) }, singleLine = true, modifier = Modifier.fillMaxWidth())
          TextButton(onClick = { select("session:" + key.trim()) }, enabled = key.isNotBlank()) { Text(nativeString("Use session")) }
        } else {
          TextButton(onClick = { custom = true }) { Text(nativeString("Enter another session key")) }
        }
      }
    }
    TextButton(onClick = { close() }) { Text(nativeString("Cancel")) }
  }
}

@Composable
private fun CronTargetOption(
  title: String,
  subtitle: String,
  selected: Boolean,
  onSelect: () -> Unit,
) {
  Row(
    Modifier.fillMaxWidth().selectable(selected = selected, onClick = onSelect, role = Role.RadioButton).padding(vertical = 6.dp),
    verticalAlignment = Alignment.CenterVertically,
    horizontalArrangement = Arrangement.spacedBy(8.dp),
  ) {
    RadioButton(selected = selected, onClick = null)
    Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
      Text(title, style = ClawTheme.type.body, color = ClawTheme.colors.text)
      Text(subtitle, style = ClawTheme.type.caption, color = ClawTheme.colors.textMuted)
    }
  }
}
