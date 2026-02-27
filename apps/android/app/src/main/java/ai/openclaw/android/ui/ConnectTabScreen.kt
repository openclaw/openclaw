package ai.openclaw.android.ui

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
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.Error
import androidx.compose.material.icons.filled.ExpandLess
import androidx.compose.material.icons.filled.ExpandMore
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.ElevatedCard
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
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
import ai.openclaw.android.MainViewModel

private enum class ConnectInputMode {
  SetupCode,
  Manual,
}

@Composable
fun ConnectTabScreen(viewModel: MainViewModel) {
  val statusText by viewModel.statusText.collectAsState()
  val isConnected by viewModel.isConnected.collectAsState()
  val remoteAddress by viewModel.remoteAddress.collectAsState()
  val manualHost by viewModel.manualHost.collectAsState()
  val manualPort by viewModel.manualPort.collectAsState()
  val manualTls by viewModel.manualTls.collectAsState()
  val manualEnabled by viewModel.manualEnabled.collectAsState()
  val gatewayToken by viewModel.gatewayToken.collectAsState()
  val pendingTrust by viewModel.pendingGatewayTrust.collectAsState()

  var advancedOpen by rememberSaveable { mutableStateOf(false) }
  var inputMode by
    remember(manualEnabled, manualHost, gatewayToken) {
      mutableStateOf(
        if (manualEnabled || manualHost.isNotBlank() || gatewayToken.trim().isNotEmpty()) {
          ConnectInputMode.Manual
        } else {
          ConnectInputMode.SetupCode
        },
      )
    }
  var setupCode by rememberSaveable { mutableStateOf("") }
  var manualHostInput by rememberSaveable { mutableStateOf(manualHost.ifBlank { "10.0.2.2" }) }
  var manualPortInput by rememberSaveable { mutableStateOf(manualPort.toString()) }
  var manualTlsInput by rememberSaveable { mutableStateOf(manualTls) }
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
          style = MaterialTheme.typography.bodyMedium,
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

  val setupResolvedEndpoint = remember(setupCode) { decodeGatewaySetupCode(setupCode)?.url?.let { parseGatewayEndpoint(it)?.displayUrl } }
  val manualResolvedEndpoint = remember(manualHostInput, manualPortInput, manualTlsInput) {
    composeGatewayManualUrl(manualHostInput, manualPortInput, manualTlsInput)?.let { parseGatewayEndpoint(it)?.displayUrl }
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
      Text("Connection Control", style = MaterialTheme.typography.labelLarge.copy(fontWeight = FontWeight.Bold), color = MaterialTheme.colorScheme.primary)
      Text("Gateway Connection", style = MaterialTheme.typography.headlineLarge, color = MaterialTheme.colorScheme.onSurface)
      Text(
        "One primary action. Open advanced controls only when needed.",
        style = MaterialTheme.typography.bodyMedium,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
      )
    }

    ElevatedCard(
      modifier = Modifier.fillMaxWidth(),
      shape = RoundedCornerShape(16.dp),
    ) {
      Column(modifier = Modifier.padding(horizontal = 14.dp, vertical = 12.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Text("Active endpoint", style = MaterialTheme.typography.labelLarge.copy(fontWeight = FontWeight.SemiBold), color = MaterialTheme.colorScheme.onSurfaceVariant)
        Text(activeEndpoint, style = MaterialTheme.typography.bodyLarge.copy(fontFamily = FontFamily.Monospace), color = MaterialTheme.colorScheme.onSurface)
      }
    }

    ElevatedCard(
      modifier = Modifier.fillMaxWidth(),
      shape = RoundedCornerShape(16.dp),
    ) {
      Column(modifier = Modifier.padding(horizontal = 14.dp, vertical = 12.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Text("Gateway state", style = MaterialTheme.typography.labelLarge.copy(fontWeight = FontWeight.SemiBold), color = MaterialTheme.colorScheme.onSurfaceVariant)
        Text(statusText, style = MaterialTheme.typography.bodyLarge, color = MaterialTheme.colorScheme.onSurface)
      }
    }

    Button(
      onClick = {
        if (isConnected) {
          viewModel.disconnect()
          validationText = null
          return@Button
        }
        if (statusText.contains("operator offline", ignoreCase = true)) {
          validationText = null
          viewModel.refreshGatewayConnection()
          return@Button
        }

        val config =
          resolveGatewayConnectConfig(
            useSetupCode = inputMode == ConnectInputMode.SetupCode,
            setupCode = setupCode,
            manualHost = manualHostInput,
            manualPort = manualPortInput,
            manualTls = manualTlsInput,
            fallbackToken = gatewayToken,
            fallbackPassword = passwordInput,
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
        if (config.token.isNotBlank()) {
          viewModel.setGatewayToken(config.token)
        }
        viewModel.setGatewayPassword(config.password)
        viewModel.connectManual()
      },
      modifier = Modifier.fillMaxWidth().height(52.dp),
      shape = RoundedCornerShape(50),
      colors =
        ButtonDefaults.buttonColors(
          containerColor = if (isConnected) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.primary,
          contentColor = MaterialTheme.colorScheme.onPrimary,
        ),
    ) {
      Text(primaryLabel, style = MaterialTheme.typography.titleLarge.copy(fontWeight = FontWeight.Bold))
    }

    ElevatedCard(
      modifier = Modifier.fillMaxWidth(),
      shape = RoundedCornerShape(16.dp),
      onClick = { advancedOpen = !advancedOpen },
    ) {
      Row(
        modifier = Modifier.fillMaxWidth().padding(horizontal = 14.dp, vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.SpaceBetween,
      ) {
        Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
          Text("Advanced controls", style = MaterialTheme.typography.titleLarge, color = MaterialTheme.colorScheme.onSurface)
          Text("Setup code, endpoint, TLS, token, password, onboarding.", style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        Icon(
          imageVector = if (advancedOpen) Icons.Default.ExpandLess else Icons.Default.ExpandMore,
          contentDescription = if (advancedOpen) "Collapse advanced controls" else "Expand advanced controls",
          tint = MaterialTheme.colorScheme.onSurfaceVariant,
        )
      }
    }

    AnimatedVisibility(visible = advancedOpen) {
      ElevatedCard(
        modifier = Modifier.fillMaxWidth(),
        shape = RoundedCornerShape(16.dp),
      ) {
        Column(
          modifier = Modifier.fillMaxWidth().padding(horizontal = 14.dp, vertical = 14.dp),
          verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
          Text("Connection method", style = MaterialTheme.typography.labelLarge.copy(fontWeight = FontWeight.SemiBold), color = MaterialTheme.colorScheme.onSurfaceVariant)
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

          Text("Run these on the gateway host:", style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
          CommandBlock("openclaw qr --setup-code-only")
          CommandBlock("openclaw qr --json")

          if (inputMode == ConnectInputMode.SetupCode) {
            Text("Setup Code", style = MaterialTheme.typography.labelLarge.copy(fontWeight = FontWeight.SemiBold), color = MaterialTheme.colorScheme.onSurfaceVariant)
            OutlinedTextField(
              value = setupCode,
              onValueChange = {
                setupCode = it
                validationText = null
              },
              placeholder = { Text("Paste setup code", style = MaterialTheme.typography.bodyLarge, color = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.6f)) },
              modifier = Modifier.fillMaxWidth(),
              minLines = 3,
              maxLines = 5,
              keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Ascii),
              textStyle = MaterialTheme.typography.bodyLarge.copy(fontFamily = FontFamily.Monospace, color = MaterialTheme.colorScheme.onSurface),
              shape = RoundedCornerShape(16.dp),
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

            Text("Host", style = MaterialTheme.typography.labelLarge.copy(fontWeight = FontWeight.SemiBold), color = MaterialTheme.colorScheme.onSurfaceVariant)
            OutlinedTextField(
              value = manualHostInput,
              onValueChange = {
                manualHostInput = it
                validationText = null
              },
              placeholder = { Text("10.0.2.2", style = MaterialTheme.typography.bodyLarge, color = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.6f)) },
              modifier = Modifier.fillMaxWidth(),
              singleLine = true,
              keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri),
              textStyle = MaterialTheme.typography.bodyLarge.copy(color = MaterialTheme.colorScheme.onSurface),
              shape = RoundedCornerShape(16.dp),
              colors = outlinedColors(),
            )

            Text("Port", style = MaterialTheme.typography.labelLarge.copy(fontWeight = FontWeight.SemiBold), color = MaterialTheme.colorScheme.onSurfaceVariant)
            OutlinedTextField(
              value = manualPortInput,
              onValueChange = {
                manualPortInput = it
                validationText = null
              },
              placeholder = { Text("18789", style = MaterialTheme.typography.bodyLarge, color = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.6f)) },
              modifier = Modifier.fillMaxWidth(),
              singleLine = true,
              keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
              textStyle = MaterialTheme.typography.bodyLarge.copy(fontFamily = FontFamily.Monospace, color = MaterialTheme.colorScheme.onSurface),
              shape = RoundedCornerShape(16.dp),
              colors = outlinedColors(),
            )

            Row(
              modifier = Modifier.fillMaxWidth(),
              verticalAlignment = Alignment.CenterVertically,
              horizontalArrangement = Arrangement.SpaceBetween,
            ) {
              Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text("Use TLS", style = MaterialTheme.typography.titleLarge, color = MaterialTheme.colorScheme.onSurface)
                Text("Switch to secure websocket (`wss`).", style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
              }
              Switch(
                checked = manualTlsInput,
                onCheckedChange = {
                  manualTlsInput = it
                  validationText = null
                },
                colors =
                  SwitchDefaults.colors(
                    checkedTrackColor = MaterialTheme.colorScheme.primary,
                    uncheckedTrackColor = MaterialTheme.colorScheme.outlineVariant,
                    checkedThumbColor = MaterialTheme.colorScheme.onPrimary,
                    uncheckedThumbColor = MaterialTheme.colorScheme.onSurfaceVariant,
                  ),
              )
            }

            Text("Token (optional)", style = MaterialTheme.typography.labelLarge.copy(fontWeight = FontWeight.SemiBold), color = MaterialTheme.colorScheme.onSurfaceVariant)
            OutlinedTextField(
              value = gatewayToken,
              onValueChange = { viewModel.setGatewayToken(it) },
              placeholder = { Text("token", style = MaterialTheme.typography.bodyLarge, color = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.6f)) },
              modifier = Modifier.fillMaxWidth(),
              singleLine = true,
              keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Ascii),
              textStyle = MaterialTheme.typography.bodyLarge.copy(color = MaterialTheme.colorScheme.onSurface),
              shape = RoundedCornerShape(16.dp),
              colors = outlinedColors(),
            )

            Text("Password (optional)", style = MaterialTheme.typography.labelLarge.copy(fontWeight = FontWeight.SemiBold), color = MaterialTheme.colorScheme.onSurfaceVariant)
            OutlinedTextField(
              value = passwordInput,
              onValueChange = { passwordInput = it },
              placeholder = { Text("password", style = MaterialTheme.typography.bodyLarge, color = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.6f)) },
              modifier = Modifier.fillMaxWidth(),
              singleLine = true,
              keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Ascii),
              textStyle = MaterialTheme.typography.bodyLarge.copy(color = MaterialTheme.colorScheme.onSurface),
              shape = RoundedCornerShape(16.dp),
              colors = outlinedColors(),
            )

            if (!manualResolvedEndpoint.isNullOrBlank()) {
              EndpointPreview(endpoint = manualResolvedEndpoint)
            }
          }

          HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)

          FilledTonalButton(onClick = { viewModel.setOnboardingCompleted(false) }) {
            Text("Run onboarding again", style = MaterialTheme.typography.bodyMedium.copy(fontWeight = FontWeight.SemiBold))
          }
        }
      }
    }

    if (!validationText.isNullOrBlank()) {
      Text(validationText!!, style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.error)
    }
  }
}

