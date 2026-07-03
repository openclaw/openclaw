package ai.openclaw.app.ui

import ai.openclaw.app.BuildConfig
import ai.openclaw.app.GatewayConnectionProblem
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.os.Build
import android.widget.Toast

/** App version label shared by diagnostics and gateway-facing Android metadata. */
internal fun openClawAndroidVersionLabel(): String {
  val versionName = BuildConfig.VERSION_NAME.trim().ifEmpty { "dev" }
  return if (BuildConfig.DEBUG && !versionName.contains("dev", ignoreCase = true)) {
    "$versionName-dev"
  } else {
    versionName
  }
}

/** Normalizes blank gateway status text for display and diagnostics copy. */
internal fun gatewayStatusForDisplay(statusText: String): String = statusText.trim().ifEmpty { "Offline" }

/** Returns true when the status has enough signal to show diagnostics affordances. */
internal fun gatewayStatusHasDiagnostics(statusText: String): Boolean {
  val lower = gatewayStatusForDisplay(statusText).lowercase()
  return lower != "offline" && !lower.contains("connecting")
}

/** Resolves the best non-secret endpoint label available to diagnostics surfaces. */
internal fun gatewayDiagnosticsEndpoint(
  remoteAddress: String?,
  manualHost: String,
  manualPort: Int,
  manualTls: Boolean,
): String {
  remoteAddress?.trim()?.takeIf { it.isNotEmpty() }?.let { return it }
  return composeGatewayManualUrl(manualHost, manualPort.toString(), manualTls)?.let { parseGatewayEndpoint(it)?.displayUrl } ?: "Not set"
}

/** Detects pairing/approval status text so UI can offer pairing-specific actions. */
internal fun gatewayStatusLooksLikePairing(statusText: String): Boolean {
  val lower = gatewayStatusForDisplay(statusText).lowercase()
  return lower.contains("pair") || lower.contains("approve")
}

/** Maps structured gateway auth failures to the compact labels used by status surfaces. */
internal fun gatewayAuthRecoveryLabel(problem: GatewayConnectionProblem?): String? =
  when (problem?.code) {
    "AUTH_BOOTSTRAP_TOKEN_INVALID" -> "Setup code expired"
    "AUTH_TOKEN_MISSING" -> "Gateway token needed"
    "AUTH_PASSWORD_MISSING" -> "Gateway password needed"
    "AUTH_PASSWORD_MISMATCH" -> "Gateway password invalid"
    "AUTH_TOKEN_MISMATCH",
    "AUTH_DEVICE_TOKEN_MISMATCH",
    -> "Saved auth invalid"
    "CONTROL_UI_DEVICE_IDENTITY_REQUIRED",
    "DEVICE_IDENTITY_REQUIRED",
    -> "Device identity required"
    else -> null
  }

/** Builds the copyable support prompt with device, endpoint, and exact status context. */
internal fun buildGatewayDiagnosticsReport(
  screen: String,
  gatewayAddress: String,
  statusText: String,
): String {
  val device =
    listOfNotNull(Build.MANUFACTURER, Build.MODEL)
      .joinToString(" ")
      .trim()
      .ifEmpty { "Android" }
  val androidVersion =
    Build.VERSION.RELEASE
      ?.trim()
      .orEmpty()
      .ifEmpty { Build.VERSION.SDK_INT.toString() }
  val endpoint = gatewayAddress.trim().ifEmpty { "unknown" }
  val status = gatewayStatusForDisplay(statusText)
  return """
    Help diagnose this OpenClaw Android gateway connection failure.

    Please:
    - pick one route only: same machine, same LAN, Tailscale, or public URL
    - classify this as pairing/auth, TLS trust, wrong advertised route, wrong address/port, or gateway down
    - remember: public routes require wss:// or Tailscale Serve; ws:// is allowed for localhost, .local hosts, the Android emulator, and private LAN IPs
    - quote the exact app status/error below
    - tell me whether `openclaw devices list` should show a pending pairing request
    - if more signal is needed, ask for `openclaw qr --json`, `openclaw devices list`, and `openclaw nodes status`
    - give the next exact command or tap

    Debug info:
    - screen: $screen
    - app version: ${openClawAndroidVersionLabel()}
    - device: $device
    - android: $androidVersion (SDK ${Build.VERSION.SDK_INT})
    - gateway address: $endpoint
    - status/error: $status
    """.trimIndent()
}

/** Copies the diagnostics report to Android clipboard and shows a short confirmation toast. */
internal fun copyGatewayDiagnosticsReport(
  context: Context,
  screen: String,
  gatewayAddress: String,
  statusText: String,
) {
  val clipboard = context.getSystemService(ClipboardManager::class.java) ?: return
  val report = buildGatewayDiagnosticsReport(screen = screen, gatewayAddress = gatewayAddress, statusText = statusText)
  clipboard.setPrimaryClip(ClipData.newPlainText("OpenClaw gateway diagnostics", report))
  Toast.makeText(context, "Copied gateway diagnostics", Toast.LENGTH_SHORT).show()
}
