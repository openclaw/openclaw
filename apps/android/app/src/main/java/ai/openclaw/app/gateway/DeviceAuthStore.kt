package ai.openclaw.app.gateway

import android.content.Context
import kotlinx.serialization.decodeFromString
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json

data class DeviceAuthEntry(
  val token: String,
  val role: String,
  val scopes: List<String>,
  val updatedAtMs: Long,
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
  private val json = Json
  private val stateStore = OpenClawSQLiteStateStore(context)

  override fun loadEntry(
    deviceId: String,
    role: String,
  ): DeviceAuthEntry? {
    val normalizedDevice = normalizeDeviceId(deviceId)
    val normalizedRole = normalizeRole(role)
    val row = stateStore.readDeviceAuthToken(normalizedDevice, normalizedRole) ?: return null
    val token = row.token.trim().takeIf { it.isNotEmpty() } ?: return null
    return DeviceAuthEntry(
      token = token,
      role = normalizedRole,
      scopes = decodeScopes(row.scopesJson),
      updatedAtMs = row.updatedAtMs,
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
    val latestDeviceId = stateStore.readLatestDeviceAuthDeviceId()
    if (latestDeviceId != null && latestDeviceId != normalizedDevice) {
      stateStore.deleteAllDeviceAuthTokens()
    }
    stateStore.upsertDeviceAuthToken(
      OpenClawSQLiteDeviceAuthTokenRow(
        deviceId = normalizedDevice,
        role = normalizedRole,
        token = token.trim(),
        scopesJson = json.encodeToString(normalizedScopes),
        updatedAtMs = System.currentTimeMillis(),
      ),
    )
  }

  override fun clearToken(
    deviceId: String,
    role: String,
  ) {
    stateStore.deleteDeviceAuthToken(
      deviceId = normalizeDeviceId(deviceId),
      role = normalizeRole(role),
    )
  }

  private fun decodeScopes(raw: String): List<String> =
    runCatching { json.decodeFromString<List<String>>(raw) }
      .getOrDefault(emptyList())
      .let(::normalizeScopes)

  private fun normalizeDeviceId(deviceId: String): String = deviceId.trim().lowercase()

  private fun normalizeRole(role: String): String = role.trim().lowercase()

  private fun normalizeScopes(scopes: List<String>): List<String> =
    scopes
      .map { it.trim() }
      .filter { it.isNotEmpty() }
      .distinct()
      .sorted()
}
