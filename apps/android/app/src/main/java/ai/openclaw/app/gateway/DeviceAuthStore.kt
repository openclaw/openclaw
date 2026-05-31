package ai.openclaw.app.gateway

import ai.openclaw.app.SecurePrefs
import android.content.Context
import kotlinx.serialization.Serializable
import kotlinx.serialization.decodeFromString
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json

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

private const val deviceAuthTokenPrefix = "gateway.deviceToken."
private const val deviceAuthMetadataPrefix = "gateway.deviceTokenMeta."
private const val sqliteSecurePrefsTokenMarker = "__openclaw_secure_prefs__"

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

internal interface DeviceAuthStateStore {
  fun readDeviceAuthToken(
    deviceId: String,
    role: String,
  ): OpenClawSQLiteDeviceAuthTokenRow?

  fun readLatestDeviceAuthDeviceId(): String?

  fun upsertDeviceAuthToken(row: OpenClawSQLiteDeviceAuthTokenRow)

  fun deleteDeviceAuthToken(
    deviceId: String,
    role: String,
  )

  fun deleteAllDeviceAuthTokens()
}

private class OpenClawSQLiteDeviceAuthStateStore(
  private val store: OpenClawSQLiteStateStore,
) : DeviceAuthStateStore {
  override fun readDeviceAuthToken(
    deviceId: String,
    role: String,
  ): OpenClawSQLiteDeviceAuthTokenRow? = store.readDeviceAuthToken(deviceId, role)

  override fun readLatestDeviceAuthDeviceId(): String? = store.readLatestDeviceAuthDeviceId()

  override fun upsertDeviceAuthToken(row: OpenClawSQLiteDeviceAuthTokenRow) {
    store.upsertDeviceAuthToken(row)
  }

  override fun deleteDeviceAuthToken(
    deviceId: String,
    role: String,
  ) {
    store.deleteDeviceAuthToken(deviceId, role)
  }

  override fun deleteAllDeviceAuthTokens() {
    store.deleteAllDeviceAuthTokens()
  }
}

