package ai.openclaw.app.node

import android.os.Build
import ai.openclaw.android.gateway.GatewayClientProfiles
import ai.openclaw.android.gateway.GatewayClientInfo
import ai.openclaw.android.gateway.GatewayConnectOptions
import ai.openclaw.android.gateway.GatewayConnectProfiles
import ai.openclaw.app.BuildConfig
import ai.openclaw.app.SecurePrefs
import ai.openclaw.app.gateway.GatewayEndpoint
import ai.openclaw.app.gateway.GatewayTlsParams
import ai.openclaw.app.LocationMode
import ai.openclaw.app.VoiceWakeMode

class ConnectionManager(
  private val prefs: SecurePrefs,
  private val cameraEnabled: () -> Boolean,
  private val locationMode: () -> LocationMode,
  private val voiceWakeMode: () -> VoiceWakeMode,
  private val motionActivityAvailable: () -> Boolean,
  private val motionPedometerAvailable: () -> Boolean,
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

  private fun runtimeFlags(): NodeRuntimeFlags =
    NodeRuntimeFlags(
      cameraEnabled = cameraEnabled(),
      locationEnabled = locationMode() != LocationMode.Off,
      smsAvailable = smsAvailable(),
      voiceWakeEnabled = voiceWakeMode() != VoiceWakeMode.Off && hasRecordAudioPermission(),
      motionActivityAvailable = motionActivityAvailable(),
      motionPedometerAvailable = motionPedometerAvailable(),
      debugBuild = BuildConfig.DEBUG,
    )

  fun buildInvokeCommands(): List<String> = InvokeCommandRegistry.advertisedCommands(runtimeFlags())

  fun buildCapabilities(): List<String> = InvokeCommandRegistry.advertisedCapabilities(runtimeFlags())

  fun resolvedVersionName(): String {
    return GatewayClientProfiles.resolveVersionName(BuildConfig.VERSION_NAME, BuildConfig.DEBUG)
  }

  fun resolveModelIdentifier(): String? {
    return GatewayClientProfiles.resolveModelIdentifier()
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
      platform = GatewayClientProfiles.AndroidPlatform,
      mode = clientMode,
      instanceId = prefs.instanceId.value,
      deviceFamily = GatewayClientProfiles.AndroidDeviceFamily,
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
      client = buildClientInfo(
        clientId = GatewayClientProfiles.AndroidClientId,
        clientMode = GatewayClientProfiles.NodeMode,
      ),
      userAgent = buildUserAgent(),
    )
  }

  fun buildOperatorConnectOptions(): GatewayConnectOptions {
    return GatewayConnectProfiles.buildOperatorConnectOptions(
      client = buildClientInfo(
        clientId = GatewayClientProfiles.AndroidClientId,
        clientMode = GatewayClientProfiles.UiMode,
      ),
      userAgent = buildUserAgent(),
    )
  }

  fun resolveTlsParams(endpoint: GatewayEndpoint): GatewayTlsParams? {
    val stored = prefs.loadGatewayTlsFingerprint(endpoint.stableId)
    return resolveTlsParamsForEndpoint(endpoint, storedFingerprint = stored, manualTlsEnabled = manualTls())
  }
}
