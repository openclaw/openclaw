package ai.openclaw.app

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

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
}
