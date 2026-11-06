package ai.openclaw.app.ui

import ai.openclaw.app.gateway.OpenClawIdEnrollmentUiState
import ai.openclaw.app.i18n.nativeString
import ai.openclaw.app.ui.design.ClawPrimaryButton
import ai.openclaw.app.ui.design.ClawTextField
import ai.openclaw.app.ui.design.ClawTheme
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp

/** Explicit invitation confirmation; the runtime alone validates inputs and owns enrollment. */
@Composable
internal fun OpenClawIdEnrollmentDialog(
  nodeJoinLink: String?,
  state: OpenClawIdEnrollmentUiState,
  onConfirm: (String, String) -> Unit,
  onDismiss: () -> Unit,
  onComplete: () -> Unit,
) {
  // No default origin or saveable invitation. Opening this dialog has no enrollment effects.
  var discoveryOrigin by remember(nodeJoinLink) { mutableStateOf("") }
  var submitted by remember(nodeJoinLink) { mutableStateOf(false) }
  val dismiss = if (state.admitted) onComplete else onDismiss
  FoldAwareDialog(
    onDismissRequest = dismiss,
    title = nativeString("Connect as node with OpenClaw ID (experimental)"),
  ) {
    Surface(
      modifier = Modifier.fillMaxWidth().testTag("openclaw-id-enrollment"),
      shape = RoundedCornerShape(ClawTheme.radii.sheet),
      color = ClawTheme.colors.surface,
      contentColor = ClawTheme.colors.text,
    ) {
      Column(
        modifier = Modifier.heightIn(max = 680.dp).verticalScroll(rememberScrollState()).padding(20.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
      ) {
        Text(nativeString("Connect as node with OpenClaw ID (experimental)"), style = ClawTheme.type.title)
        Text(nativeString("Node connection only; this does not enable chat."), style = ClawTheme.type.body)
        state.hostname?.let { Text(it, style = ClawTheme.type.section) }
        if (nodeJoinLink != null && !submitted && !state.waiting && !state.admitted && state.error == null) {
          Text(nativeString("Enter the Discovery HTTPS origin supplied by your gateway owner. It is separate from the invitation link."))
          ClawTextField(
            value = discoveryOrigin,
            onValueChange = { discoveryOrigin = it },
            placeholder = "https://",
            label = nativeString("Discovery HTTPS origin (required)"),
            maxLines = 1,
            modifier = Modifier.testTag("openclaw-id-discovery-origin"),
          )
          Text(nativeString("Confirm to request node access. Your gateway owner must compare the verification code and approve the commands and capabilities."))
          ClawPrimaryButton(
            text = nativeString("Confirm node enrollment"),
            enabled = discoveryOrigin.isNotBlank(),
            onClick = {
              submitted = true
              onConfirm(nodeJoinLink, discoveryOrigin.trim())
            },
            modifier = Modifier.fillMaxWidth().testTag("openclaw-id-enrollment-confirm"),
          )
        }
        // Render only runtime-produced public facts; never display or parse the secret link.
        state.verificationCode?.let { code ->
          Text(nativeString("Verification code"), style = ClawTheme.type.section)
          Text(
            code.chunked(3).joinToString("-"),
            style = ClawTheme.type.title.copy(fontFamily = FontFamily.Monospace),
            modifier = Modifier.testTag("openclaw-id-verification-code"),
          )
          Text(nativeString("Compare this code with the gateway owner's browser before approval."))
          EnrollmentManifest(label = nativeString("Commands"), values = state.commands)
          EnrollmentManifest(label = nativeString("Capabilities"), values = state.capabilities)
        }
        when {
          state.admitted -> {
            Text(nativeString("Node enrollment complete."), style = ClawTheme.type.section)
            Text(nativeString("Node access was admitted. Chat remains disconnected."))
            ClawPrimaryButton(text = nativeString("Done"), onClick = onComplete, modifier = Modifier.fillMaxWidth())
          }

          state.error != null -> {
            Text(state.error, color = ClawTheme.colors.warning, modifier = Modifier.testTag("openclaw-id-enrollment-error"))
            Text(nativeString("Cancel to return to setup and check the invitation and Discovery origin with your gateway owner."))
          }

          state.waiting || submitted -> {
            CircularProgressIndicator()
            Text(
              if (state.verificationCode == null) nativeString("Preparing node enrollment…") else nativeString("Waiting for gateway owner approval…"),
            )
          }
        }
        if (!state.admitted) {
          TextButton(onClick = onDismiss, modifier = Modifier.fillMaxWidth()) { Text(nativeString("Cancel")) }
        }
      }
    }
  }
}

/** Show the exact frozen runtime declaration, including an explicitly empty surface. */
@Composable
private fun EnrollmentManifest(
  label: String,
  values: List<String>,
) {
  Text(label, style = ClawTheme.type.section)
  Text(if (values.isEmpty()) nativeString("None") else values.joinToString("\n"), style = ClawTheme.type.body)
}
