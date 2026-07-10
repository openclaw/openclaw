package ai.openclaw.app.gateway

import ai.openclaw.mobile.core.DeviceAuthPayload as SharedDeviceAuthPayload

/**
 * Canonical device-auth payload builder shared with gateway verification rules.
 */
internal object DeviceAuthPayload {
  /** Builds the canonical v3 auth string signed by device registration flows. */
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
  ): String =
    SharedDeviceAuthPayload.buildV3(
      deviceId,
      clientId,
      clientMode,
      role,
      scopes,
      signedAtMs,
      token,
      nonce,
      platform,
      deviceFamily,
    )

  /** Normalizes signed metadata fields without locale-sensitive lowercasing. */
  internal fun normalizeMetadataField(value: String?): String = SharedDeviceAuthPayload.normalizeMetadataField(value)
}
