package ai.openclaw.app

import android.content.Context
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment

@RunWith(RobolectricTestRunner::class)
class SecurePrefsTest {
  @Test
  fun loadLocationMode_preservesAlwaysValue() {
    val context = RuntimeEnvironment.getApplication()
    val plainPrefs = context.getSharedPreferences("openclaw.node", Context.MODE_PRIVATE)
    plainPrefs.edit().clear().putString("location.enabledMode", "always").commit()

    val prefs = SecurePrefs(context)

    assertEquals(LocationMode.Always, prefs.locationMode.value)
    assertEquals("always", plainPrefs.getString("location.enabledMode", null))
  }

  @Test
  fun saveGatewayBootstrapToken_persistsSeparatelyFromSharedToken() {
    val context = RuntimeEnvironment.getApplication()
    val securePrefs = context.getSharedPreferences("openclaw.node.secure.test", Context.MODE_PRIVATE)
    securePrefs.edit().clear().commit()
    val prefs = SecurePrefs(context, securePrefsOverride = securePrefs)

    prefs.setGatewayToken("shared-token")
    prefs.setGatewayBootstrapToken("bootstrap-token")

    assertEquals("shared-token", prefs.loadGatewayToken())
    assertEquals("bootstrap-token", prefs.loadGatewayBootstrapToken())
    assertEquals("bootstrap-token", prefs.gatewayBootstrapToken.value)
  }

  @Test
  fun clearGatewaySetupAuth_removesStoredGatewayAuth() {
    val context = RuntimeEnvironment.getApplication()
    val securePrefs = context.getSharedPreferences("openclaw.node.secure.test.clear", Context.MODE_PRIVATE)
    securePrefs.edit().clear().commit()
    val prefs = SecurePrefs(context, securePrefsOverride = securePrefs)

    prefs.setGatewayToken("shared-token")
    prefs.setGatewayBootstrapToken("bootstrap-token")
    prefs.setGatewayPassword("password-token")

    prefs.clearGatewaySetupAuth()

    assertEquals("", prefs.gatewayToken.value)
    assertEquals("", prefs.gatewayBootstrapToken.value)
    assertNull(prefs.loadGatewayToken())
    assertNull(prefs.loadGatewayBootstrapToken())
    assertNull(prefs.loadGatewayPassword())
  }

  @Test
  fun reconcilePendingAlwaysLocationUpgrade_restoresPreviousModeWhenBackgroundPermissionMissing() {
    val context = RuntimeEnvironment.getApplication()
    val plainPrefs = context.getSharedPreferences("openclaw.node", Context.MODE_PRIVATE)
    plainPrefs.edit().clear().putString("location.enabledMode", "whileUsing").commit()
    val prefs = SecurePrefs(context)
    prefs.beginPendingAlwaysLocationUpgrade(LocationMode.Off)

    val reconciled = prefs.reconcilePendingAlwaysLocationUpgrade()

    assertEquals(LocationMode.Off, reconciled)
    assertEquals(LocationMode.Off, prefs.locationMode.value)
    assertFalse(prefs.hasPendingAlwaysLocationUpgrade())
  }

  @Test
  fun beginPendingAlwaysLocationUpgrade_persistsPendingState() {
    val context = RuntimeEnvironment.getApplication()
    val plainPrefs = context.getSharedPreferences("openclaw.node", Context.MODE_PRIVATE)
    plainPrefs.edit().clear().putString("location.enabledMode", "whileUsing").commit()
    val prefs = SecurePrefs(context)
    prefs.beginPendingAlwaysLocationUpgrade(LocationMode.Off)

    assertEquals(LocationMode.WhileUsing, prefs.effectiveLocationMode())
    assertTrue(prefs.hasPendingAlwaysLocationUpgrade())
  }
}
