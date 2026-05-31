package ai.openclaw.app.gateway

import ai.openclaw.app.SecurePrefs
import android.content.Context
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import java.io.File

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class DeviceAuthStoreTest {
  @Before
  fun resetState() {
    File(RuntimeEnvironment.getApplication().filesDir, "openclaw").deleteRecursively()
  }

  @Test
  fun saveTokenPersistsNormalizedScopesMetadataInSQLite() {
    val app = RuntimeEnvironment.getApplication()
    val store = DeviceAuthStore(app, legacyPrefsOverride = legacyPrefs(app))

    store.saveToken(
      deviceId = " Device-1 ",
      role = " Operator ",
      token = " operator-token ",
      scopes = listOf("operator.write", "operator.read", "operator.write", " "),
    )

    val entry = store.loadEntry("device-1", "operator")
    assertNotNull(entry)
    assertEquals("operator-token", entry?.token)
    assertEquals("operator", entry?.role)
    assertEquals(listOf("operator.read", "operator.write"), entry?.scopes)
    assertTrue((entry?.updatedAtMs ?: 0L) > 0L)
    val row = OpenClawSQLiteStateStore(app).readDeviceAuthToken("device-1", "operator")
    assertNotNull(row)
    assertEquals("__openclaw_secure_prefs__", row?.token)
    assertEquals("""["operator.read","operator.write"]""", row?.scopesJson)
  }

  @Test
  fun clearTokenUpdatesSQLiteStore() {
    val app = RuntimeEnvironment.getApplication()
    val store = DeviceAuthStore(app, legacyPrefsOverride = legacyPrefs(app))
    store.saveToken("device-1", "operator", "operator-token", scopes = listOf("operator.read"))

    store.clearToken("device-1", "operator")

    assertNull(store.loadEntry("device-1", "operator"))
    assertNull(OpenClawSQLiteStateStore(app).readDeviceAuthToken("device-1", "operator"))
  }

  @Test
  fun loadEntryMigratesLegacySecurePrefsToken() {
    val app = RuntimeEnvironment.getApplication()
    val prefs = legacyPrefs(app)
    prefs.putString("gateway.deviceToken.device-1.operator", " operator-token ")
    prefs.putString(
      "gateway.deviceTokenMeta.device-1.operator",
      """{"scopes":["operator.write"," operator.read ","operator.write"],"updatedAtMs":1700000000000}""",
    )

    val entry = DeviceAuthStore(app, legacyPrefsOverride = prefs).loadEntry(" Device-1 ", " Operator ")

    assertNotNull(entry)
    assertEquals("operator-token", entry?.token)
    assertEquals("operator", entry?.role)
    assertEquals(listOf("operator.read", "operator.write"), entry?.scopes)
    assertEquals(1700000000000L, entry?.updatedAtMs)
    assertEquals("operator-token", prefs.getString("gateway.deviceToken.device-1.operator"))
    assertNull(prefs.getString("gateway.deviceTokenMeta.device-1.operator"))
    assertEquals(
      "__openclaw_secure_prefs__",
      OpenClawSQLiteStateStore(app).readDeviceAuthToken("device-1", "operator")?.token,
    )
  }

  @Test
  fun loadEntryMigratesAllLegacyRolesBeforeSQLiteRowsExist() {
    val app = RuntimeEnvironment.getApplication()
    val prefs = legacyPrefs(app)
    prefs.putString("gateway.deviceToken.device-1.operator", " operator-token ")
    prefs.putString(
      "gateway.deviceTokenMeta.device-1.operator",
      """{"scopes":["operator.write"],"updatedAtMs":1700000000000}""",
    )
    prefs.putString("gateway.deviceToken.device-1.node", " node-token ")
    prefs.putString(
      "gateway.deviceTokenMeta.device-1.node",
      """{"scopes":["node.connect"],"updatedAtMs":1700000000001}""",
    )
    val store = DeviceAuthStore(app, legacyPrefsOverride = prefs)

    val operator = store.loadEntry("device-1", "operator")
    val node = store.loadEntry("device-1", "node")

    assertEquals("operator-token", operator?.token)
    assertEquals(listOf("operator.write"), operator?.scopes)
    assertEquals("node-token", node?.token)
    assertEquals(listOf("node.connect"), node?.scopes)
    assertEquals(
      "__openclaw_secure_prefs__",
      OpenClawSQLiteStateStore(app).readDeviceAuthToken("device-1", "operator")?.token,
    )
    assertEquals(
      "__openclaw_secure_prefs__",
      OpenClawSQLiteStateStore(app).readDeviceAuthToken("device-1", "node")?.token,
    )
  }

  @Test
  fun loadEntryDoesNotResurrectLegacyRoleAfterSQLiteRowsExist() {
    val app = RuntimeEnvironment.getApplication()
    val prefs = legacyPrefs(app)
    val store = DeviceAuthStore(app, legacyPrefsOverride = prefs)

    store.saveToken("device-1", "operator", "operator-token", scopes = listOf("operator.write"))
    prefs.putString("gateway.deviceToken.device-1.admin", " stale-admin-token ")
    prefs.putString(
      "gateway.deviceTokenMeta.device-1.admin",
      """{"scopes":["admin"],"updatedAtMs":1700000000000}""",
    )

    store.saveToken("device-1", "operator", "operator-token-2", scopes = listOf("operator.write"))

    assertNull(store.loadEntry("device-1", "admin"))
    assertNull(OpenClawSQLiteStateStore(app).readDeviceAuthToken("device-1", "admin"))
    assertNull(prefs.getString("gateway.deviceToken.device-1.admin"))
    assertNull(prefs.getString("gateway.deviceTokenMeta.device-1.admin"))
  }

  @Test
  fun saveTokenMigratesSameDeviceLegacyRolesBeforeFirstSqliteWrite() {
    val app = RuntimeEnvironment.getApplication()
    val prefs = legacyPrefs(app)
    prefs.putString("gateway.deviceToken.device-1.operator", " old-operator-token ")
    prefs.putString("gateway.deviceToken.device-1.node", " node-token ")
    prefs.putString(
      "gateway.deviceTokenMeta.device-1.node",
      """{"scopes":["node.connect"],"updatedAtMs":1700000000001}""",
    )
    val store = DeviceAuthStore(app, legacyPrefsOverride = prefs)

    store.saveToken("device-1", "operator", "operator-token", scopes = listOf("operator.write"))

    assertEquals("operator-token", store.loadEntry("device-1", "operator")?.token)
    assertEquals("node-token", store.loadEntry("device-1", "node")?.token)
    assertEquals(
      "__openclaw_secure_prefs__",
      OpenClawSQLiteStateStore(app).readDeviceAuthToken("device-1", "node")?.token,
    )
    assertNull(prefs.getString("gateway.deviceTokenMeta.device-1.node"))
  }

  @Test
  fun loadEntryReturnsLegacySecurePrefsTokenWhenSQLiteMigrationFails() {
    val app = RuntimeEnvironment.getApplication()
    val prefs = legacyPrefs(app)
    val metadata = """{"scopes":["operator.read"],"updatedAtMs":1700000000000}"""
    prefs.putString("gateway.deviceToken.device-1.operator", " operator-token ")
    prefs.putString("gateway.deviceTokenMeta.device-1.operator", metadata)

    val store =
      DeviceAuthStore.createForTesting(
        context = app,
        legacyPrefsOverride = prefs,
        stateStoreOverride = ThrowingDeviceAuthStateStore(),
      )
    val entry = store.loadEntry("device-1", "operator")

    assertEquals("operator-token", entry?.token)
    assertEquals(listOf("operator.read"), entry?.scopes)
    assertEquals(1700000000000L, entry?.updatedAtMs)
    assertEquals(" operator-token ", prefs.getString("gateway.deviceToken.device-1.operator"))
    assertEquals(metadata, prefs.getString("gateway.deviceTokenMeta.device-1.operator"))
  }

  @Test
  fun loadEntryMovesPlaintextSqliteTokenBackToSecurePrefs() {
    val app = RuntimeEnvironment.getApplication()
    val prefs = legacyPrefs(app)
    OpenClawSQLiteStateStore(app).upsertDeviceAuthToken(
      OpenClawSQLiteDeviceAuthTokenRow(
        deviceId = "device-1",
        role = "operator",
        token = "operator-token",
        scopesJson = """["operator.read"]""",
        updatedAtMs = 1700000000000,
      ),
    )

    val entry = DeviceAuthStore(app, legacyPrefsOverride = prefs).loadEntry("device-1", "operator")

    assertEquals("operator-token", entry?.token)
    assertEquals("operator-token", prefs.getString("gateway.deviceToken.device-1.operator"))
    assertEquals(
      "__openclaw_secure_prefs__",
      OpenClawSQLiteStateStore(app).readDeviceAuthToken("device-1", "operator")?.token,
    )
  }

  @Test
  fun saveTokenForDifferentDevicePurgesStaleLegacySecurePrefsTokens() {
    val app = RuntimeEnvironment.getApplication()
    val prefs = legacyPrefs(app)
    prefs.putString("gateway.deviceToken.device-1.operator", " stale-token ")
    prefs.putString(
      "gateway.deviceTokenMeta.device-1.operator",
      """{"scopes":["operator.read"],"updatedAtMs":1700000000000}""",
    )
    val store = DeviceAuthStore(app, legacyPrefsOverride = prefs)

    store.saveToken("device-2", "operator", "fresh-token", scopes = listOf("operator.write"))

    assertNull(store.loadEntry("device-1", "operator"))
    assertNull(prefs.getString("gateway.deviceToken.device-1.operator"))
    assertNull(prefs.getString("gateway.deviceTokenMeta.device-1.operator"))
    assertEquals("fresh-token", store.loadEntry("device-2", "operator")?.token)
    assertEquals("fresh-token", prefs.getString("gateway.deviceToken.device-2.operator"))
    assertEquals(
      "__openclaw_secure_prefs__",
      OpenClawSQLiteStateStore(app).readDeviceAuthToken("device-2", "operator")?.token,
    )
  }

  @Test
  fun saveTokenPrunesForeignLegacyTokensWithoutOrphaningCurrentSqliteRows() {
    val app = RuntimeEnvironment.getApplication()
    val prefs = legacyPrefs(app)
    prefs.putString("gateway.deviceToken.device-1.operator", " operator-token ")
    prefs.putString("gateway.deviceToken.device-1.node", " node-token ")
    prefs.putString("gateway.deviceToken.device-2.operator", " stale-token ")
    val sqlite = OpenClawSQLiteStateStore(app)
    sqlite.upsertDeviceAuthToken(
      OpenClawSQLiteDeviceAuthTokenRow(
        deviceId = "device-1",
        role = "operator",
        token = "__openclaw_secure_prefs__",
        scopesJson = """["operator.read"]""",
        updatedAtMs = 1700000000000,
      ),
    )
    sqlite.upsertDeviceAuthToken(
      OpenClawSQLiteDeviceAuthTokenRow(
        deviceId = "device-1",
        role = "node",
        token = "__openclaw_secure_prefs__",
        scopesJson = """["node.connect"]""",
        updatedAtMs = 1700000000001,
      ),
    )
    val store = DeviceAuthStore(app, legacyPrefsOverride = prefs)

    store.saveToken("device-1", "operator", "operator-token-2", scopes = listOf("operator.write"))

    assertEquals("operator-token-2", store.loadEntry("device-1", "operator")?.token)
    assertEquals("node-token", store.loadEntry("device-1", "node")?.token)
    assertNull(prefs.getString("gateway.deviceToken.device-2.operator"))
  }

  private fun legacyPrefs(context: Context): SecurePrefs {
    val prefs = context.getSharedPreferences("openclaw.node.secure.test", Context.MODE_PRIVATE)
    prefs.edit().clear().commit()
    return SecurePrefs(context, securePrefsOverride = prefs)
  }

  private class ThrowingDeviceAuthStateStore : DeviceAuthStateStore {
    override fun readDeviceAuthToken(
      deviceId: String,
      role: String,
    ): OpenClawSQLiteDeviceAuthTokenRow? = null

    override fun readLatestDeviceAuthDeviceId(): String? = null

    override fun upsertDeviceAuthToken(row: OpenClawSQLiteDeviceAuthTokenRow) {
      error("sqlite unavailable")
    }

    override fun deleteDeviceAuthToken(
      deviceId: String,
      role: String,
    ) = Unit

    override fun deleteAllDeviceAuthTokens() = Unit
  }
}
