package ai.openclaw.app.gateway

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class GatewaySessionScopeSelectionTest {
  @Test
  fun bootstrapConnectNodeSessionStillReusesStoredNodeToken() {
    val storedEntry =
      DeviceAuthEntry(
        token = "node-token",
        role = "node",
        scopes = emptyList(),
        updatedAtMs = 1L,
      )

    assertTrue(
      shouldUseStoredTokenForConnect(
        storedEntry = storedEntry,
        requestedScopes = listOf("node:invoke"),
        explicitBootstrapToken = "bootstrap-token",
        explicitPassword = null,
      ),
    )
  }

  @Test
  fun bootstrapUpgradeSkipsStoredTokenWhenRequestedScopesNeedAdmin() {
    val storedEntry =
      DeviceAuthEntry(
        token = "operator-token",
        role = "operator",
        scopes = listOf("operator.read", "operator.write", "operator.talk.secrets"),
        updatedAtMs = 1L,
      )

    assertFalse(
      shouldUseStoredTokenForConnect(
        storedEntry = storedEntry,
        requestedScopes = listOf("operator.admin"),
        explicitBootstrapToken = "bootstrap-token",
        explicitPassword = null,
      ),
    )
  }

  @Test
  fun storedAdminScopeSatisfiesOperatorSubscopes() {
    assertTrue(
      gatewayScopesSatisfyRequestedScopes(
        grantedScopes = listOf("operator.admin"),
        requestedScopes = listOf("operator.read", "operator.write", "operator.talk.secrets"),
      ),
    )
  }

  @Test
  fun storedAdminTokenCanStillBeReusedForAdminRequests() {
    val storedEntry =
      DeviceAuthEntry(
        token = "operator-admin-token",
        role = "operator",
        scopes = listOf("operator.admin"),
        updatedAtMs = 1L,
      )

    assertTrue(
      shouldUseStoredTokenForConnect(
        storedEntry = storedEntry,
        requestedScopes = listOf("operator.admin"),
        explicitBootstrapToken = "bootstrap-token",
        explicitPassword = null,
      ),
    )
  }
}
