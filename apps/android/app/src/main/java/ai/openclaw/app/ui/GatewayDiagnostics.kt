package ai.openclaw.app.ui

import ai.openclaw.app.BuildConfig
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

/** Summarizes why chat is blocked without dumping raw gateway logs into the UI. */
internal fun gatewayOfflineDiagnosis(
  statusText: String,
  gatewayAddress: String,
): String {
  val status = gatewayStatusForDisplay(statusText)
  val lower = status.lowercase()
  val endpoint = gatewayAddress.trim()
  return when {
    endpoint.isBlank() || endpoint.equals("not set", ignoreCase = true) -> "Endpoint not configured"
    lower.contains("pair") || lower.contains("approve") -> "Pairing needs approval"
    lower.contains("auth") || lower.contains("token") || lower.contains("password") -> "Authentication needs attention"
    lower.contains("certificate") || lower.contains("tls") || lower.contains("fingerprint") -> "TLS trust needs review"
    lower.contains("node") && (lower.contains("not registered") || lower.contains("not paired")) -> "Node is not registered"
    lower.contains("provider") && (lower.contains("offline") || lower.contains("unavailable") || lower.contains("not ready")) -> "Provider is offline"
    lower.contains("timeout") || lower.contains("refused") || lower.contains("unreachable") || lower.contains("failed") || lower.contains("error") -> "Gateway is unreachable"
    lower.contains("connecting") || lower.contains("reconnecting") -> "Connection is still retrying"
    lower == "offline" || lower.contains("not connected") -> "Gateway is unreachable"
    else -> status
  }
}

/** Detects pairing/approval status text so UI can offer pairing-specific actions. */
internal fun gatewayStatusLooksLikePairing(statusText: String): Boolean {
  val lower = gatewayStatusForDisplay(statusText).lowercase()
  return lower.contains("pair") || lower.contains("approve")
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
    - remember: public routes require wss:// or Tailscale Serve; ws:// is allowed for localhost, the Android emulator, and private LAN IPs
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
    - diagnosis: ${gatewayOfflineDiagnosis(statusText = status, gatewayAddress = endpoint)}
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
