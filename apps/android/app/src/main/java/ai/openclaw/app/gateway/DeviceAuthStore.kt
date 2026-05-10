package ai.openclaw.app.gateway

import android.content.Context
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json

data class DeviceAuthEntry(
  val token: String,
  val role: String,
  val scopes: List<String>,
  val updatedAtMs: Long,
)

@Serializable
private data class PersistedDeviceAuthEntry(
  val token: String,
  val role: String,
  val scopes: List<String> = emptyList(),
  val updatedAtMs: Long = 0L,
)

@Serializable
private data class PersistedDeviceAuthStore(
  val version: Int = 1,
  val deviceId: String,
  val tokens: Map<String, PersistedDeviceAuthEntry> = emptyMap(),
)

interface DeviceAuthTokenStore {
  fun loadEntry(
    deviceId: String,
    role: String,
  ): DeviceAuthEntry?

  fun loadToken(
    deviceId: String,
    role: String,
  ): String? = loadEntry(deviceId, role)?.token

  fun saveToken(
    deviceId: String,
    role: String,
    token: String,
    scopes: List<String> = emptyList(),
  )

  fun clearToken(
    deviceId: String,
    role: String,
  )
}

class DeviceAuthStore(
  context: Context,
) : DeviceAuthTokenStore {
  private val json = Json { ignoreUnknownKeys = true }
  private val kvStore = OpenClawSQLiteKVStore(context)

  override fun loadEntry(
    deviceId: String,
    role: String,
  ): DeviceAuthEntry? {
    val store = readStore() ?: return null
    val normalizedDevice = normalizeDeviceId(deviceId)
    if (store.deviceId != normalizedDevice) return null
    val normalizedRole = normalizeRole(role)
    val entry = store.tokens[normalizedRole] ?: return null
    val token = entry.token.trim().takeIf { it.isNotEmpty() } ?: return null
    return DeviceAuthEntry(
      token = token,
      role = normalizedRole,
      scopes = normalizeScopes(entry.scopes),
      updatedAtMs = entry.updatedAtMs,
    )
  }

  override fun saveToken(
    deviceId: String,
    role: String,
    token: String,
    scopes: List<String>,
  ) {
    val normalizedDevice = normalizeDeviceId(deviceId)
    val normalizedRole = normalizeRole(role)
    val normalizedScopes = normalizeScopes(scopes)
    val existing = readStore()
    val nextTokens =
      if (existing?.deviceId == normalizedDevice) {
        existing.tokens.toMutableMap()
      } else {
        mutableMapOf()
      }
    nextTokens[normalizedRole] =
      PersistedDeviceAuthEntry(
        token = token.trim(),
        role = normalizedRole,
        scopes = normalizedScopes,
        updatedAtMs = System.currentTimeMillis(),
      )
    writeStore(
      PersistedDeviceAuthStore(
        deviceId = normalizedDevice,
        tokens = nextTokens,
      ),
    )
  }

  override fun clearToken(
    deviceId: String,
    role: String,
  ) {
    val normalizedDevice = normalizeDeviceId(deviceId)
    val existing = readStore() ?: return
    if (existing.deviceId != normalizedDevice) return
    val normalizedRole = normalizeRole(role)
    if (!existing.tokens.containsKey(normalizedRole)) return
    val nextTokens = existing.tokens.toMutableMap()
    nextTokens.remove(normalizedRole)
    writeStore(existing.copy(tokens = nextTokens))
  }

  private fun readStore(): PersistedDeviceAuthStore? {
    val raw = kvStore.readString(DEVICE_AUTH_SCOPE, DEVICE_AUTH_KEY) ?: return null
    return runCatching { json.decodeFromString<PersistedDeviceAuthStore>(raw) }
      .getOrNull()
      ?.takeIf { it.version == 1 && it.deviceId.isNotBlank() }
  }

  private fun writeStore(store: PersistedDeviceAuthStore) {
    kvStore.writeString(
      DEVICE_AUTH_SCOPE,
      DEVICE_AUTH_KEY,
      json.encodeToString(store),
    )
  }

  private fun normalizeDeviceId(deviceId: String): String = deviceId.trim().lowercase()

  private fun normalizeRole(role: String): String = role.trim().lowercase()

  private fun normalizeScopes(scopes: List<String>): List<String> =
    scopes
      .map { it.trim() }
      .filter { it.isNotEmpty() }
      .distinct()
      .sorted()

  companion object {
    private const val DEVICE_AUTH_SCOPE = "identity.device-auth"
    private const val DEVICE_AUTH_KEY = "default"
  }
}
