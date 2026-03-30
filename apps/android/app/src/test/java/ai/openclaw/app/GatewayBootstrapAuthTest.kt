package ai.openclaw.app

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import java.util.UUID

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class GatewayBootstrapAuthTest {
  @Test
  fun connectsOperatorSessionWhenBootstrapAuthExists() {
    assertTrue(shouldConnectOperatorSession(token = "", bootstrapToken = "bootstrap-1", password = "", storedOperatorToken = ""))
    assertTrue(shouldConnectOperatorSession(token = null, bootstrapToken = "bootstrap-1", password = null, storedOperatorToken = null))
  }

  @Test
  fun skipsOperatorSessionOnlyWhenNoSharedBootstrapOrStoredAuthExists() {
    assertTrue(shouldConnectOperatorSession(token = "shared-token", bootstrapToken = "bootstrap-1", password = null, storedOperatorToken = null))
    assertTrue(shouldConnectOperatorSession(token = null, bootstrapToken = "bootstrap-1", password = "shared-password", storedOperatorToken = null))
    assertTrue(shouldConnectOperatorSession(token = null, bootstrapToken = null, password = null, storedOperatorToken = "stored-token"))
    assertFalse(shouldConnectOperatorSession(token = null, bootstrapToken = "", password = null, storedOperatorToken = null))
  }

  @Test
  fun resolveGatewayConnectAuth_prefersExplicitSetupAuthOverStoredPrefs() {
    val app = RuntimeEnvironment.getApplication()
    val securePrefs =
      app.getSharedPreferences(
        "openclaw.node.secure.test.${UUID.randomUUID()}",
        android.content.Context.MODE_PRIVATE,
      )
    val prefs = SecurePrefs(app, securePrefsOverride = securePrefs)
    prefs.setGatewayToken("stale-shared-token")
    prefs.setGatewayBootstrapToken("")
    prefs.setGatewayPassword("stale-password")
    val runtime = NodeRuntime(app, prefs)

    val auth =
      runtime.resolveGatewayConnectAuth(
        NodeRuntime.GatewayConnectAuth(
          token = null,
          bootstrapToken = "setup-bootstrap-token",
          password = null,
        ),
      )

    assertNull(auth.token)
    assertEquals("setup-bootstrap-token", auth.bootstrapToken)
    assertNull(auth.password)
  }
}
