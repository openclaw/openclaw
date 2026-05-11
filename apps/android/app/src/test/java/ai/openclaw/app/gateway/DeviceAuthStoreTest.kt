package ai.openclaw.app.gateway

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
    val store = DeviceAuthStore(app)

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
    assertEquals("operator-token", row?.token)
    assertEquals("""["operator.read","operator.write"]""", row?.scopesJson)
  }

  @Test
  fun clearTokenUpdatesSQLiteStore() {
    val app = RuntimeEnvironment.getApplication()
    val store = DeviceAuthStore(app)
    store.saveToken("device-1", "operator", "operator-token", scopes = listOf("operator.read"))

    store.clearToken("device-1", "operator")

    assertNull(store.loadEntry("device-1", "operator"))
    assertNull(OpenClawSQLiteStateStore(app).readDeviceAuthToken("device-1", "operator"))
  }
}
