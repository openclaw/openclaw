package ai.openclaw.app.ui

import ai.openclaw.app.MainViewModel
import ai.openclaw.app.gateway.GatewayCustomHeaders
import ai.openclaw.app.i18n.nativeString
import ai.openclaw.app.ui.design.ClawPlainIconButton
import ai.openclaw.app.ui.design.ClawSecondaryButton
import ai.openclaw.app.ui.design.ClawTextField
import ai.openclaw.app.ui.design.ClawTheme
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.Stable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp

private const val CLIENT_ID_HEADER = "CF-Access-Client-Id"

/**
 * Proxy headers typed into one manual-connect form, such as Cloudflare Access service tokens.
 * Values are credentials: hosts keep this in plain `remember`, never saved instance state, and
 * values are never shown again. The form owns it so a typed but unadded header still connects.
 */
@Stable
internal class GatewayCustomHeadersInput {
  var headers by mutableStateOf(emptyMap<String, String>())
    private set
  var name by mutableStateOf("")
  var value by mutableStateOf("")

  // Rows a connect saved, and the address it saved them under.
  private var savedRows by mutableStateOf<Pair<String, Map<String, String>>?>(null)

  val rejection: GatewayCustomHeaders.Rejection?
    get() = if (name.isBlank()) null else GatewayCustomHeaders.rejection(name, value)

  /** A credential typed as the name. It blocks Add and connecting so it is never saved as a name. */
  val credentialShape: GatewayCustomHeaders.CredentialShape?
    get() = if (name.isBlank()) null else GatewayCustomHeaders.credentialShape(name)

  val blocksConnect: Boolean
    get() = credentialShape != null

  val canAdd: Boolean
    get() = name.isNotBlank() && value.isNotBlank() && rejection == null && credentialShape == null

  fun add() {
    if (!canAdd) return
    val trimmed = name.trim()
    // Header names are case-insensitive; adding one again replaces its value.
    headers = headers.filterKeys { !it.equals(trimmed, ignoreCase = true) } + (trimmed to value)
    // An explicit add is always sent, even if the same value was saved and removed since.
    savedRows = savedRows?.let { (to, rows) -> to to rows.filterKeys { !it.equals(trimmed, ignoreCase = true) } }
    name = ""
    value = ""
  }

  fun remove(headerName: String) {
    headers = headers - headerName
  }

  fun clear() {
    headers = emptyMap()
    savedRows = null
    name = ""
    value = ""
  }

  /**
   * Rows still to send to [stableId]. Rows already saved there are listed with its saved headers
   * instead; after the address changes they apply again, so a corrected address keeps them.
   */
  fun rowsFor(stableId: String?): Map<String, String> {
    val (savedTo, saved) = savedRows ?: return headers
    if (savedTo != stableId) return headers
    return headers.filter { (headerName, headerValue) -> saved[headerName] != headerValue }
  }

  /** Headers to connect to [stableId] with, including a complete draft the user did not add yet. */
  fun forConnect(stableId: String?): Map<String, String> {
    add()
    return rowsFor(stableId)
  }

  fun markSaved(
    stableId: String,
    saved: Map<String, String>,
  ) {
    // A later connect to the same address sends only changed rows; earlier ones stay saved there.
    val earlier = savedRows?.takeIf { it.first == stableId }?.second.orEmpty()
    savedRows = stableId to (earlier + saved)
  }
}

/** Header names saved for the address in the form; values never reach the UI. */
internal class GatewaySavedCustomHeaders(
  val stableId: String,
  val displayUrl: String,
  val names: List<String>,
  val onRemove: (String) -> Unit,
)

/** Saved names for [target], reloaded when headers change; null while loading or without a secure target. */
@Composable
internal fun rememberSavedCustomHeaders(
  viewModel: MainViewModel,
  target: GatewayHeaderTarget?,
): GatewaySavedCustomHeaders? {
  val revision by viewModel.customHeadersRevision.collectAsState()
  val loaded by produceState<Pair<String, List<String>>?>(null, target?.stableId, revision) {
    value = target?.let { it.stableId to viewModel.gatewayCustomHeaderNames(it.stableId) }
  }
  val current = target ?: return null
  // Names loaded for an address the user has since edited never pair with the new address.
  val names = loaded?.takeIf { it.first == current.stableId }?.second ?: return null
  return GatewaySavedCustomHeaders(stableId = current.stableId, displayUrl = current.displayUrl, names = names) { name ->
    viewModel.removeGatewayCustomHeader(current.stableId, name)
  }
}

/**
 * Editor for [GatewayCustomHeadersInput]; hosts show it only for secure manual endpoints.
 * [targetStableId] is the address the form would save headers under, as [resolveGatewayHeaderTarget] derives it.
 */
