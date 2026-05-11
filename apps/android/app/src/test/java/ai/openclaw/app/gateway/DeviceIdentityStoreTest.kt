package ai.openclaw.app.gateway

import android.database.sqlite.SQLiteDatabase
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import java.io.File

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class DeviceIdentityStoreTest {
  @Before
  fun resetState() {
    File(RuntimeEnvironment.getApplication().filesDir, "openclaw").deleteRecursively()
  }

  @Test
  fun loadOrCreatePersistsIdentityInSQLiteWithoutJsonSidecars() {
    val app = RuntimeEnvironment.getApplication()
    val store = DeviceIdentityStore(app)

    val first = store.loadOrCreate()
    val roundTripStore = DeviceIdentityStore(app)
    val second = roundTripStore.loadOrCreate()

    assertEquals(first.deviceId, second.deviceId)
    assertEquals(first.publicKeyRawBase64, second.publicKeyRawBase64)
    val signature = roundTripStore.signPayload("payload", second)
    assertNotNull(signature)
    assertTrue(roundTripStore.verifySelfSignature("payload", signature ?: "", second))
    assertFalse(File(app.filesDir, "openclaw/identity/device.json").exists())
    assertTrue(File(app.filesDir, "openclaw/state/openclaw.sqlite").exists())
    val persisted = readIdentityRow()
    assertNotNull(persisted)
    assertTrue(persisted?.contains("-----BEGIN PUBLIC KEY-----") == true)
    assertTrue(persisted?.contains("-----BEGIN PRIVATE KEY-----") == true)
  }

  @Test
  fun loadOrCreateReadsTypeScriptPemIdentitySchemaFromSQLite() {
    val app = RuntimeEnvironment.getApplication()
    val publicKeyPem =
      """
      -----BEGIN PUBLIC KEY-----
      MCowBQYDK2VwAyEAA6EHv/POEL4dcN0Y50vAmWfk1jCbpQ1fHdyGZBJVMbg=
      -----END PUBLIC KEY-----
      """.trimIndent()
    val privateKeyPem =
      """
      -----BEGIN PRIVATE KEY-----
      MC4CAQAwBQYDK2VwBCIEIAABAgMEBQYHCAkKCwwNDg8QERITFBUWFxgZGhscHR4f
      -----END PRIVATE KEY-----
      """.trimIndent()
    OpenClawSQLiteStateStore(app).writeDeviceIdentity(
      OpenClawSQLiteDeviceIdentityRow(
        deviceId = "56475aa75463474c0285df5dbf2bcab73da651358839e9b77481b2eab107708c",
        publicKeyPem = publicKeyPem,
        privateKeyPem = privateKeyPem,
        createdAtMs = 1_700_000_000_000L,
      ),
    )

    val identity = DeviceIdentityStore(app).loadOrCreate()

    assertEquals("56475aa75463474c0285df5dbf2bcab73da651358839e9b77481b2eab107708c", identity.deviceId)
    assertEquals("A6EHv/POEL4dcN0Y50vAmWfk1jCbpQ1fHdyGZBJVMbg=", identity.publicKeyRawBase64)
    assertEquals("MC4CAQAwBQYDK2VwBCIEIAABAgMEBQYHCAkKCwwNDg8QERITFBUWFxgZGhscHR4f", identity.privateKeyPkcs8Base64)
    assertEquals(1_700_000_000_000L, identity.createdAtMs)
  }

  @Test
  fun legacyJsonIdentityFailsClosedInsteadOfRotatingIdentity() {
    val app = RuntimeEnvironment.getApplication()
    val legacy = File(app.filesDir, "openclaw/identity/device.json")
    legacy.parentFile?.mkdirs()
    legacy.writeText("""{"deviceId":"legacy"}""", Charsets.UTF_8)

    try {
      DeviceIdentityStore(app).loadOrCreate()
      fail("Expected legacy JSON identity to block startup")
    } catch (error: IllegalStateException) {
      assertTrue(error.message?.contains("Run openclaw doctor --fix") == true)
    }

    assertFalse(File(app.filesDir, "openclaw/state/openclaw.sqlite").exists())
  }

  private fun readIdentityRow(): String? {
    val dbFile = File(RuntimeEnvironment.getApplication().filesDir, "openclaw/state/openclaw.sqlite")
    return SQLiteDatabase
      .openDatabase(dbFile.absolutePath, null, SQLiteDatabase.OPEN_READONLY)
      .use { db ->
        db
          .rawQuery(
            "SELECT public_key_pem, private_key_pem FROM device_identities WHERE identity_key = ?",
            arrayOf("default"),
          ).use { cursor ->
            if (cursor.moveToFirst()) "${cursor.getString(0)}\n${cursor.getString(1)}" else null
          }
      }
  }
}
