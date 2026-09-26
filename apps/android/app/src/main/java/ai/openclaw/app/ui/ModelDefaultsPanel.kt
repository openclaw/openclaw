package ai.openclaw.app.ui

import ai.openclaw.app.GatewayDecisionModelSummary
import ai.openclaw.app.GatewayModelDefaults
import ai.openclaw.app.GatewayModelProviderSummary
import ai.openclaw.app.GatewayModelSettingsController
import ai.openclaw.app.GatewayModelSettingsState
import ai.openclaw.app.GatewayModelSummary
import ai.openclaw.app.chat.ChatFastMode
import ai.openclaw.app.i18n.nativeString
import ai.openclaw.app.i18n.resolveNativeText
import ai.openclaw.app.ui.design.ClawPanel
import ai.openclaw.app.ui.design.ClawSegmentedControl
import ai.openclaw.app.ui.design.ClawTextField
import ai.openclaw.app.ui.design.ClawTheme
import ai.openclaw.app.ui.design.ProviderBrandIcon
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ArrowDropDown
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp

private enum class DefaultModelRole { Primary, Utility, Decision, Fallback }

private data class DefaultModelOption(
  val value: String?,
  val label: String,
  val provider: String? = null,
  val detail: String? = null,
  val enabled: Boolean = true,
)

