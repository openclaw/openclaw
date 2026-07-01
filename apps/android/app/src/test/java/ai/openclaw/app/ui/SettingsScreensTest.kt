package ai.openclaw.app.ui

import ai.openclaw.app.GatewayConnectionProblem
import org.junit.Assert.assertEquals
import org.junit.Test

class SettingsScreensTest {
  @Test
  fun androidDistributionChannelUsesBuildFlavorLabels() {
    assertEquals("Play", androidDistributionChannel("play"))
    assertEquals("Third-party", androidDistributionChannel("thirdParty"))
    assertEquals("Unknown", androidDistributionChannel(""))
  }

  @Test
  fun gatewayStatusLabelReportsWhichAuthRecoveryAppliesInsteadOfGenericLabel() {
    assertEquals(
      "Setup code expired",
      gatewayStatusLabel("auth error", isConnected = false, gatewayConnectionProblem = authProblem("AUTH_BOOTSTRAP_TOKEN_INVALID")),
    )
    assertEquals(
      "Gateway token needed",
      gatewayStatusLabel("authentication needed", isConnected = false, gatewayConnectionProblem = authProblem("AUTH_TOKEN_MISSING")),
    )
    assertEquals(
      "Saved auth invalid",
      gatewayStatusLabel("auth failed", isConnected = false, gatewayConnectionProblem = authProblem("AUTH_TOKEN_MISMATCH")),
    )
    assertEquals(
      "Device identity required",
      gatewayStatusLabel("auth failed", isConnected = false, gatewayConnectionProblem = authProblem("DEVICE_IDENTITY_REQUIRED")),
    )
  }

  @Test
  fun gatewayStatusLabelFallsBackToGenericAuthLabelWithoutAKnownReason() {
    assertEquals("Authentication needed", gatewayStatusLabel("auth failed", isConnected = false, gatewayConnectionProblem = null))
    assertEquals(
      "Authentication needed",
      gatewayStatusLabel("auth failed", isConnected = false, gatewayConnectionProblem = authProblem("SOME_UNMAPPED_CODE")),
    )
  }

  @Test
  fun gatewayStatusLabelLeavesUnrelatedStatesUnaffectedByConnectionProblem() {
    val problem = authProblem("AUTH_TOKEN_MISSING")
    assertEquals("Ready", gatewayStatusLabel("auth failed", isConnected = true, gatewayConnectionProblem = problem))
    assertEquals("Pairing needed", gatewayStatusLabel("Pairing in progress", isConnected = false, gatewayConnectionProblem = problem))
    assertEquals("Cannot reach gateway", gatewayStatusLabel("Connection failed", isConnected = false, gatewayConnectionProblem = problem))
  }

  private fun authProblem(code: String): GatewayConnectionProblem =
    GatewayConnectionProblem(
      code = code,
      message = "Authentication failed.",
      reason = null,
      requestId = null,
      recommendedNextStep = null,
      pauseReconnect = false,
      retryable = false,
    )
}
