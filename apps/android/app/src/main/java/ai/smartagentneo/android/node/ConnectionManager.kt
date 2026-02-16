package ai.smartagentneo.android.node

import android.os.Build
import ai.smartagentneo.android.BuildConfig
import ai.smartagentneo.android.SecurePrefs
import ai.smartagentneo.android.gateway.GatewayClientInfo
import ai.smartagentneo.android.gateway.GatewayConnectOptions
import ai.smartagentneo.android.gateway.GatewayEndpoint
import ai.smartagentneo.android.gateway.GatewayTlsParams
import ai.smartagentneo.android.protocol.SmartAgentNeoCanvasA2UICommand
import ai.smartagentneo.android.protocol.SmartAgentNeoCanvasCommand
import ai.smartagentneo.android.protocol.SmartAgentNeoCameraCommand
import ai.smartagentneo.android.protocol.SmartAgentNeoLocationCommand
import ai.smartagentneo.android.protocol.SmartAgentNeoScreenCommand
import ai.smartagentneo.android.protocol.SmartAgentNeoSmsCommand
import ai.smartagentneo.android.protocol.SmartAgentNeoCapability
import ai.smartagentneo.android.LocationMode
import ai.smartagentneo.android.VoiceWakeMode

class ConnectionManager(
  private val prefs: SecurePrefs,
  private val cameraEnabled: () -> Boolean,
  private val locationMode: () -> LocationMode,
  private val voiceWakeMode: () -> VoiceWakeMode,
  private val smsAvailable: () -> Boolean,
  private val hasRecordAudioPermission: () -> Boolean,
  private val manualTls: () -> Boolean,
) {
  companion object {
    internal fun resolveTlsParamsForEndpoint(
      endpoint: GatewayEndpoint,
      storedFingerprint: String?,
      manualTlsEnabled: Boolean,
    ): GatewayTlsParams? {
      val stableId = endpoint.stableId
      val stored = storedFingerprint?.trim().takeIf { !it.isNullOrEmpty() }
      val isManual = stableId.startsWith("manual|")

      if (isManual) {
        if (!manualTlsEnabled) return null
        if (!stored.isNullOrBlank()) {
          return GatewayTlsParams(
            required = true,
            expectedFingerprint = stored,
            allowTOFU = false,
            stableId = stableId,
          )
        }
        return GatewayTlsParams(
          required = true,
          expectedFingerprint = null,
          allowTOFU = false,
          stableId = stableId,
        )
      }

      // Prefer stored pins. Never let discovery-provided TXT override a stored fingerprint.
      if (!stored.isNullOrBlank()) {
        return GatewayTlsParams(
          required = true,
          expectedFingerprint = stored,
          allowTOFU = false,
          stableId = stableId,
        )
      }

      val hinted = endpoint.tlsEnabled || !endpoint.tlsFingerprintSha256.isNullOrBlank()
      if (hinted) {
        // TXT is unauthenticated. Do not treat the advertised fingerprint as authoritative.
        return GatewayTlsParams(
          required = true,
          expectedFingerprint = null,
          allowTOFU = false,
          stableId = stableId,
        )
      }

      return null
    }
  }

  fun buildInvokeCommands(): List<String> =
    buildList {
      add(SmartAgentNeoCanvasCommand.Present.rawValue)
      add(SmartAgentNeoCanvasCommand.Hide.rawValue)
      add(SmartAgentNeoCanvasCommand.Navigate.rawValue)
      add(SmartAgentNeoCanvasCommand.Eval.rawValue)
      add(SmartAgentNeoCanvasCommand.Snapshot.rawValue)
      add(SmartAgentNeoCanvasA2UICommand.Push.rawValue)
      add(SmartAgentNeoCanvasA2UICommand.PushJSONL.rawValue)
      add(SmartAgentNeoCanvasA2UICommand.Reset.rawValue)
      add(SmartAgentNeoScreenCommand.Record.rawValue)
      if (cameraEnabled()) {
        add(SmartAgentNeoCameraCommand.Snap.rawValue)
        add(SmartAgentNeoCameraCommand.Clip.rawValue)
      }
      if (locationMode() != LocationMode.Off) {
        add(SmartAgentNeoLocationCommand.Get.rawValue)
      }
      if (smsAvailable()) {
        add(SmartAgentNeoSmsCommand.Send.rawValue)
      }
      if (BuildConfig.DEBUG) {
        add("debug.logs")
        add("debug.ed25519")
      }
      add("app.update")
    }

  fun buildCapabilities(): List<String> =
    buildList {
      add(SmartAgentNeoCapability.Canvas.rawValue)
      add(SmartAgentNeoCapability.Screen.rawValue)
      if (cameraEnabled()) add(SmartAgentNeoCapability.Camera.rawValue)
      if (smsAvailable()) add(SmartAgentNeoCapability.Sms.rawValue)
      if (voiceWakeMode() != VoiceWakeMode.Off && hasRecordAudioPermission()) {
        add(SmartAgentNeoCapability.VoiceWake.rawValue)
      }
      if (locationMode() != LocationMode.Off) {
        add(SmartAgentNeoCapability.Location.rawValue)
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
    return "SmartAgentNeoAndroid/$version (Android $releaseLabel; SDK ${Build.VERSION.SDK_INT})"
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
      client = buildClientInfo(clientId = "smart-agent-neo-android", clientMode = "node"),
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
      client = buildClientInfo(clientId = "smart-agent-neo-control-ui", clientMode = "ui"),
      userAgent = buildUserAgent(),
    )
  }

  fun resolveTlsParams(endpoint: GatewayEndpoint): GatewayTlsParams? {
    val stored = prefs.loadGatewayTlsFingerprint(endpoint.stableId)
    return resolveTlsParamsForEndpoint(endpoint, storedFingerprint = stored, manualTlsEnabled = manualTls())
  }
}
