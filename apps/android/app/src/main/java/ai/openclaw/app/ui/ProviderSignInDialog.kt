package ai.openclaw.app.ui

import ai.openclaw.app.ProviderAuthController
import ai.openclaw.app.ProviderAuthGroup
import ai.openclaw.app.ProviderAuthLoginKind
import ai.openclaw.app.ProviderAuthSetupOption
import ai.openclaw.app.i18n.nativeString
import ai.openclaw.app.i18n.resolveNativeText
import ai.openclaw.app.i18n.verbatimText
import ai.openclaw.app.providerDisplayName
import ai.openclaw.app.ui.design.ClawPrimaryButton
import ai.openclaw.app.ui.design.ClawTheme
import ai.openclaw.app.ui.design.ProviderBrandIcon
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material3.Checkbox
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun ProviderSignInDialog(
  controller: ProviderAuthController,
  initialProviderId: String? = null,
  initialApiKeySelected: Boolean = false,
  onConnected: ((String) -> Unit)? = null,
  onDismiss: () -> Unit,
) {
  val state by controller.state.collectAsState()
  val uriHandler = LocalUriHandler.current
  var selectedProviderId by remember(controller, initialProviderId) { mutableStateOf(initialProviderId) }
  var search by remember(controller) { mutableStateOf("") }
  var apiKey by remember(controller, selectedProviderId) { mutableStateOf("") }
  var apiKeyProviderId by remember(controller, selectedProviderId) { mutableStateOf(initialProviderId?.takeIf { initialApiKeySelected }) }
  var setupOption by remember(controller, selectedProviderId) { mutableStateOf<ProviderAuthSetupOption?>(null) }
  val selectedSetup = setupOption
  val providers = state.providerGroups
  val provider = providers.firstOrNull { group -> group.id == selectedProviderId || group.providers.any { it.id == selectedProviderId } }
  val keyProvider = state.providers.firstOrNull { it.id == apiKeyProviderId && it.apiKeySupported }
  val displayName = provider?.displayName ?: selectedProviderId?.let(::providerDisplayName)
  val controlsEnabled = !state.busy && !state.cancelling
  val step =
    state.wizard
      ?.get("step")
      ?.jsonObject
      ?.takeIf { state.signInActive }

  LaunchedEffect(state.apiKeySaveRevision) {
    if (state.apiKeySaveRevision > 0) apiKey = ""
  }
  LaunchedEffect(state.connectedProviderId) {
    state.connectedProviderId?.let { connected ->
      onConnected?.invoke(connected)
      onDismiss()
    }
  }
  LaunchedEffect(controller) { controller.refresh() }
  DisposableEffect(controller) { onDispose { controller.close() } }

  AppModalBottomSheet(
    onDismissRequest = onDismiss,
    sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
    containerColor = ClawTheme.colors.surface,
    contentColor = ClawTheme.colors.text,
    modifier = Modifier.imePadding(),
  ) {
    Row(
      modifier = Modifier.fillMaxWidth().padding(start = 12.dp, end = 8.dp, bottom = 8.dp),
      verticalAlignment = Alignment.CenterVertically,
    ) {
      if (!state.signInActive && (apiKeyProviderId != null || setupOption != null || (selectedProviderId != null && initialProviderId == null))) {
        IconButton(enabled = controlsEnabled, onClick = {
          if (apiKeyProviderId != null || setupOption != null) {
            apiKeyProviderId = null
            setupOption = null
            apiKey = ""
          } else {
            selectedProviderId = null
          }
        }) {
          Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = nativeString("Back"))
        }
      }
      Text(
        if (displayName == null) nativeString("Add provider") else nativeString("Connect \$provider", displayName),
        style = ClawTheme.type.title,
        modifier = Modifier.weight(1f).padding(start = 8.dp),
      )
      if (!state.signInActive) {
        IconButton(enabled = controlsEnabled, onClick = { controller.refresh(refresh = true) }) {
          Icon(Icons.Default.Refresh, contentDescription = nativeString("Refresh"))
        }
      }
      IconButton(onClick = onDismiss) {
        Icon(Icons.Default.Close, contentDescription = nativeString("Close"))
      }
    }
    Column(
      Modifier
        .fillMaxWidth()
        .heightIn(max = 620.dp)
        .verticalScroll(rememberScrollState())
        .padding(horizontal = 20.dp)
        .padding(bottom = 28.dp),
      verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
      if (state.busy && step == null) CircularProgressIndicator()
      state.noticeText?.let { Text(it.resolveNativeText(), style = ClawTheme.type.body) }
      state.errorText?.let { Text(it.resolveNativeText(), color = ClawTheme.colors.warning, style = ClawTheme.type.body) }
      if (!state.signInActive) {
        if (selectedProviderId == null) {
          OutlinedTextField(
            value = search,
            onValueChange = { search = it },
            label = { Text(nativeString("Search \$count providers", providers.size)) },
            modifier = Modifier.fillMaxWidth(),
            singleLine = true,
          )
          val filtered =
            providers.filter { group ->
              (
                listOf(group.displayName, group.id) +
                  group.providers.flatMap { entry ->
                    listOf(entry.id, entry.displayName) + entry.loginOptions.map { it.label } + entry.setupOptions.map { it.label }
                  }
              ).any { it.contains(search, ignoreCase = true) }
            }
          filtered.forEach { entry ->
            TextButton(
              modifier = Modifier.fillMaxWidth(),
              enabled = controlsEnabled,
              onClick = { selectedProviderId = entry.id },
            ) {
              Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.CenterVertically) {
                ProviderBrandIcon(entry.id, size = 28.dp)
                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                  Text(entry.displayName, style = ClawTheme.type.label)
                  Text(providerConnectionType(entry), style = ClawTheme.type.caption, color = ClawTheme.colors.textMuted, maxLines = 2, overflow = TextOverflow.Ellipsis)
                }
              }
            }
          }
          if (!state.busy && state.authStatus != null && state.authStatus?.get("unavailable") == null && filtered.isEmpty()) {
            Text(nativeString("No providers found"), style = ClawTheme.type.body, color = ClawTheme.colors.textMuted)
          }
        } else if (provider != null) {
          if (selectedSetup != null) {
            Text(selectedSetup.label, style = ClawTheme.type.section)
            selectedSetup.hint?.let { Text(it, style = ClawTheme.type.body) }
            ProviderComputerSetup()
            Text(nativeString("Choose \$provider, then \$method.", provider.displayName, selectedSetup.label), style = ClawTheme.type.body)
          } else if (keyProvider != null) {
            OutlinedTextField(
              value = apiKey,
              onValueChange = { apiKey = it },
              enabled = controlsEnabled,
              label = { Text(nativeString("API key")) },
              modifier = Modifier.fillMaxWidth(),
              singleLine = true,
              visualTransformation = PasswordVisualTransformation(),
              keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password, autoCorrectEnabled = false),
            )
            ClawPrimaryButton(
              text = nativeString("Save and connect"),
              enabled = controlsEnabled,
              onClick = { controller.setApiKey(keyProvider.id, apiKey) },
              modifier = Modifier.fillMaxWidth(),
            )
          } else {
            Text(nativeString("Pick how you want to connect."), style = ClawTheme.type.body, color = ClawTheme.colors.textMuted)
            provider.providers.flatMap { it.loginOptions }.distinctBy { it.id }.forEach { option ->
              TextButton(
                modifier = Modifier.fillMaxWidth(),
                enabled = controlsEnabled,
                onClick = { controller.start(option.id) },
              ) {
                Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                  Text(option.label, style = ClawTheme.type.label)
                  if (option.featured) Text(nativeString("Recommended"), style = ClawTheme.type.caption, color = ClawTheme.colors.accent)
                  option.hint?.let { Text(it, style = ClawTheme.type.caption, color = ClawTheme.colors.textMuted) }
                }
              }
            }
            provider.providers.filter { it.apiKeySupported && it.loginOptions.none { option -> option.kind == ProviderAuthLoginKind.Secret } }.forEach { entry ->
              TextButton(
                modifier = Modifier.fillMaxWidth(),
                enabled = controlsEnabled,
                onClick = { apiKeyProviderId = entry.id },
              ) { Text(nativeString("\$provider API key", entry.displayName), modifier = Modifier.fillMaxWidth(), style = ClawTheme.type.label) }
            }
            provider.providers.flatMap { it.setupOptions }.distinctBy { it.id }.forEach { option ->
              TextButton(enabled = controlsEnabled, onClick = { setupOption = option }, modifier = Modifier.fillMaxWidth()) {
                Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                  Text(option.label, style = ClawTheme.type.label)
                  Text(nativeString("Set up on Gateway"), style = ClawTheme.type.caption, color = ClawTheme.colors.textMuted)
                }
              }
            }
            if (provider.providers.none { it.canSignIn || it.setupOptions.isNotEmpty() }) {
              ProviderComputerSetup()
            }
          }
        } else if (!state.busy && state.authStatus != null && state.authStatus?.get("unavailable") == null) {
          ProviderComputerSetup()
        }
      }
      step?.let {
        it["title"]?.jsonPrimitive?.content?.let { title -> Text(title, style = ClawTheme.type.section) }
        it["message"]?.jsonPrimitive?.content?.let { message -> Text(message, style = ClawTheme.type.body) }
        it["deviceCode"]?.jsonObject?.get("code")?.jsonPrimitive?.content?.let { code ->
          SelectionContainer { Text(code, style = ClawTheme.type.title) }
        }
        it["externalUrl"]?.jsonPrimitive?.content?.let { url ->
          val browserSignIn = state.activeLoginKind == ProviderAuthLoginKind.OAuth
          if (browserSignIn) {
            Text(nativeString("Finish in your browser. Come back here when you’re done."), style = ClawTheme.type.body)
          }
          ClawPrimaryButton(
            text = if (browserSignIn) nativeString("Open browser") else nativeString("Open sign-in page"),
            onClick = { uriHandler.openUri(url) },
          )
        }
        if (it["executor"]?.jsonPrimitive?.content == "gateway") {
          CircularProgressIndicator()
          Text(nativeString("Waiting for sign-in…"), style = ClawTheme.type.body, color = ClawTheme.colors.textMuted)
        } else {
          ProviderSignInAnswer(it, enabled = controlsEnabled, onAnswer = controller::answer)
        }
      }
      if (state.signInActive) {
        TextButton(enabled = !state.cancelling, onClick = controller::cancel) { Text(nativeString("Cancel sign-in")) }
      }
    }
  }
}

