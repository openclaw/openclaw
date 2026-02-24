package ai.openclaw.android.ui

import android.util.Base64
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ExpandLess
import androidx.compose.material.icons.filled.ExpandMore
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Surface
import androidx.compose.material3.Switch
import androidx.compose.material3.SwitchDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.core.net.toUri
import ai.openclaw.android.MainViewModel
import java.util.Locale
import org.json.JSONObject

private enum class ConnectInputMode {
  SetupCode,
  Manual,
}

private data class ParsedConnectGateway(
  val host: String,
  val port: Int,
  val tls: Boolean,
  val displayUrl: String,
)

private data class ConnectSetupCodePayload(
  val url: String,
  val token: String?,
  val password: String?,
)

private data class ConnectConfig(
  val host: String,
  val port: Int,
  val tls: Boolean,
  val token: String,
  val password: String,
)

@Composable
fun ConnectTabScreen(viewModel: MainViewModel) {
  val statusText by viewModel.statusText.collectAsState()
  val isConnected by viewModel.isConnected.collectAsState()
  val remoteAddress by viewModel.remoteAddress.collectAsState()
  val manualHost by viewModel.manualHost.collectAsState()
  val manualPort by viewModel.manualPort.collectAsState()
  val manualTls by viewModel.manualTls.collectAsState()
  val gatewayToken by viewModel.gatewayToken.collectAsState()
  val pendingTrust by viewModel.pendingGatewayTrust.collectAsState()

  var advancedOpen by rememberSaveable { mutableStateOf(false) }
  var inputMode by rememberSaveable { mutableStateOf(ConnectInputMode.SetupCode) }
  var setupCode by rememberSaveable { mutableStateOf("") }
  var manualHostInput by rememberSaveable { mutableStateOf(manualHost.ifBlank { "10.0.2.2" }) }
  var manualPortInput by rememberSaveable { mutableStateOf(manualPort.toString()) }
  var manualTlsInput by rememberSaveable { mutableStateOf(manualTls) }
  var tokenInput by rememberSaveable { mutableStateOf(gatewayToken) }
  var passwordInput by rememberSaveable { mutableStateOf("") }
  var validationText by rememberSaveable { mutableStateOf<String?>(null) }

  if (pendingTrust != null) {
    val prompt = pendingTrust!!
    AlertDialog(
      onDismissRequest = { viewModel.declineGatewayTrustPrompt() },
      title = { Text("Trust this gateway?") },
      text = {
        Text(
          "First-time TLS connection.\n\nVerify this SHA-256 fingerprint before trusting:\n${prompt.fingerprintSha256}",
          style = mobileCallout,
        )
      },
      confirmButton = {
        TextButton(onClick = { viewModel.acceptGatewayTrustPrompt() }) {
          Text("Trust and continue")
        }
      },
      dismissButton = {
        TextButton(onClick = { viewModel.declineGatewayTrustPrompt() }) {
          Text("Cancel")
        }
      },
    )
  }

  val setupResolvedEndpoint = remember(setupCode) { decodeConnectSetupCode(setupCode)?.url?.let { parseConnectGateway(it)?.displayUrl } }
  val manualResolvedEndpoint = remember(manualHostInput, manualPortInput, manualTlsInput) {
    composeConnectManualGatewayUrl(manualHostInput, manualPortInput, manualTlsInput)?.let { parseConnectGateway(it)?.displayUrl }
  }

  val activeEndpoint =
    remember(isConnected, remoteAddress, setupResolvedEndpoint, manualResolvedEndpoint, inputMode) {
      when {
        isConnected && !remoteAddress.isNullOrBlank() -> remoteAddress!!
        inputMode == ConnectInputMode.SetupCode -> setupResolvedEndpoint ?: "Not set"
        else -> manualResolvedEndpoint ?: "Not set"
      }
    }

  val primaryLabel = if (isConnected) "Disconnect Gateway" else "Connect Gateway"

  Column(
    modifier = Modifier.verticalScroll(rememberScrollState()).padding(horizontal = 20.dp, vertical = 16.dp),
    verticalArrangement = Arrangement.spacedBy(14.dp),
  ) {
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
      Text("Connection Control", style = mobileCaption1.copy(fontWeight = FontWeight.Bold), color = mobileAccent)
      Text("Gateway Connection", style = mobileTitle1, color = mobileText)
      Text(
        "One primary action. Open advanced controls only when needed.",
        style = mobileCallout,
        color = mobileTextSecondary,
      )
    }

    Surface(
      modifier = Modifier.fillMaxWidth(),
      shape = RoundedCornerShape(14.dp),
      color = mobileSurface,
      border = BorderStroke(1.dp, mobileBorder),
    ) {
      Column(modifier = Modifier.padding(horizontal = 14.dp, vertical = 12.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Text("Active endpoint", style = mobileCaption1.copy(fontWeight = FontWeight.SemiBold), color = mobileTextSecondary)
        Text(activeEndpoint, style = mobileBody.copy(fontFamily = FontFamily.Monospace), color = mobileText)
      }
    }

    Surface(
      modifier = Modifier.fillMaxWidth(),
      shape = RoundedCornerShape(14.dp),
      color = mobileSurface,
      border = BorderStroke(1.dp, mobileBorder),
    ) {
      Column(modifier = Modifier.padding(horizontal = 14.dp, vertical = 12.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Text("Gateway state", style = mobileCaption1.copy(fontWeight = FontWeight.SemiBold), color = mobileTextSecondary)
        Text(statusText, style = mobileBody, color = mobileText)
      }
    }

    Button(
      onClick = {
        if (isConnected) {
          viewModel.disconnect()
          validationText = null
          return@Button
        }

        val config =
          resolveConnectConfig(
            mode = inputMode,
            setupCode = setupCode,
            manualHost = manualHostInput,
            manualPort = manualPortInput,
            manualTls = manualTlsInput,
            token = tokenInput,
            password = passwordInput,
          )

        if (config == null) {
          validationText =
            if (inputMode == ConnectInputMode.SetupCode) {
              "Paste a valid setup code to connect."
            } else {
              "Enter a valid manual host and port to connect."
            }
          return@Button
        }

        validationText = null
        viewModel.setManualEnabled(true)
        viewModel.setManualHost(config.host)
        viewModel.setManualPort(config.port)
        viewModel.setManualTls(config.tls)
        viewModel.setGatewayToken(config.token)
        viewModel.setGatewayPassword(config.password)
        viewModel.connectManual()
      },
      modifier = Modifier.fillMaxWidth().height(52.dp),
      shape = RoundedCornerShape(14.dp),
      colors =
        ButtonDefaults.buttonColors(
          containerColor = if (isConnected) mobileDanger else mobileAccent,
          contentColor = Color.White,
        ),
    ) {
      Text(primaryLabel, style = mobileHeadline.copy(fontWeight = FontWeight.Bold))
    }

    Surface(
      modifier = Modifier.fillMaxWidth(),
      shape = RoundedCornerShape(14.dp),
      color = mobileSurface,
      border = BorderStroke(1.dp, mobileBorder),
      onClick = { advancedOpen = !advancedOpen },
    ) {
      Row(
        modifier = Modifier.fillMaxWidth().padding(horizontal = 14.dp, vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.SpaceBetween,
      ) {
        Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
          Text("Advanced controls", style = mobileHeadline, color = mobileText)
          Text("Setup code, endpoint, TLS, token, password, onboarding.", style = mobileCaption1, color = mobileTextSecondary)
        }
        Icon(
          imageVector = if (advancedOpen) Icons.Default.ExpandLess else Icons.Default.ExpandMore,
          contentDescription = if (advancedOpen) "Collapse advanced controls" else "Expand advanced controls",
          tint = mobileTextSecondary,
        )
      }
    }

    AnimatedVisibility(visible = advancedOpen) {
      Surface(
        modifier = Modifier.fillMaxWidth(),
        shape = RoundedCornerShape(14.dp),
        color = Color.White,
        border = BorderStroke(1.dp, mobileBorder),
      ) {
        Column(
          modifier = Modifier.fillMaxWidth().padding(horizontal = 14.dp, vertical = 14.dp),
          verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
          Text("Connection method", style = mobileCaption1.copy(fontWeight = FontWeight.SemiBold), color = mobileTextSecondary)
          Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            MethodChip(
              label = "Setup Code",
              active = inputMode == ConnectInputMode.SetupCode,
              onClick = { inputMode = ConnectInputMode.SetupCode },
            )
            MethodChip(
              label = "Manual",
              active = inputMode == ConnectInputMode.Manual,
              onClick = { inputMode = ConnectInputMode.Manual },
            )
          }

          Text("Run these on the gateway host:", style = mobileCallout, color = mobileTextSecondary)
          CommandBlock("openclaw qr --setup-code-only")
          CommandBlock("openclaw qr --json")

          if (inputMode == ConnectInputMode.SetupCode) {
            Text("Setup Code", style = mobileCaption1.copy(fontWeight = FontWeight.SemiBold), color = mobileTextSecondary)
            OutlinedTextField(
              value = setupCode,
              onValueChange = {
                setupCode = it
                validationText = null
              },
              placeholder = { Text("Paste setup code", style = mobileBody, color = mobileTextTertiary) },
              modifier = Modifier.fillMaxWidth(),
              minLines = 3,
              maxLines = 5,
              keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Ascii),
              textStyle = mobileBody.copy(fontFamily = FontFamily.Monospace, color = mobileText),
              shape = RoundedCornerShape(14.dp),
              colors = outlinedColors(),
            )
            if (!setupResolvedEndpoint.isNullOrBlank()) {
              EndpointPreview(endpoint = setupResolvedEndpoint)
            }
          } else {
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
              QuickFillChip(
                label = "Android Emulator",
                onClick = {
                  manualHostInput = "10.0.2.2"
                  manualPortInput = "18789"
                  manualTlsInput = false
                  validationText = null
                },
              )
              QuickFillChip(
                label = "Localhost",
                onClick = {
                  manualHostInput = "127.0.0.1"
                  manualPortInput = "18789"
                  manualTlsInput = false
                  validationText = null
                },
              )
            }

            Text("Host", style = mobileCaption1.copy(fontWeight = FontWeight.SemiBold), color = mobileTextSecondary)
            OutlinedTextField(
              value = manualHostInput,
              onValueChange = {
                manualHostInput = it
                validationText = null
              },
              placeholder = { Text("10.0.2.2", style = mobileBody, color = mobileTextTertiary) },
              modifier = Modifier.fillMaxWidth(),
              singleLine = true,
              keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri),
              textStyle = mobileBody.copy(color = mobileText),
              shape = RoundedCornerShape(14.dp),
              colors = outlinedColors(),
            )

            Text("Port", style = mobileCaption1.copy(fontWeight = FontWeight.SemiBold), color = mobileTextSecondary)
            OutlinedTextField(
              value = manualPortInput,
              onValueChange = {
                manualPortInput = it
                validationText = null
              },
              placeholder = { Text("18789", style = mobileBody, color = mobileTextTertiary) },
              modifier = Modifier.fillMaxWidth(),
              singleLine = true,
              keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
              textStyle = mobileBody.copy(fontFamily = FontFamily.Monospace, color = mobileText),
              shape = RoundedCornerShape(14.dp),
              colors = outlinedColors(),
            )

            Row(
              modifier = Modifier.fillMaxWidth(),
              verticalAlignment = Alignment.CenterVertically,
              horizontalArrangement = Arrangement.SpaceBetween,
            ) {
              Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text("Use TLS", style = mobileHeadline, color = mobileText)
                Text("Switch to secure websocket (`wss`).", style = mobileCallout, color = mobileTextSecondary)
              }
              Switch(
                checked = manualTlsInput,
                onCheckedChange = {
                  manualTlsInput = it
                  validationText = null
                },
                colors =
                  SwitchDefaults.colors(
                    checkedTrackColor = mobileAccent,
                    uncheckedTrackColor = mobileBorderStrong,
                    checkedThumbColor = Color.White,
                    uncheckedThumbColor = Color.White,
                  ),
              )
            }

            Text("Token (optional)", style = mobileCaption1.copy(fontWeight = FontWeight.SemiBold), color = mobileTextSecondary)
            OutlinedTextField(
              value = tokenInput,
              onValueChange = { tokenInput = it },
              placeholder = { Text("token", style = mobileBody, color = mobileTextTertiary) },
              modifier = Modifier.fillMaxWidth(),
              singleLine = true,
              keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Ascii),
              textStyle = mobileBody.copy(color = mobileText),
              shape = RoundedCornerShape(14.dp),
              colors = outlinedColors(),
            )

            Text("Password (optional)", style = mobileCaption1.copy(fontWeight = FontWeight.SemiBold), color = mobileTextSecondary)
            OutlinedTextField(
              value = passwordInput,
              onValueChange = { passwordInput = it },
              placeholder = { Text("password", style = mobileBody, color = mobileTextTertiary) },
              modifier = Modifier.fillMaxWidth(),
              singleLine = true,
              keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Ascii),
              textStyle = mobileBody.copy(color = mobileText),
              shape = RoundedCornerShape(14.dp),
              colors = outlinedColors(),
            )

            if (!manualResolvedEndpoint.isNullOrBlank()) {
              EndpointPreview(endpoint = manualResolvedEndpoint)
            }
          }

          HorizontalDivider(color = mobileBorder)

          TextButton(onClick = { viewModel.setOnboardingCompleted(false) }) {
            Text("Run onboarding again", style = mobileCallout.copy(fontWeight = FontWeight.SemiBold), color = mobileAccent)
          }
        }
      }
    }

    if (!validationText.isNullOrBlank()) {
      Text(validationText!!, style = mobileCaption1, color = mobileWarning)
    }
  }
}

