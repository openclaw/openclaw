package ai.openclaw.app.ui

import ai.openclaw.app.gateway.GatewayEndpoint
import ai.openclaw.app.gateway.GatewayProxyCredentials
import ai.openclaw.app.gateway.GatewayProxyPrincipal
import ai.openclaw.app.gateway.formatGatewayAuthority
import ai.openclaw.app.i18n.nativeString
import ai.openclaw.app.ui.design.ClawPrimaryButton
import ai.openclaw.app.ui.design.ClawTextField
import ai.openclaw.app.ui.design.ClawTheme
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.foundation.text.KeyboardOptions
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
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp

internal fun gatewayProxyDestination(endpoint: GatewayEndpoint): String = "${if (endpoint.tlsEnabled) "https" else "http"}://${formatGatewayAuthority(endpoint.host, endpoint.port)}${endpoint.contextPath}"

internal fun gatewayProxyAccountLockedMessage(): String = nativeString("To use a different proxy account, forget this Gateway and add it again.")

/** One staged form shared by onboarding, addition, and saved Gateway editing. */
@Composable
internal fun GatewayProxyAuthentication(
  endpoint: GatewayEndpoint,
  principal: GatewayProxyPrincipal?,
  action: GatewayProxyAuthAction,
  onAction: (GatewayProxyAuthAction) -> Unit,
  savedConfigured: Boolean,
  saveLabel: String = nativeString("Continue"),
) {
  var editing by remember(endpoint) { mutableStateOf(false) }
  val username = (action as? GatewayProxyAuthAction.Save)?.credentials?.username ?: principal?.username
  val configured = action is GatewayProxyAuthAction.Save || (action == GatewayProxyAuthAction.Keep && savedConfigured)
  Text(nativeString("Proxy authentication"), style = ClawTheme.type.section)
  Text(nativeString("Separate from your Gateway token, password, and pairing."), style = ClawTheme.type.caption)
  var basicSelected by remember(endpoint, configured) { mutableStateOf(configured) }
  val destinationSupported =
    remember(endpoint) {
      runCatching {
        ai.openclaw.app.gateway
          .gatewayProxyDestination(endpoint)
      }.isSuccess
    }
  Column(Modifier.selectableGroup()) {
    for (basic in listOf(false, true)) {
      Row(
        Modifier.fillMaxWidth().heightIn(min = 48.dp).selectable(
          selected = basicSelected == basic,
          enabled = !basic || destinationSupported,
          role = Role.RadioButton,
          onClick = {
            basicSelected = basic
            if (basic) editing = true else onAction(GatewayProxyAuthAction.Remove)
          },
        ),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
      ) {
        RadioButton(selected = basicSelected == basic, onClick = null, enabled = !basic || destinationSupported)
        Text(if (basic) nativeString("HTTP Basic") else nativeString("None"), style = ClawTheme.type.body)
      }
    }
  }
  if (basicSelected) {
    TextButton(onClick = { editing = true }, enabled = destinationSupported) {
      Text(if (!configured) nativeString("Configure") else nativeString("Edit"))
    }
  }
  if (!destinationSupported) {
    Text(nativeString("HTTP Basic requires a verified HTTPS connection."), style = ClawTheme.type.caption)
  }
  if (editing) {
    GatewayProxyCredentialDialog(
      endpoint = endpoint,
      username = username.orEmpty(),
      configured = configured,
      saveLabel = saveLabel,
      usernameLocked = principal?.locked == true,
      onCancel = {
        editing = false
        basicSelected = configured
      },
      onSave = { credentials ->
        onAction(GatewayProxyAuthAction.Save(credentials))
        editing = false
      },
      onRemove = {
        onAction(GatewayProxyAuthAction.Remove)
        editing = false
      },
    )
  }
}

@Composable
internal fun GatewayProxyCredentialDialog(
  endpoint: GatewayEndpoint,
  username: String,
  configured: Boolean,
  onCancel: () -> Unit,
  onSave: (GatewayProxyCredentials) -> Unit,
  onRemove: () -> Unit,
  saveLabel: String = nativeString("Continue"),
  saving: Boolean = false,
  error: String? = null,
  usernameLocked: Boolean = false,
) {
  // Draft secrets deliberately never enter saved instance state or read back stored passwords.
  var usernameInput by remember(endpoint) { mutableStateOf(username) }
  var passwordInput by remember(endpoint) { mutableStateOf("") }
  val destinationSupported =
    remember(endpoint) {
      runCatching {
        ai.openclaw.app.gateway
          .gatewayProxyDestination(endpoint)
      }.isSuccess
    }
  FoldAwarePrompt(
    onDismissRequest = { if (!saving) onCancel() },
    title = nativeString("Proxy login"),
    text = {
      Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
        ProxyLobsterMascot()
        Text(gatewayProxyDestination(endpoint), style = ClawTheme.type.body, modifier = Modifier.testTag("proxy-destination"))
        Text(nativeString("These credentials authenticate to the HTTPS proxy. Gateway permissions and pairing still apply."), style = ClawTheme.type.caption)
        ClawTextField(value = usernameInput, onValueChange = { usernameInput = it }, label = nativeString("Username"), placeholder = "", modifier = Modifier.testTag("proxy-username"), enabled = !saving && !usernameLocked, maxLines = 1, keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Text, autoCorrectEnabled = false))
        if (usernameLocked) Text(gatewayProxyAccountLockedMessage(), style = ClawTheme.type.caption)
        ClawTextField(value = passwordInput, onValueChange = { passwordInput = it }, label = if (configured) nativeString("Replacement password") else nativeString("Password"), placeholder = "", secret = true, modifier = Modifier.testTag("proxy-password"), enabled = !saving, maxLines = 1)
        if (!destinationSupported) {
          Text(nativeString("HTTP Basic requires a verified HTTPS connection."), style = ClawTheme.type.caption, color = ClawTheme.colors.warning)
        }
        error?.let { Text(it, style = ClawTheme.type.caption, color = ClawTheme.colors.warning) }
        ClawPrimaryButton(
          text = saveLabel,
          enabled = !saving && destinationSupported && usernameInput.isNotBlank() && ':' !in usernameInput && passwordInput.isNotEmpty() && (usernameInput + passwordInput).none { it.code < 0x20 || it.code == 0x7f },
          onClick = { onSave(GatewayProxyCredentials(usernameInput, passwordInput)) },
          modifier = Modifier.fillMaxWidth().testTag("proxy-save"),
        )
      }
    },
    actions = {
      if (configured) TextButton(enabled = !saving, onClick = onRemove) { Text(nativeString("Remove")) }
      TextButton(enabled = !saving, onClick = onCancel) { Text(nativeString("Cancel")) }
    },
  )
}