class DeviceAuthStore private constructor(
  private val context: Context,
  private val legacyPrefsOverride: SecurePrefs? = null,
  private val stateStore: DeviceAuthStateStore,
) : DeviceAuthTokenStore {
  constructor(
    context: Context,
    legacyPrefsOverride: SecurePrefs? = null,
  ) : this(
    context = context,
    legacyPrefsOverride = legacyPrefsOverride,
    stateStore = OpenClawSQLiteDeviceAuthStateStore(OpenClawSQLiteStateStore(context)),
  )

  internal companion object {
    fun createForTesting(
      context: Context,
      legacyPrefsOverride: SecurePrefs? = null,
      stateStoreOverride: DeviceAuthStateStore,
    ): DeviceAuthStore =
      DeviceAuthStore(
        context = context,
        legacyPrefsOverride = legacyPrefsOverride,
        stateStore = stateStoreOverride,
      )
  }

  private val json = Json { ignoreUnknownKeys = true }
  private val legacyPrefs by lazy { legacyPrefsOverride ?: SecurePrefs(context) }

  override fun loadEntry(
    deviceId: String,
    role: String,
  ): DeviceAuthEntry? {
    val normalizedDevice = normalizeDeviceId(deviceId)
    val normalizedRole = normalizeRole(role)
    val row =
      stateStore.readDeviceAuthToken(normalizedDevice, normalizedRole)
        ?: return migrateLegacyEntryIfNoSqliteAuthRows(normalizedDevice, normalizedRole)
    val token =
      legacyPrefs
        .getString(tokenKey(normalizedDevice, normalizedRole))
        ?.trim()
        ?.takeIf { it.isNotEmpty() }
        ?: row.token.trim().takeIf { it.isNotEmpty() && it != sqliteSecurePrefsTokenMarker }?.also {
          legacyPrefs.putString(tokenKey(normalizedDevice, normalizedRole), it)
          stateStore.upsertDeviceAuthToken(row.copy(token = sqliteSecurePrefsTokenMarker))
        }
        ?: return null
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
    val shouldSeedSameDeviceLegacyRoles = latestDeviceId == null
    val sqliteDeviceChanged = latestDeviceId != null && latestDeviceId != normalizedDevice
    val shouldDropLegacyAuth =
      sqliteDeviceChanged ||
        legacyPrefs.keysWithPrefix(deviceAuthTokenPrefix).any {
          !it.startsWith(tokenKeyPrefix(normalizedDevice))
        }
    if (sqliteDeviceChanged) {
      stateStore.deleteAllDeviceAuthTokens()
    }
    if (shouldDropLegacyAuth) {
      removeForeignLegacyEntries(normalizedDevice)
    }
    if (shouldSeedSameDeviceLegacyRoles) {
      migrateLegacyEntriesForDevice(normalizedDevice)
    }
    legacyPrefs.putString(tokenKey(normalizedDevice, normalizedRole), token.trim())
    removeLegacyMetadata(normalizedDevice, normalizedRole)
    stateStore.upsertDeviceAuthToken(
      OpenClawSQLiteDeviceAuthTokenRow(
        deviceId = normalizedDevice,
        role = normalizedRole,
        token = sqliteSecurePrefsTokenMarker,
        scopesJson = json.encodeToString(normalizedScopes),
        updatedAtMs = System.currentTimeMillis(),
      ),
    )
  }

  override fun clearToken(
    deviceId: String,
    role: String,
  ) {
    val normalizedDevice = normalizeDeviceId(deviceId)
    val normalizedRole = normalizeRole(role)
    removeLegacyEntry(normalizedDevice, normalizedRole)
    stateStore.deleteDeviceAuthToken(
      deviceId = normalizedDevice,
      role = normalizedRole,
    )
  }

  private fun migrateLegacyEntryIfNoSqliteAuthRows(
    normalizedDevice: String,
    normalizedRole: String,
  ): DeviceAuthEntry? {
    if (stateStore.readLatestDeviceAuthDeviceId() != null) {
      removeLegacyEntry(normalizedDevice, normalizedRole)
      return null
    }
    return migrateLegacyEntriesForDevice(normalizedDevice)[normalizedRole]
  }

  private fun migrateLegacyEntriesForDevice(normalizedDevice: String): Map<String, DeviceAuthEntry> {
    val prefix = tokenKeyPrefix(normalizedDevice)
    return legacyPrefs
      .keysWithPrefix(prefix)
      .mapNotNull { key ->
        val role = normalizeRole(key.removePrefix(prefix))
        if (role.isEmpty()) {
          null
        } else {
          migrateLegacyEntry(normalizedDevice, role)?.let { role to it }
        }
      }.toMap()
  }

  private fun migrateLegacyEntry(
    normalizedDevice: String,
    normalizedRole: String,
  ): DeviceAuthEntry? {
    val token =
      legacyPrefs
        .getString(tokenKey(normalizedDevice, normalizedRole))
        ?.trim()
        ?.takeIf { it.isNotEmpty() }
        ?: return null
    val metadata =
      legacyPrefs
        .getString(metadataKey(normalizedDevice, normalizedRole))
        ?.let { raw -> runCatching { json.decodeFromString<PersistedDeviceAuthMetadata>(raw) }.getOrNull() }
    val entry =
      DeviceAuthEntry(
        token = token,
        role = normalizedRole,
        scopes = normalizeScopes(metadata?.scopes ?: emptyList()),
        updatedAtMs = metadata?.updatedAtMs?.takeIf { it > 0L } ?: System.currentTimeMillis(),
      )
    val migrated =
      runCatching {
        stateStore.upsertDeviceAuthToken(
          OpenClawSQLiteDeviceAuthTokenRow(
            deviceId = normalizedDevice,
            role = normalizedRole,
            token = sqliteSecurePrefsTokenMarker,
            scopesJson = json.encodeToString(entry.scopes),
            updatedAtMs = entry.updatedAtMs,
          ),
        )
      }.isSuccess
    if (migrated) {
      legacyPrefs.putString(tokenKey(normalizedDevice, normalizedRole), entry.token)
      removeLegacyMetadata(normalizedDevice, normalizedRole)
    }
    return entry
  }

  private fun removeLegacyMetadata(
    normalizedDevice: String,
    normalizedRole: String,
  ) {
    legacyPrefs.remove(metadataKey(normalizedDevice, normalizedRole))
  }

  private fun removeLegacyEntry(
    normalizedDevice: String,
    normalizedRole: String,
  ) {
    legacyPrefs.remove(tokenKey(normalizedDevice, normalizedRole))
    legacyPrefs.remove(metadataKey(normalizedDevice, normalizedRole))
  }

  private fun removeForeignLegacyEntries(normalizedDevice: String) {
    val currentTokenPrefix = tokenKeyPrefix(normalizedDevice)
    legacyPrefs
      .keysWithPrefix(deviceAuthTokenPrefix)
      .filterNot { it.startsWith(currentTokenPrefix) }
      .forEach { legacyPrefs.remove(it) }
    val currentMetadataPrefix = "$deviceAuthMetadataPrefix$normalizedDevice."
    legacyPrefs
      .keysWithPrefix(deviceAuthMetadataPrefix)
      .filterNot { it.startsWith(currentMetadataPrefix) }
      .forEach { legacyPrefs.remove(it) }
  }

  private fun tokenKeyPrefix(normalizedDevice: String): String = "$deviceAuthTokenPrefix$normalizedDevice."

  private fun tokenKey(
    normalizedDevice: String,
    normalizedRole: String,
  ): String = "${tokenKeyPrefix(normalizedDevice)}$normalizedRole"

  private fun metadataKey(
    normalizedDevice: String,
    normalizedRole: String,
  ): String = "$deviceAuthMetadataPrefix$normalizedDevice.$normalizedRole"

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