@Composable
private fun MethodChip(label: String, active: Boolean, onClick: () -> Unit) {
  Button(
    onClick = onClick,
    modifier = Modifier.height(40.dp),
    shape = RoundedCornerShape(12.dp),
    contentPadding = PaddingValues(horizontal = 12.dp, vertical = 8.dp),
    colors =
      ButtonDefaults.buttonColors(
        containerColor = if (active) mobileAccent else mobileSurface,
        contentColor = if (active) Color.White else mobileText,
      ),
    border = BorderStroke(1.dp, if (active) Color(0xFF184DAF) else mobileBorderStrong),
  ) {
    Text(label, style = mobileCaption1.copy(fontWeight = FontWeight.Bold))
  }
}

@Composable
private fun QuickFillChip(label: String, onClick: () -> Unit) {
  Button(
    onClick = onClick,
    shape = RoundedCornerShape(999.dp),
    contentPadding = PaddingValues(horizontal = 12.dp, vertical = 6.dp),
    colors =
      ButtonDefaults.buttonColors(
        containerColor = mobileAccentSoft,
        contentColor = mobileAccent,
      ),
    elevation = null,
  ) {
    Text(label, style = mobileCaption1.copy(fontWeight = FontWeight.SemiBold))
  }
}

@Composable
private fun CommandBlock(command: String) {
  Surface(
    modifier = Modifier.fillMaxWidth(),
    shape = RoundedCornerShape(12.dp),
    color = mobileCodeBg,
    border = BorderStroke(1.dp, Color(0xFF2B2E35)),
  ) {
    Row(modifier = Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
      Box(modifier = Modifier.width(3.dp).height(42.dp).background(Color(0xFF3FC97A)))
      Text(
        text = command,
        modifier = Modifier.padding(horizontal = 12.dp, vertical = 10.dp),
        style = mobileCallout.copy(fontFamily = FontFamily.Monospace),
        color = mobileCodeText,
      )
    }
  }
}

