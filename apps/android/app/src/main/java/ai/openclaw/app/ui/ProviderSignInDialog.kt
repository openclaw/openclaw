package ai.openclaw.app.ui

import ai.openclaw.app.ProviderAuthController
import ai.openclaw.app.i18n.nativeString
import ai.openclaw.app.i18n.resolveNativeText
import ai.openclaw.app.providerDisplayName
import ai.openclaw.app.ui.design.ClawTheme
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Checkbox
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.unit.dp
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

@Composable
internal fun ProviderSignInDialog(
  controller: ProviderAuthController,
  onDismiss: () -> Unit,
) {
  val state by controller.state.collectAsState()
  val uriHandler = LocalUriHandler.current
  var apiKeyProvider by remember(controller) { mutableStateOf<String?>(null) }
  var apiKey by remember(controller) { mutableStateOf("") }
  var search by remember(controller) { mutableStateOf("") }
  val loginOptions =
    state.loginOptions
      .filter {
        listOf("label", "groupLabel").any { field -> it[field]?.jsonPrimitive?.content?.contains(search, ignoreCase = true) == true }
      }.sortedByDescending { it["featured"]?.jsonPrimitive?.booleanOrNull == true }
  val keyProviders = state.apiKeyProviders.filter { providerDisplayName(it).contains(search, ignoreCase = true) }
  val controlsEnabled = !state.busy && !state.cancelling
  LaunchedEffect(state.apiKeySaveRevision) {
    if (state.apiKeySaveRevision > 0) {
      apiKeyProvider = null
      apiKey = ""
    }
  }
  LaunchedEffect(controller) { controller.refresh() }
  DisposableEffect(controller) { onDispose { controller.close() } }
  val step = state.wizard?.get("step")?.jsonObject
  val done =
    state.wizard
      ?.get("status")
      ?.jsonPrimitive
      ?.content == "done" &&
      state.wizard
        ?.get("done")
        ?.jsonPrimitive
        ?.booleanOrNull == true

  AlertDialog(
    onDismissRequest = onDismiss,
    title = { Text(nativeString("Sign in")) },
    text = {
      Column(Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        if (state.busy && step == null) CircularProgressIndicator()
        if (done) Text(nativeString("Sign-in complete"))
        state.noticeText?.let { Text(it.resolveNativeText()) }
        state.errorText?.let { Text(it.resolveNativeText(), color = ClawTheme.colors.warning) }
        if (!state.signInActive) {
          if (state.authStatus?.get("unavailable") == null) {
            (state.authStatus?.get("providers") as? JsonArray).orEmpty().forEach { entry ->
              val provider = entry.jsonObject
              val status =
                when (provider.getValue("status").jsonPrimitive.content) {
                  "ok", "static" -> nativeString("Credentials configured")
                  "expiring" -> nativeString("Sign-in expires soon")
                  "expired", "missing" -> nativeString("Sign-in needed")
                  else -> nativeString("Unknown")
                }
              Text(provider.getValue("displayName").jsonPrimitive.content + " · " + status)
            }
          }
          val keyProvider = apiKeyProvider
          if (keyProvider != null) {
            val keySupported = keyProvider in state.apiKeyProviders
            Text(providerDisplayName(keyProvider))
            if (!keySupported) Text(nativeString("This sign-in method is unavailable. Go back and choose another."))
            OutlinedTextField(
              value = apiKey,
              onValueChange = { apiKey = it },
              enabled = controlsEnabled && keySupported,
              label = { Text(nativeString("API key")) },
              visualTransformation = PasswordVisualTransformation(),
              keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password, autoCorrectEnabled = false),
            )
            TextButton(enabled = controlsEnabled && keySupported && apiKey.isNotBlank(), onClick = { controller.setApiKey(keyProvider, apiKey) }) { Text(nativeString("Save API key")) }
            TextButton(enabled = controlsEnabled, onClick = {
              apiKeyProvider = null
              apiKey = ""
            }) { Text(nativeString("Back")) }
          } else {
            OutlinedTextField(value = search, onValueChange = { search = it }, label = { Text(nativeString("Search")) }, singleLine = true)
            loginOptions.forEach { option ->
              TextButton(
                enabled = controlsEnabled,
                onClick = { controller.start(option.getValue("id").jsonPrimitive.content) },
              ) { Text(option.getValue("label").jsonPrimitive.content) }
            }
            keyProviders.forEach { provider ->
              TextButton(enabled = controlsEnabled, onClick = { apiKeyProvider = provider }) {
                Text(providerDisplayName(provider) + " · " + nativeString("API key"))
              }
            }
          }
          if (!state.busy && state.authStatus != null && state.authStatus?.get("unavailable") == null && state.loginOptions.isEmpty() && state.apiKeyProviders.isEmpty()) {
            Text(nativeString("No sign-in methods available. Refresh to try again."))
          }
          TextButton(enabled = controlsEnabled, onClick = { controller.refresh(refresh = true) }) { Text(nativeString("Refresh")) }
        }
        step?.let {
          it["title"]?.jsonPrimitive?.content?.let { title -> Text(title, style = ClawTheme.type.title) }
          it["message"]?.jsonPrimitive?.content?.let { message -> Text(message) }
          it["deviceCode"]?.jsonObject?.get("code")?.jsonPrimitive?.content?.let { code ->
            SelectionContainer { Text(code, style = ClawTheme.type.title) }
          }
          it["externalUrl"]?.jsonPrimitive?.content?.let { url ->
            TextButton(onClick = { uriHandler.openUri(url) }) { Text(nativeString("Open sign-in page")) }
          }
          if (it["executor"]?.jsonPrimitive?.content == "gateway") {
            CircularProgressIndicator()
          } else {
            ProviderSignInAnswer(it, enabled = controlsEnabled && !state.cancelling, onAnswer = controller::answer)
          }
        }
      }
    },
    confirmButton = { TextButton(onClick = onDismiss) { Text(nativeString("Close")) } },
    dismissButton = {
      if (state.signInActive) {
        TextButton(enabled = !state.cancelling, onClick = controller::cancel) { Text(nativeString("Cancel sign-in")) }
      }
    },
  )
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
