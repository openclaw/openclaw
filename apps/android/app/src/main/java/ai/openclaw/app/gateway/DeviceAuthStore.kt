package ai.openclaw.app.gateway

import ai.openclaw.app.SecurePrefs
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json

/** Stored gateway device-token material scoped by gateway, device id, and role. */
data class DeviceAuthEntry(
  val token: String,
  val role: String,
  val scopes: List<String>,
  val updatedAtMs: Long,
)

@Serializable
private data class PersistedDeviceAuthMetadata(
  val scopes: List<String> = emptyList(),
  val updatedAtMs: Long = 0L,
)

/** Persistence interface used by gateway pairing/session code for role tokens. */
interface DeviceAuthTokenStore {
  /** Loads the stored token plus metadata for one device/role pair. */
  fun loadEntry(
    gatewayId: String,
    deviceId: String,
    role: String,
  ): DeviceAuthEntry?

  /** Loads only the bearer token when callers do not need scope metadata. */
  fun loadToken(
    gatewayId: String,
    deviceId: String,
    role: String,
  ): String? = loadEntry(gatewayId, deviceId, role)?.token

  /**
   * Returns true only after the token and its scope metadata are durably committed.
   * When [replacesStoredToken] is non-null, admits the write only while the slot still holds
   * that token: a fresher grant that already replaced it wins and this write is refused.
   */
  fun saveToken(
    gatewayId: String,
    deviceId: String,
    role: String,
    token: String,
    scopes: List<String> = emptyList(),
    replacesStoredToken: String? = null,
  ): Boolean

  /** Removes token and metadata; when [onlyIfToken] is non-null, only while the slot holds that token. */
  fun clearToken(
    gatewayId: String,
    deviceId: String,
    role: String,
    onlyIfToken: String? = null,
  )
}

/** SecurePrefs-backed implementation of Android gateway device-token storage. */
class DeviceAuthStore(
  private val prefs: SecurePrefs,
) : DeviceAuthTokenStore {
  private val json = Json { ignoreUnknownKeys = true }

  // Keep the stored-token comparison and mutation indivisible across competing role grants.
  private val lock = Any()

  override fun loadEntry(
    gatewayId: String,
    deviceId: String,
    role: String,
  ): DeviceAuthEntry? {
    val key = tokenKey(gatewayId, deviceId, role)
    val token = prefs.getString(key)?.trim()?.takeIf { it.isNotEmpty() } ?: return null
    val normalizedRole = normalizeRole(role)
    val metadata =
      prefs
        .getString(metadataKey(gatewayId, deviceId, role))
        ?.let { raw ->
          runCatching { json.decodeFromString<PersistedDeviceAuthMetadata>(raw) }.getOrNull()
        }
    return DeviceAuthEntry(
      token = token,
      role = normalizedRole,
      scopes = metadata?.scopes ?: emptyList(),
      updatedAtMs = metadata?.updatedAtMs ?: 0L,
    )
  }

  override fun saveToken(
    gatewayId: String,
    deviceId: String,
    role: String,
    token: String,
    scopes: List<String>,
    replacesStoredToken: String?,
  ): Boolean =
    synchronized(lock) {
      if (replacesStoredToken != null && loadEntry(gatewayId, deviceId, role)?.token != replacesStoredToken.trim()) {
        return@synchronized false
      }
      val normalizedScopes = normalizeScopes(scopes)
      val key = tokenKey(gatewayId, deviceId, role)
      prefs.commitSecureStrings(
        mapOf(
          key to token.trim(),
          metadataKey(gatewayId, deviceId, role) to
            json.encodeToString(
              PersistedDeviceAuthMetadata(
                scopes = normalizedScopes,
                updatedAtMs = System.currentTimeMillis(),
              ),
            ),
        ),
      )
    }

  override fun clearToken(
    gatewayId: String,
    deviceId: String,
    role: String,
    onlyIfToken: String?,
  ) = synchronized(lock) {
    if (onlyIfToken != null && loadEntry(gatewayId, deviceId, role)?.token != onlyIfToken.trim()) {
      return@synchronized
    }
    val key = tokenKey(gatewayId, deviceId, role)
    prefs.remove(key)
    prefs.remove(metadataKey(gatewayId, deviceId, role))
  }

  private fun tokenKey(
    gatewayId: String,
    deviceId: String,
    role: String,
  ): String = "gateway.deviceToken.${keySuffix(gatewayId, deviceId, role)}"

  private fun metadataKey(
    gatewayId: String,
    deviceId: String,
    role: String,
  ): String = "gateway.deviceTokenMeta.${keySuffix(gatewayId, deviceId, role)}"

  private fun keySuffix(
    gatewayId: String,
    deviceId: String,
    role: String,
  ): String {
    val gateway = gatewayId.trim().also { require(it.isNotEmpty()) }
    return "$gateway.${deviceId.trim().lowercase()}.${normalizeRole(role)}"
  }

  /** Normalizes role names so node/operator token slots are stable across callers. */
  private fun normalizeRole(role: String): String = role.trim().lowercase()

  /** Stores scopes in deterministic order for display and restart comparisons. */
  private fun normalizeScopes(scopes: List<String>): List<String> =
    scopes
      .map { it.trim() }
      .filter { it.isNotEmpty() }
      .distinct()
      .sorted()
}