@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun ModelDefaultsPanel(
  controller: GatewayModelSettingsController?,
  state: GatewayModelSettingsState,
  models: List<GatewayModelSummary>,
  decisionModels: List<GatewayDecisionModelSummary>,
  automaticUtilityModel: String?,
  authProviders: List<GatewayModelProviderSummary>,
  selectionRestricted: Boolean,
  policyDefaultModel: String?,
  canEdit: Boolean,
  connected: Boolean,
) {
  var picker by remember(controller) { mutableStateOf<DefaultModelRole?>(null) }
  val saved = state.defaults ?: GatewayModelDefaults()
  val defaults = if (selectionRestricted) saved.copy(primary = policyDefaultModel.orEmpty(), fallbacks = emptyList(), utilityModel = null, decisionModel = null) else saved
  val writable = canEdit && controller != null && state.defaults != null && !state.busy
  val selected = listOfNotNull(defaults.primary, defaults.utilityModel, *defaults.fallbacks.toTypedArray()).filter(String::isNotEmpty).toSet()
  val options =
    buildList {
      models.filter { it.manualSelectionAllowed != false && (it.available != false || modelRef(it) in selected) }.forEach { model ->
        val auth = authProviders.firstOrNull { it.id == model.provider || it.authProviderId == model.provider }
        add(
          DefaultModelOption(
            modelRef(model),
            model.name,
            model.provider,
            when (auth?.authType) {
              "api_key" -> nativeString("API key")
              "oauth", "token" -> nativeString("Account")
              else -> null
            },
            model.available != false,
          ),
        )
      }
      selected.filter { ref -> none { it.value == ref } }.forEach { ref -> add(DefaultModelOption(ref, ref, enabled = false)) }
    }.distinctBy { it.value }.sortedBy { it.label.lowercase() }
  val decisions =
    decisionModels.map { DefaultModelOption("${it.provider}/${it.id}", it.name, it.provider) }.sortedBy { it.label.lowercase() }.let { entries ->
      val current = defaults.decisionModel
      if (!current.isNullOrBlank() && entries.none { it.value == current }) entries + DefaultModelOption(current, current, enabled = false) else entries
    }
  val automaticOption = options.firstOrNull { it.value == automaticUtilityModel }
  val automaticLabel = automaticUtilityModel?.let { ref -> nativeString("Auto · \$model", automaticOption?.label ?: ref) } ?: nativeString("Auto")
  val roleChoices =
    mapOf(
      DefaultModelRole.Primary to options,
      DefaultModelRole.Utility to (listOf(DefaultModelOption(null, automaticLabel, automaticOption?.provider, automaticOption?.detail), DefaultModelOption("", nativeString("Disabled"))) + options),
      DefaultModelRole.Decision to (listOf(DefaultModelOption(null, nativeString("Disabled"))) + decisions),
      DefaultModelRole.Fallback to (listOf(DefaultModelOption(null, nativeString("No fallback model"))) + options.filter { it.value != defaults.primary }),
    )
  val selectedRefs = mapOf(DefaultModelRole.Primary to defaults.primary, DefaultModelRole.Utility to defaults.utilityModel, DefaultModelRole.Decision to defaults.decisionModel, DefaultModelRole.Fallback to defaults.fallbacks.firstOrNull())

  Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
    Text(nativeString("Defaults for all agents"), modifier = Modifier.fillMaxWidth(), style = ClawTheme.type.section, color = ClawTheme.colors.text)
    Text(nativeString("Model and behavior defaults for all agents. Agent-specific settings override these defaults."), modifier = Modifier.fillMaxWidth(), style = ClawTheme.type.caption, color = ClawTheme.colors.textMuted)
    ClawPanel {
      Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
        if (state.loading && state.defaults == null) Text(nativeString("Loading model settings…"), color = ClawTheme.colors.textMuted)
        if (!connected) Text(nativeString("Connect your Gateway to load model settings."), color = ClawTheme.colors.textMuted)
        if (connected && controller == null) Text(nativeString("Model settings are unavailable on this connection."), color = ClawTheme.colors.warning)
        if (connected && !canEdit) Text(nativeString("Browsing only. Model changes require administrator access."), color = ClawTheme.colors.textMuted)
        DefaultModelRole.entries.forEach { role ->
          if (role != DefaultModelRole.Primary) HorizontalDivider(color = ClawTheme.colors.border)
          Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Text(role.label(), style = ClawTheme.type.label, color = ClawTheme.colors.text)
            if (role == DefaultModelRole.Decision) Text(nativeString("Makes typed choices, scores, and yes/no judgments. Disabled until selected; chat models are not used as a fallback."), style = ClawTheme.type.caption, color = ClawTheme.colors.textMuted)
            val option = roleChoices.getValue(role).firstOrNull { it.value == selectedRefs[role] }
            val enabled = writable && (role == DefaultModelRole.Decision || (!selectionRestricted && models.isNotEmpty())) && (role != DefaultModelRole.Fallback || defaults.primary.isNotEmpty())
            TextButton(onClick = { picker = role }, enabled = enabled, modifier = Modifier.fillMaxWidth().semantics { contentDescription = nativeString("Choose \$setting", role.label()) }) {
              Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                option?.provider?.let { ProviderBrandIcon(it, size = 20.dp) }
                Column(Modifier.weight(1f)) {
                  Text(option?.label ?: selectedRefs[role]?.takeIf(String::isNotBlank) ?: nativeString("Select a model"), style = ClawTheme.type.body)
                  option?.detail?.let { Text(it, style = ClawTheme.type.caption, color = ClawTheme.colors.textMuted) }
                }
                Icon(Icons.Default.ArrowDropDown, contentDescription = null)
              }
            }
          }
        }
        HorizontalDivider(color = ClawTheme.colors.border)
        Text(nativeString("Thinking"), style = ClawTheme.type.label, color = ClawTheme.colors.text)
        val thinkingLevels = (listOf<String?>(null, "off", "low", "medium", "high") + listOfNotNull(defaults.thinkingLevel)).distinct()
        ClawSegmentedControl(options = thinkingLevels, selected = defaults.thinkingLevel, onSelect = { controller?.setThinkingLevel(it) }, modifier = Modifier.semantics { contentDescription = nativeString("Thinking") }, enabledOptions = if (writable) thinkingLevels.toSet() else emptySet(), maxOptionsPerRow = 5, optionLabel = { level ->
          when (level) {
            null -> nativeString("Default")
            "off" -> nativeString("Off")
            "low" -> nativeString("Low")
            "medium" -> nativeString("Medium")
            "high" -> nativeString("High")
            else -> level
          }
        })
        HorizontalDivider(color = ClawTheme.colors.border)
        Text(nativeString("Fast Mode"), style = ClawTheme.type.label, color = ClawTheme.colors.text)
        val fastModes = listOf(null, ChatFastMode.Automatic, ChatFastMode.On, ChatFastMode.Off)
        ClawSegmentedControl(options = fastModes, selected = defaults.fastMode, onSelect = { controller?.setFastMode(it) }, modifier = Modifier.semantics { contentDescription = nativeString("Fast Mode") }, enabledOptions = if (writable) fastModes.toSet() else emptySet(), optionLabel = {
          when (it) {
            null -> nativeString("Default")
            ChatFastMode.Automatic -> nativeString("Auto")
            ChatFastMode.On -> nativeString("On")
            ChatFastMode.Off -> nativeString("Off")
          }
        })
        if (state.saving) Text(nativeString("Saving…"), style = ClawTheme.type.caption, color = ClawTheme.colors.textMuted)
        state.errorText?.let { Text(it.resolveNativeText(), color = ClawTheme.colors.danger) }
        state.warningText?.let { Text(it.resolveNativeText(), color = ClawTheme.colors.warning) }
        state.noticeText?.let { Text(it.resolveNativeText(), color = ClawTheme.colors.success) }
      }
    }
  }
  picker?.let { role ->
    var search by remember(role) { mutableStateOf("") }
    AppModalBottomSheet(onDismissRequest = { picker = null }, sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true), containerColor = ClawTheme.colors.surface, contentColor = ClawTheme.colors.text) {
      Column(Modifier.fillMaxWidth().padding(20.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Text(role.label(), style = ClawTheme.type.title)
        ClawTextField(value = search, onValueChange = { search = it }, placeholder = nativeString("Search models"), modifier = Modifier.fillMaxWidth(), maxLines = 1)
        val choices = roleChoices.getValue(role).filter { it.label.contains(search, ignoreCase = true) || it.value?.contains(search, ignoreCase = true) == true }
        LazyColumn(Modifier.heightIn(max = 460.dp)) {
          items(choices, key = { it.value ?: "automatic" }) { option ->
            TextButton(onClick = {
              picker = null
              when (role) {
                DefaultModelRole.Primary -> option.value?.let { controller?.setPrimaryModel(it) }
                DefaultModelRole.Utility -> controller?.setUtilityModel(option.value)
                DefaultModelRole.Decision -> controller?.setDecisionModel(option.value)
                DefaultModelRole.Fallback -> controller?.setFallbackModel(option.value)
              }
            }, enabled = writable && option.enabled, modifier = Modifier.fillMaxWidth()) {
              Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                option.provider?.let { ProviderBrandIcon(it, size = 20.dp) }
                Column(Modifier.weight(1f)) {
                  Text(option.label, style = ClawTheme.type.body)
                  option.detail?.let { Text(it, style = ClawTheme.type.caption, color = ClawTheme.colors.textMuted) }
                }
              }
            }
          }
          if (choices.isEmpty()) item { Text(nativeString("No models found"), color = ClawTheme.colors.textMuted) }
        }
      }
    }
  }
}

private fun modelRef(model: GatewayModelSummary): String = if (model.id.startsWith("${model.provider}/")) model.id else "${model.provider}/${model.id}"

private fun DefaultModelRole.label(): String =
  when (this) {
    DefaultModelRole.Primary -> nativeString("Model")
    DefaultModelRole.Utility -> nativeString("Utility Model")
    DefaultModelRole.Decision -> nativeString("Decision Model")
    DefaultModelRole.Fallback -> nativeString("Fallback Model")
  }
