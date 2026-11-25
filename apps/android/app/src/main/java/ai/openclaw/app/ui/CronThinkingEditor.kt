package ai.openclaw.app.ui

import ai.openclaw.app.GatewayCronModelChoices
import ai.openclaw.app.i18n.nativeString
import ai.openclaw.app.i18n.resolveNativeText
import ai.openclaw.app.ui.chat.providerQualifiedRef
import ai.openclaw.app.ui.design.ClawSecondaryButton
import ai.openclaw.app.ui.design.ClawTextField
import ai.openclaw.app.ui.design.ClawTheme
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material.icons.filled.KeyboardArrowUp
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.unit.dp

@Composable
internal fun CronThinkingEditor(
  value: String,
  model: String,
  enabled: Boolean,
  catalog: GatewayCronModelChoices,
  onRefresh: () -> Unit,
  onChange: (String) -> Unit,
) {
  var open by remember { mutableStateOf(false) }
  val focus = remember { FocusRequester() }
  val keyboard = LocalSoftwareKeyboardController.current

  fun close() {
    open = false
    keyboard?.hide()
    focus.requestFocus()
  }

  fun select(level: String) {
    onChange(level)
    close()
  }
  // Only the selected model's advertised capabilities supply choices; unknown/default refs stay authorable.
  val levels =
    catalog.models
      .firstOrNull { it.providerQualifiedRef() == model }
      ?.thinkingLevels
      .orEmpty()
  val defaultLabel = nativeString("Default thinking")
  Text(nativeString("Thinking"), style = ClawTheme.type.label)
  ClawSecondaryButton(
    text = levels.firstOrNull { it.id == value }?.label ?: value.ifBlank { defaultLabel },
    onClick = {
      if (open) {
        close()
      } else {
        open = true
        onRefresh()
      }
    },
    enabled = enabled,
    icon = if (open) Icons.Default.KeyboardArrowUp else Icons.Default.KeyboardArrowDown,
    modifier =
      Modifier.fillMaxWidth().focusRequester(focus).semantics {
        stateDescription = nativeString(if (open) "Expanded" else "Collapsed")
      },
  )
  if (!open || !enabled) return
  var custom by remember { mutableStateOf(false) }
  var draft by remember { mutableStateOf(value) }
  BackHandler { close() }
  Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
    TextButton(onClick = { select("") }) { Text(defaultLabel) }
    if (catalog.loading) Text(nativeString("Loading models…"), color = ClawTheme.colors.textMuted)
    catalog.error?.let { Text(it.resolveNativeText(), color = ClawTheme.colors.warning) }
    for (level in levels) {
      TextButton(onClick = { select(level.id) }, modifier = Modifier.fillMaxWidth()) { Text(level.label, modifier = Modifier.fillMaxWidth()) }
    }
    if (catalog.error != null) TextButton(onClick = onRefresh, enabled = !catalog.loading) { Text(nativeString("Refresh models")) }
    if (custom) {
      ClawTextField(value = draft, onValueChange = { draft = it }, label = nativeString("Custom thinking level"), placeholder = nativeString("Provider-specific level"))
      TextButton(onClick = { select(draft.trim()) }, enabled = draft.isNotBlank()) { Text(nativeString("Use thinking level")) }
    } else {
      TextButton(onClick = { custom = true }) { Text(nativeString("Enter another thinking level")) }
    }
    TextButton(onClick = { close() }) { Text(nativeString("Cancel")) }
  }
}
