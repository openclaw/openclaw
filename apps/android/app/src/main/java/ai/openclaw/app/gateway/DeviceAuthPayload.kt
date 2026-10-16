package ai.openclaw.app.gateway

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
    listOf(
      "v3",
      deviceId,
      clientId,
      clientMode,
      role,
      scopes.joinToString(","),
      signedAtMs.toString(),
      token.orEmpty(),
      nonce,
      normalizeMetadataField(platform),
      normalizeMetadataField(deviceFamily),
    ).joinToString("|")

  /** Normalizes signed metadata fields without locale-sensitive lowercasing. */
  internal fun normalizeMetadataField(value: String?): String {
    val trimmed = value?.trim().orEmpty()
    // Keep cross-runtime normalization deterministic (TS/Swift/Kotlin):
    // lowercase ASCII A-Z only for auth payload metadata fields.
    val out = StringBuilder(trimmed.length)
    for (ch in trimmed) {
      out.append(if (ch in 'A'..'Z') (ch.code + 32).toChar() else ch)
    }
    return out.toString()
  }
}
