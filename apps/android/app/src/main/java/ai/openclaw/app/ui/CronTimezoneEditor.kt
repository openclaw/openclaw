package ai.openclaw.app.ui

import ai.openclaw.app.i18n.nativeString
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
import java.time.ZoneId

@Composable
internal fun CronTimezoneEditor(
  value: String,
  enabled: Boolean,
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

  fun select(zone: String) {
    onChange(zone)
    close()
  }
  val defaultLabel = nativeString("Gateway time zone (default)")
  Text(nativeString("Timezone"), style = ClawTheme.type.label)
  ClawSecondaryButton(
    text = value.ifBlank { defaultLabel },
    onClick = { if (open) close() else open = true },
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
  val available = remember { (listOf("UTC") + ZoneId.getAvailableZoneIds().sorted()).distinct() }
  val choices =
    (listOf(value).filter { it.isNotBlank() } + available).distinct().filter {
      it.replace('_', ' ').contains(search.replace('_', ' '), ignoreCase = true)
    }
  BackHandler { close() }
  Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
    TextButton(onClick = { select("") }) { Text(defaultLabel) }
    ClawTextField(
      value = search,
      onValueChange = { search = it },
      label = nativeString("Search time zones"),
      placeholder = nativeString("City or time zone"),
    )
    LazyColumn(Modifier.fillMaxWidth().heightIn(max = 240.dp)) {
      items(choices, key = { it }) { zone ->
        TextButton(onClick = { select(zone) }, modifier = Modifier.fillMaxWidth()) { Text(zone) }
      }
    }
    if (choices.isEmpty()) Text(nativeString("No matching time zones."), color = ClawTheme.colors.textMuted)
    if (custom) {
      ClawTextField(value = draft, onValueChange = { draft = it }, label = nativeString("Custom time zone"), placeholder = nativeString("e.g. America/New_York"))
      TextButton(onClick = { select(draft.trim()) }, enabled = draft.isNotBlank()) { Text(nativeString("Use time zone")) }
    } else {
      TextButton(onClick = { custom = true }) { Text(nativeString("Enter another time zone")) }
    }
    TextButton(onClick = { close() }) { Text(nativeString("Cancel")) }
  }
}