private fun providerConnectionType(group: ProviderAuthGroup): String =
  group.providers
    .flatMap { provider ->
      provider.loginOptions.map { it.label } + provider.setupOptions.map { it.label } +
        if (provider.apiKeySupported && provider.loginOptions.isEmpty()) listOf(nativeString("API key")) else emptyList()
    }.distinct()
    .joinToString(" · ")
    .ifEmpty { nativeString("Set up on Gateway") }

@Composable
private fun ProviderComputerSetup() {
  Text(nativeString("Run this command on the computer running your Gateway, then refresh."), style = ClawTheme.type.body)
  SelectionContainer { Text(verbatimText("openclaw configure --section model").resolveNativeText(), style = ClawTheme.type.mono) }
}

@Composable
private fun ProviderSignInAnswer(
  step: JsonObject,
  enabled: Boolean,
  onAnswer: (JsonElement?) -> Unit,
) {
  val id = step.getValue("id").jsonPrimitive.content
  var text by remember(id) { mutableStateOf(if (step["type"]?.jsonPrimitive?.content == "text") step["initialValue"]?.jsonPrimitive?.content.orEmpty() else "") }
  var selected by remember(id) { mutableStateOf((step["initialValue"] as? JsonArray)?.toSet().orEmpty()) }
  when (step.getValue("type").jsonPrimitive.content) {
    "text" -> {
      OutlinedTextField(
        value = text,
        onValueChange = { text = it },
        enabled = enabled,
        modifier = Modifier.fillMaxWidth(),
        label = { Text(step["placeholder"]?.jsonPrimitive?.content ?: nativeString("Your answer")) },
        keyboardOptions = if (step["sensitive"]?.jsonPrimitive?.booleanOrNull == true) KeyboardOptions(keyboardType = KeyboardType.Password, autoCorrectEnabled = false) else KeyboardOptions.Default,
        visualTransformation = if (step["sensitive"]?.jsonPrimitive?.booleanOrNull == true) PasswordVisualTransformation() else VisualTransformation.None,
      )
      TextButton(enabled = enabled, onClick = { onAnswer(JsonPrimitive(text)) }) { Text(nativeString("Continue")) }
    }

    "select", "multiselect" -> {
      val multiple = step.getValue("type").jsonPrimitive.content == "multiselect"
      (step["options"] as? JsonArray).orEmpty().forEach { option ->
        val choice = option.jsonObject
        val value = choice.getValue("value")
        if (multiple) {
          Row {
            Checkbox(modifier = Modifier.semantics { contentDescription = choice.getValue("label").jsonPrimitive.content }, checked = value in selected, enabled = enabled, onCheckedChange = { checked ->
              selected = if (checked) selected + value else selected - value
            })
            Text(choice.getValue("label").jsonPrimitive.content)
          }
        } else {
          TextButton(enabled = enabled, onClick = {
            onAnswer(value)
          }) {
            Column(Modifier.padding(vertical = 4.dp)) {
              Text(choice.getValue("label").jsonPrimitive.content)
              choice["hint"]?.jsonPrimitive?.content?.let { Text(it, style = ClawTheme.type.caption) }
            }
          }
        }
      }
      if (multiple) TextButton(enabled = enabled, onClick = { onAnswer(JsonArray(selected.toList())) }) { Text(nativeString("Continue")) }
    }

    "confirm" -> {
      TextButton(enabled = enabled, onClick = { onAnswer(JsonPrimitive(true)) }) { Text(nativeString("Yes")) }
      TextButton(enabled = enabled, onClick = { onAnswer(JsonPrimitive(false)) }) { Text(nativeString("No")) }
    }

    "note", "action", "progress" -> {
      TextButton(enabled = enabled, onClick = { onAnswer(null) }) { Text(nativeString("Continue")) }
    }
  }
}