@Composable
private fun MethodChip(label: String, active: Boolean, onClick: () -> Unit) {
  Button(
    onClick = onClick,
    modifier = Modifier.height(40.dp),
    shape = RoundedCornerShape(50),
    contentPadding = PaddingValues(horizontal = 12.dp, vertical = 8.dp),
    colors =
      ButtonDefaults.buttonColors(
        containerColor = if (active) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.surfaceContainerLow,
        contentColor = if (active) MaterialTheme.colorScheme.onPrimary else MaterialTheme.colorScheme.onSurface,
      ),
    border = BorderStroke(1.dp, if (active) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.outlineVariant),
  ) {
    Text(label, style = MaterialTheme.typography.labelLarge.copy(fontWeight = FontWeight.Bold))
  }
}

@Composable
private fun QuickFillChip(label: String, onClick: () -> Unit) {
  FilledTonalButton(
    onClick = onClick,
    shape = RoundedCornerShape(50),
    contentPadding = PaddingValues(horizontal = 12.dp, vertical = 6.dp),
  ) {
    Text(label, style = MaterialTheme.typography.labelLarge.copy(fontWeight = FontWeight.SemiBold))
  }
}

@Composable
private fun CommandBlock(command: String) {
  ElevatedCard(
    modifier = Modifier.fillMaxWidth(),
    shape = RoundedCornerShape(16.dp),
    colors = androidx.compose.material3.CardDefaults.elevatedCardColors(
      containerColor = MaterialTheme.colorScheme.surfaceContainerHighest,
    ),
  ) {
    Row(modifier = Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
      Box(modifier = Modifier.width(3.dp).height(42.dp).background(MaterialTheme.colorScheme.primary))
      Text(
        text = command,
        modifier = Modifier.padding(horizontal = 12.dp, vertical = 10.dp),
        style = MaterialTheme.typography.bodyMedium.copy(fontFamily = FontFamily.Monospace),
        color = MaterialTheme.colorScheme.onSurfaceVariant,
      )
    }
  }
}

@Composable
private fun EndpointPreview(endpoint: String) {
  Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
    HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
    Text("Resolved endpoint", style = MaterialTheme.typography.labelLarge.copy(fontWeight = FontWeight.SemiBold), color = MaterialTheme.colorScheme.onSurfaceVariant)
    Text(endpoint, style = MaterialTheme.typography.bodyMedium.copy(fontFamily = FontFamily.Monospace), color = MaterialTheme.colorScheme.onSurface)
    HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
  }
}

@Composable
private fun outlinedColors() =
  OutlinedTextFieldDefaults.colors(
    focusedContainerColor = MaterialTheme.colorScheme.surfaceContainerLow,
    unfocusedContainerColor = MaterialTheme.colorScheme.surfaceContainerLow,
    focusedBorderColor = MaterialTheme.colorScheme.primary,
    unfocusedBorderColor = MaterialTheme.colorScheme.outline,
    focusedTextColor = MaterialTheme.colorScheme.onSurface,
    unfocusedTextColor = MaterialTheme.colorScheme.onSurface,
    cursorColor = MaterialTheme.colorScheme.primary,
  )