@Composable
private fun EndpointPreview(endpoint: String) {
  Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
    HorizontalDivider(color = mobileBorder)
    Text("Resolved endpoint", style = mobileCaption1.copy(fontWeight = FontWeight.SemiBold), color = mobileTextSecondary)
    Text(endpoint, style = mobileCallout.copy(fontFamily = FontFamily.Monospace), color = mobileText)
    HorizontalDivider(color = mobileBorder)
  }
}

@Composable
private fun outlinedColors() =
  OutlinedTextFieldDefaults.colors(
    focusedContainerColor = mobileSurface,
    unfocusedContainerColor = mobileSurface,
    focusedBorderColor = mobileAccent,
    unfocusedBorderColor = mobileBorder,
    focusedTextColor = mobileText,
    unfocusedTextColor = mobileText,
    cursorColor = mobileAccent,
  )

private fun resolveConnectConfig(
  mode: ConnectInputMode,
  setupCode: String,
  manualHost: String,
  manualPort: String,
  manualTls: Boolean,
  token: String,
  password: String,
): ConnectConfig? {
  return if (mode == ConnectInputMode.SetupCode) {
    val setup = decodeConnectSetupCode(setupCode) ?: return null
    val parsed = parseConnectGateway(setup.url) ?: return null
    ConnectConfig(
      host = parsed.host,
      port = parsed.port,
      tls = parsed.tls,
      token = setup.token ?: token.trim(),
      password = setup.password ?: password.trim(),
    )
  } else {
    val manualUrl = composeConnectManualGatewayUrl(manualHost, manualPort, manualTls) ?: return null
    val parsed = parseConnectGateway(manualUrl) ?: return null
    ConnectConfig(
      host = parsed.host,
      port = parsed.port,
      tls = parsed.tls,
      token = token.trim(),
      password = password.trim(),
    )
  }
}

