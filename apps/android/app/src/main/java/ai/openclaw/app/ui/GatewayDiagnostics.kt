package ai.openclaw.app.ui

import ai.openclaw.app.BuildConfig
import ai.openclaw.app.GatewayConnectionDisplay
import ai.openclaw.app.GatewayConnectionProblem
import ai.openclaw.app.GatewayNodeCapabilityApproval
import ai.openclaw.app.gateway.normalizeGatewayApprovalRequestId
import ai.openclaw.app.i18n.nativeString
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

/** Converts raw gateway connection state into a stable compact label for status surfaces. */
internal fun gatewayStatusLabel(
  statusText: String,
  isConnected: Boolean,
  gatewayConnectionProblem: GatewayConnectionProblem? = null,
): String {
  val status = statusText.trim().lowercase()
  return when {
    status == "connected (node offline)" -> {
      nativeString("Connected (node offline)")
    }

    status == "connected (operator offline)" -> {
      nativeString("Connected (operator offline)")
    }

    isConnected -> {
      nativeString("Ready")
    }

    status == "offline" -> {
      nativeString("Offline")
    }

    gatewayConnectionProblem?.isNetworkFailure == true && gatewayConnectionProblem.reason == "transport-cleanup" -> {
      nativeString("Stopping previous connection")
    }

    gatewayConnectionProblem?.isNetworkFailure == true -> {
      nativeString("Cannot reach gateway")
    }

    status.contains("connecting") || status.contains("reconnecting") -> {
      nativeString("Connecting...")
    }

    status.contains("pair") -> {
      nativeString("Pairing needed")
    }

    status.contains("auth") || status.contains("device identity") -> {
      gatewayAuthRecoveryLabel(gatewayConnectionProblem) ?: nativeString("Authentication needed")
    }

    status.contains("fingerprint verification timed out") -> {
      nativeString("TLS timed out")
    }

    status.contains("no tls endpoint") -> {
      nativeString("No TLS endpoint")
    }

    status.contains("certificate") || status.contains("tls") -> {
      nativeString("Certificate review needed")
    }

    status.contains("failed") || status.contains("error") || status.contains("offline") || status.contains("not connected") -> {
      nativeString("Cannot reach gateway")
    }

    else -> {
      nativeString("Not connected")
    }
  }
}

internal fun gatewayStatusLabel(display: GatewayConnectionDisplay): String = gatewayStatusLabel(display.statusText, display.isConnected, display.problem)

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
  val lower = statusText.trim().lowercase()
  return lower.contains("pair") || lower.contains("approve")
}

/** Maps structured gateway auth failures to the compact labels used by status surfaces. */
internal fun gatewayAuthRecoveryLabel(problem: GatewayConnectionProblem?): String? =
  when (problem?.code) {
    "AUTH_BOOTSTRAP_TOKEN_INVALID" -> nativeString("Setup code expired")
    "AUTH_TOKEN_MISSING" -> nativeString("Gateway token needed")
    "AUTH_TOKEN_NOT_CONFIGURED" -> nativeString("Gateway token not configured")
    "AUTH_PASSWORD_MISSING" -> nativeString("Gateway password needed")
    "AUTH_PASSWORD_MISMATCH" -> nativeString("Gateway password invalid")
    "AUTH_PASSWORD_NOT_CONFIGURED" -> nativeString("Gateway password not configured")
    "AUTH_SCOPE_MISMATCH" -> nativeString("Gateway access needs review")
    "AUTH_TOKEN_MISMATCH", "AUTH_DEVICE_TOKEN_MISMATCH" -> nativeString("Saved auth invalid")
    "CONTROL_UI_DEVICE_IDENTITY_REQUIRED", "DEVICE_IDENTITY_REQUIRED" -> nativeString("Device identity required")
    else -> null
  }

/** Returns the exact host command for one node's approval state when available. */
internal fun gatewayNodeApprovalCommand(approval: GatewayNodeCapabilityApproval): String? {
  val requestId =
    when (approval) {
      is GatewayNodeCapabilityApproval.PendingApproval -> approval.requestId

      is GatewayNodeCapabilityApproval.PendingReapproval -> approval.requestId

      GatewayNodeCapabilityApproval.Unapproved -> null

      GatewayNodeCapabilityApproval.Loading,
      GatewayNodeCapabilityApproval.Unsupported,
      GatewayNodeCapabilityApproval.Approved,
      -> return null
    }
  return normalizeGatewayApprovalRequestId(requestId)?.let { "openclaw nodes approve $it" } ?: "openclaw nodes status"
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
  val status = statusText.trim().ifEmpty { "Offline" }
  return nativeString(
    "Help diagnose this OpenClaw Android gateway connection failure.\n\n" +
      "Please:\n" +
      "- pick one route only: same machine, same LAN, Tailscale, or public URL\n" +
      "- classify this as pairing/auth, TLS trust, wrong advertised route, wrong address/port, or gateway down\n" +
      "- remember: public routes require wss:// or Tailscale Serve; ws:// is allowed for localhost, .local hosts, the Android emulator, and private LAN IPs\n" +
      "- quote the exact app status/error below\n" +
      "- tell me whether `openclaw devices list` should show a pending pairing request\n" +
      "- if more signal is needed, ask for `openclaw qr --json`, `openclaw devices list`, and `openclaw nodes status`\n" +
      "- give the next exact command or tap\n\n" +
      "Debug info:\n" +
      "- screen: \$screen\n" +
      "- app version: \$appVersion\n" +
      "- device: \$device\n" +
      "- android: \$androidVersion (SDK \$sdkVersion)\n" +
      "- gateway address: \$endpoint\n" +
      "- status/error: \$status",
    screen,
    openClawAndroidVersionLabel(),
    device,
    androidVersion,
    Build.VERSION.SDK_INT,
    endpoint,
    status,
  )
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
  Toast.makeText(context, nativeString("Copied gateway diagnostics"), Toast.LENGTH_SHORT).show()
}
