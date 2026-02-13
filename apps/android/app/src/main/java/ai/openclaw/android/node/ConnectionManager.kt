package ai.openclaw.android.node

import android.os.Build
import ai.openclaw.android.BuildConfig
import ai.openclaw.android.SecurePrefs
import ai.openclaw.android.gateway.GatewayClientInfo
import ai.openclaw.android.gateway.GatewayConnectOptions
import ai.openclaw.android.gateway.GatewayEndpoint
import ai.openclaw.android.gateway.GatewayTlsParams
import ai.openclaw.android.protocol.OpenClawCanvasA2UICommand
import ai.openclaw.android.protocol.OpenClawCanvasCommand
import ai.openclaw.android.protocol.OpenClawCameraCommand
import ai.openclaw.android.protocol.OpenClawLocationCommand
import ai.openclaw.android.protocol.OpenClawScreenCommand
import ai.openclaw.android.protocol.OpenClawSmsCommand
import ai.openclaw.android.protocol.OpenClawCapability
import ai.openclaw.android.LocationMode
import ai.openclaw.android.VoiceWakeMode

class ConnectionManager(
  private val prefs: SecurePrefs,
  private val cameraEnabled: () -> Boolean,
  private val locationMode: () -> LocationMode,
  private val voiceWakeMode: () -> VoiceWakeMode,
  private val smsAvailable: () -> Boolean,
  private val hasRecordAudioPermission: () -> Boolean,
  private val manualTls: () -> Boolean,
) {
  fun buildInvokeCommands(): List<String> =
    buildList {
      add(OpenClawCanvasCommand.Present.rawValue)
      add(OpenClawCanvasCommand.Hide.rawValue)
      add(OpenClawCanvasCommand.Navigate.rawValue)
      add(OpenClawCanvasCommand.Eval.rawValue)
      add(OpenClawCanvasCommand.Snapshot.rawValue)
      add(OpenClawCanvasA2UICommand.Push.rawValue)
      add(OpenClawCanvasA2UICommand.PushJSONL.rawValue)
      add(OpenClawCanvasA2UICommand.Reset.rawValue)
      add(OpenClawScreenCommand.Record.rawValue)
      if (cameraEnabled()) {
        add(OpenClawCameraCommand.Snap.rawValue)
        add(OpenClawCameraCommand.Clip.rawValue)
      }
      if (locationMode() != LocationMode.Off) {
        add(OpenClawLocationCommand.Get.rawValue)
      }
      if (smsAvailable()) {
        add(OpenClawSmsCommand.Send.rawValue)
      }
      if (BuildConfig.DEBUG) {
        add("debug.logs")
        add("debug.ed25519")
      }
      add("app.update")
    }

  fun buildCapabilities(): List<String> =
    buildList {
      add(OpenClawCapability.Canvas.rawValue)
      add(OpenClawCapability.Screen.rawValue)
      if (cameraEnabled()) add(OpenClawCapability.Camera.rawValue)
      if (smsAvailable()) add(OpenClawCapability.Sms.rawValue)
      if (voiceWakeMode() != VoiceWakeMode.Off && hasRecordAudioPermission()) {
        add(OpenClawCapability.VoiceWake.rawValue)
      }
      if (locationMode() != LocationMode.Off) {
        add(OpenClawCapability.Location.rawValue)
      }
    }

  fun resolvedVersionName(): String {
    val versionName = BuildConfig.VERSION_NAME.trim().ifEmpty { "dev" }
    return if (BuildConfig.DEBUG && !versionName.contains("dev", ignoreCase = true)) {
      "$versionName-dev"
    } else {
      versionName
    }
  }

  fun resolveModelIdentifier(): String? {
    return listOfNotNull(Build.MANUFACTURER, Build.MODEL)
      .joinToString(" ")
      .trim()
      .ifEmpty { null }
  }

  fun buildUserAgent(): String {
    val version = resolvedVersionName()
    val release = Build.VERSION.RELEASE?.trim().orEmpty()
    val releaseLabel = if (release.isEmpty()) "unknown" else release
    return "OpenClawAndroid/$version (Android $releaseLabel; SDK ${Build.VERSION.SDK_INT})"
  }

  fun buildClientInfo(clientId: String, clientMode: String): GatewayClientInfo {
    return GatewayClientInfo(
      id = clientId,
      displayName = prefs.displayName.value,
      version = resolvedVersionName(),
      platform = "android",
      mode = clientMode,
      instanceId = prefs.instanceId.value,
      deviceFamily = "Android",
      modelIdentifier = resolveModelIdentifier(),
    )
  }

  fun buildNodeConnectOptions(): GatewayConnectOptions {
    return GatewayConnectOptions(
      role = "node",
      scopes = emptyList(),
      caps = buildCapabilities(),
      commands = buildInvokeCommands(),
      permissions = emptyMap(),
      client = buildClientInfo(clientId = "openclaw-android", clientMode = "node"),
      userAgent = buildUserAgent(),
    )
  }

  fun buildOperatorConnectOptions(): GatewayConnectOptions {
    return GatewayConnectOptions(
      role = "operator",
      scopes = listOf("operator.read", "operator.write", "operator.talk.secrets"),
      caps = emptyList(),
      commands = emptyList(),
      permissions = emptyMap(),
      client = buildClientInfo(clientId = "openclaw-control-ui", clientMode = "ui"),
      userAgent = buildUserAgent(),
    )
  }

  fun resolveTlsParams(endpoint: GatewayEndpoint): GatewayTlsParams? {
    val stored = prefs.loadGatewayTlsFingerprint(endpoint.stableId)
    val hinted = endpoint.tlsEnabled || !endpoint.tlsFingerprintSha256.isNullOrBlank()
    val manual = endpoint.stableId.startsWith("manual|")

    if (manual) {
      if (!manualTls()) return null
      return GatewayTlsParams(
        required = true,
        expectedFingerprint = endpoint.tlsFingerprintSha256 ?: stored,
        allowTOFU = stored == null,
        stableId = endpoint.stableId,
      )
    }

    if (hinted) {
      return GatewayTlsParams(
        required = true,
        expectedFingerprint = endpoint.tlsFingerprintSha256 ?: stored,
        allowTOFU = stored == null,
        stableId = endpoint.stableId,
      )
    }

    if (!stored.isNullOrBlank()) {
      return GatewayTlsParams(
        required = true,
        expectedFingerprint = stored,
        allowTOFU = false,
        stableId = endpoint.stableId,
      )
    }

    return null
  }
}