@Composable
internal fun GatewayCustomHeadersEditor(
  input: GatewayCustomHeadersInput,
  targetStableId: String?,
  modifier: Modifier = Modifier,
  saved: GatewaySavedCustomHeaders? = null,
) {
  // A removal belongs to the gateway it was chosen for, even if the form's address changes meanwhile.
  var pendingRemoval by remember { mutableStateOf<Pair<String, String>?>(null) }
  val savedNames = saved?.names.orEmpty()
  val rows = input.rowsFor(targetStableId)
  // Point at the second header once the first exists, so it is not entered under the same name.
  val hasClientId = (rows.keys + savedNames).any { it.equals(CLIENT_ID_HEADER, ignoreCase = true) }
  Column(modifier = modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(8.dp)) {
    Text(text = nativeString("Custom headers (optional)"), style = ClawTheme.type.caption, color = ClawTheme.colors.textMuted)
    Text(
      text =
        nativeString(
          "Sent only over secure connections. For a Cloudflare Access service token, add two headers: Header name CF-Access-Client-Id with your Client ID as Header value, then Header name CF-Access-Client-Secret with your Client Secret as Header value.",
        ),
      style = ClawTheme.type.caption,
      color = ClawTheme.colors.textMuted,
    )
    if (saved != null && savedNames.isNotEmpty()) {
      Text(
        text = nativeString("Saved headers for \$url", saved.displayUrl),
        style = ClawTheme.type.caption,
        color = ClawTheme.colors.textMuted,
      )
      Text(
        text = nativeString("Values are never shown. Adding a header with a saved name replaces it."),
        style = ClawTheme.type.caption,
        color = ClawTheme.colors.textMuted,
      )
      for (headerName in savedNames) {
        val label = savedHeaderLabel(headerName)
        Row(modifier = Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
          Text(
            text = label,
            style = if (label == headerName) ClawTheme.type.mono else ClawTheme.type.caption,
            color = if (label == headerName) ClawTheme.colors.text else ClawTheme.colors.warning,
            modifier = Modifier.weight(1f),
          )
          ClawPlainIconButton(
            icon = Icons.Default.Delete,
            contentDescription = nativeString("Remove saved header \$name", label),
            onClick = { pendingRemoval = saved.stableId to headerName },
          )
        }
      }
    }
    if (rows.isNotEmpty()) {
      Text(text = nativeString("Saved when you connect"), style = ClawTheme.type.caption, color = ClawTheme.colors.textMuted)
    }
    for (headerName in rows.keys) {
      Row(modifier = Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        Text(text = headerName, style = ClawTheme.type.mono, color = ClawTheme.colors.text, modifier = Modifier.weight(1f))
        ClawPlainIconButton(
          icon = Icons.Default.Close,
          contentDescription = nativeString("Remove header \$name", headerName),
          onClick = { input.remove(headerName) },
        )
      }
    }
    ClawTextField(
      value = input.name,
      onValueChange = { input.name = it },
      placeholder = if (hasClientId) nativeString("e.g. CF-Access-Client-Secret") else nativeString("e.g. CF-Access-Client-Id"),
      label = nativeString("Header name"),
    )
    ClawTextField(value = input.value, onValueChange = { input.value = it }, placeholder = "", label = nativeString("Header value"), secret = true)
    val warning = input.rejection?.message() ?: input.credentialShape?.message()
    warning?.let {
      Text(text = it, style = ClawTheme.type.caption, color = ClawTheme.colors.warning)
    }
    ClawSecondaryButton(
      text = nativeString("Add header"),
      enabled = input.canAdd,
      onClick = input::add,
      modifier = Modifier.fillMaxWidth(),
    )
  }

  val (removalStableId, removal) = pendingRemoval ?: (null to null)
  if (removal != null && saved?.stableId != removalStableId) {
    LaunchedEffect(pendingRemoval) { pendingRemoval = null }
  } else if (saved != null && removal != null) {
    FoldAwarePrompt(
      onDismissRequest = { pendingRemoval = null },
      title = nativeString("Remove saved header?"),
      text = {
        Text(
          nativeString(
            "\$name will be removed from this phone. Its value can't be shown again. The change applies to the next connection.",
            savedHeaderLabel(removal),
          ),
        )
      },
      actions = {
        TextButton(onClick = { pendingRemoval = null }) { Text(nativeString("Cancel")) }
        TextButton(
          onClick = {
            pendingRemoval = null
            saved.onRemove(removal)
          },
        ) {
          Text(nativeString("Remove"))
        }
      },
      containerColor = ClawTheme.colors.surface,
    )
  }
}

/** A credential saved as a name is described, never printed, including in accessibility text. */
private fun savedHeaderLabel(headerName: String): String =
  when (GatewayCustomHeaders.credentialShape(headerName)) {
    GatewayCustomHeaders.CredentialShape.CLIENT_ID -> nativeString("Client ID saved as a header name")
    GatewayCustomHeaders.CredentialShape.SECRET -> nativeString("Secret saved as a header name")
    null -> headerName
  }

private fun GatewayCustomHeaders.Rejection.message(): String =
  when (this) {
    GatewayCustomHeaders.Rejection.INVALID_NAME -> nativeString("Enter a valid header name, such as CF-Access-Client-Id.")
    GatewayCustomHeaders.Rejection.RESERVED_NAME -> nativeString("This header is set by the connection itself.")
    GatewayCustomHeaders.Rejection.INVALID_VALUE -> nativeString("Header values must be printable ASCII on one line, without tabs.")
  }

private fun GatewayCustomHeaders.CredentialShape.message(): String =
  when (this) {
    GatewayCustomHeaders.CredentialShape.CLIENT_ID -> {
      nativeString("This looks like a Cloudflare Access Client ID. Put it in Header value and enter CF-Access-Client-Id as Header name.")
    }

    GatewayCustomHeaders.CredentialShape.SECRET -> {
      nativeString("This looks like a secret. Put it in Header value, not Header name.")
    }
  }