private fun parseConnectGateway(rawInput: String): ParsedConnectGateway? {
  val raw = rawInput.trim()
  if (raw.isEmpty()) return null

  val normalized = if (raw.contains("://")) raw else "https://$raw"
  val uri = normalized.toUri()
  val host = uri.host?.trim().orEmpty()
  if (host.isEmpty()) return null

  val scheme = uri.scheme?.trim()?.lowercase(Locale.US).orEmpty()
  val tls =
    when (scheme) {
      "ws", "http" -> false
      "wss", "https" -> true
      else -> true
    }
  val port = uri.port.takeIf { it in 1..65535 } ?: 18789
  val displayUrl = "${if (tls) "https" else "http"}://$host:$port"

  return ParsedConnectGateway(host = host, port = port, tls = tls, displayUrl = displayUrl)
}

private fun decodeConnectSetupCode(rawInput: String): ConnectSetupCodePayload? {
  val trimmed = rawInput.trim()
  if (trimmed.isEmpty()) return null

  val padded =
    trimmed
      .replace('-', '+')
      .replace('_', '/')
      .let { normalized ->
        val remainder = normalized.length % 4
        if (remainder == 0) normalized else normalized + "=".repeat(4 - remainder)
      }

  return try {
    val decoded = String(Base64.decode(padded, Base64.DEFAULT), Charsets.UTF_8)
    val obj = JSONObject(decoded)
    val url = obj.optString("url").trim()
    if (url.isEmpty()) return null
    val token = obj.optString("token").trim().ifEmpty { null }
    val password = obj.optString("password").trim().ifEmpty { null }
    ConnectSetupCodePayload(url = url, token = token, password = password)
  } catch (_: Throwable) {
    null
  }
}

private fun composeConnectManualGatewayUrl(hostInput: String, portInput: String, tls: Boolean): String? {
  val host = hostInput.trim()
  val port = portInput.trim().toIntOrNull() ?: return null
  if (host.isEmpty() || port !in 1..65535) return null
  val scheme = if (tls) "https" else "http"
  return "$scheme://$host:$port"
}
