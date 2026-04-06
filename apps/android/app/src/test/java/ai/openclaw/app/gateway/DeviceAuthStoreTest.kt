package ai.openclaw.app.gateway

import ai.openclaw.app.SecurePrefs
import android.content.Context
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import java.util.UUID

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class DeviceAuthStoreTest {
  @Test
  fun saveTokenPersistsNormalizedScopesMetadata() {
    val app = RuntimeEnvironment.getApplication()
    val securePrefs =
      app.getSharedPreferences(
        "openclaw.node.secure.test.${UUID.randomUUID()}",
        Context.MODE_PRIVATE,
      )
    val prefs = SecurePrefs(app, securePrefsOverride = securePrefs)
    val store = DeviceAuthStore(prefs)

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
  }

  @Test
  fun loadEntryReadsLegacyTokenWithoutMetadata() {
    val app = RuntimeEnvironment.getApplication()
    val securePrefs =
      app.getSharedPreferences(
        "openclaw.node.secure.test.${UUID.randomUUID()}",
        Context.MODE_PRIVATE,
      )
    val prefs = SecurePrefs(app, securePrefsOverride = securePrefs)
    prefs.putString("gateway.deviceToken.device-1.operator", "legacy-token")
    val store = DeviceAuthStore(prefs)

    val entry = store.loadEntry("device-1", "operator")
    assertNotNull(entry)
    assertEquals("legacy-token", entry?.token)
    assertEquals("operator", entry?.role)
    assertEquals(emptyList<String>(), entry?.scopes)
    assertEquals(0L, entry?.updatedAtMs)
  }
}
