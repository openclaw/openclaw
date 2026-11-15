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
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
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
internal fun CronModelEditor(
  value: String,
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

  fun select(model: String) {
    onChange(model)
    close()
  }
  val selected = catalog.models.firstOrNull { it.providerQualifiedRef() == value }
  val defaultLabel = nativeString("Default model")
  Text(nativeString("Model"), style = ClawTheme.type.label)
  ClawSecondaryButton(
    text = selected?.name ?: value.ifBlank { defaultLabel },
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
  var search by remember { mutableStateOf("") }
  var custom by remember { mutableStateOf(false) }
  var draft by remember { mutableStateOf(value) }
  val choices = catalog.models.filter { it.manualSelectionAllowed != false && (it.name.contains(search, ignoreCase = true) || it.providerQualifiedRef().contains(search, ignoreCase = true)) }.distinctBy { it.providerQualifiedRef() }
  BackHandler { close() }
  Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
    TextButton(onClick = { select("") }) { Text(defaultLabel) }
    ClawTextField(value = search, onValueChange = { search = it }, label = nativeString("Search models"), placeholder = nativeString("Model name or provider"))
    if (catalog.loading) Text(nativeString("Loading models…"), color = ClawTheme.colors.textMuted)
    catalog.error?.let { Text(it.resolveNativeText(), color = ClawTheme.colors.warning) }
    LazyColumn(Modifier.fillMaxWidth().heightIn(max = 240.dp)) {
      items(choices, key = { it.providerQualifiedRef() }) { model ->
        TextButton(onClick = { select(model.providerQualifiedRef()) }, enabled = model.available != false, modifier = Modifier.fillMaxWidth()) {
          Column(Modifier.fillMaxWidth()) {
            Text(model.name)
            Text(model.providerQualifiedRef(), style = ClawTheme.type.caption, color = ClawTheme.colors.textMuted)
            if (model.available == false) Text(nativeString("Unavailable"), style = ClawTheme.type.caption)
          }
        }
      }
    }
    if (choices.isEmpty() && !catalog.loading && catalog.error == null) Text(nativeString("No matching models."), color = ClawTheme.colors.textMuted)
    TextButton(onClick = onRefresh, enabled = !catalog.loading) { Text(nativeString("Refresh models")) }
    if (custom) {
      ClawTextField(value = draft, onValueChange = { draft = it }, label = nativeString("Custom model"), placeholder = nativeString("provider/model"))
      TextButton(onClick = { select(draft.trim()) }, enabled = draft.isNotBlank()) { Text(nativeString("Use model")) }
    } else {
      TextButton(onClick = { custom = true }) { Text(nativeString("Enter another model")) }
    }
    TextButton(onClick = { close() }) { Text(nativeString("Cancel")) }
  }
}
