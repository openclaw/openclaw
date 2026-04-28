package ai.openclaw.app.gateway

import ai.openclaw.android.gateway.GatewayDeviceAuthPayload

internal object DeviceAuthPayload {
  fun buildV3(
    deviceId: String,
    clientId: String,
    clientMode: String,
    role: String,
    scopes: List<String>,
    signedAtMs: Long,
    token: String?,
    nonce: String,
    platform: String?,
    deviceFamily: String?,
  ): String {
    return GatewayDeviceAuthPayload.buildV3(
      deviceId = deviceId,
      clientId = clientId,
      clientMode = clientMode,
      role = role,
      scopes = scopes,
      signedAtMs = signedAtMs,
      token = token,
      nonce = nonce,
      platform = platform,
      deviceFamily = deviceFamily,
    )
  }

  fun normalizeMetadataField(value: String?): String {
    return GatewayDeviceAuthPayload.normalizeMetadataField(value)
  }
}
