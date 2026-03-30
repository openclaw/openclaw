package ai.openclaw.app

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class GatewayBootstrapAuthTest {
  @Test
  fun detectsBootstrapOnlyGatewayAuth() {
    assertTrue(isBootstrapOnlyGatewayAuth(token = "", bootstrapToken = "bootstrap-1", password = ""))
    assertTrue(isBootstrapOnlyGatewayAuth(token = null, bootstrapToken = "bootstrap-1", password = null))
  }

  @Test
  fun rejectsBootstrapOnlyGatewayAuthWhenSharedCredentialsExist() {
    assertFalse(isBootstrapOnlyGatewayAuth(token = "shared-token", bootstrapToken = "bootstrap-1", password = null))
    assertFalse(isBootstrapOnlyGatewayAuth(token = null, bootstrapToken = "bootstrap-1", password = "shared-password"))
    assertFalse(isBootstrapOnlyGatewayAuth(token = null, bootstrapToken = "", password = null))
  }
}
