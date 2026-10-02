package ai.openclaw.app.gateway

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class GatewayReconnectPolicyTest {
  @Test
  fun bootstrapNodePairingRequiredKeepsReconnectActive() {
    val error =
      GatewaySession.ErrorShape(
        code = "NOT_PAIRED",
        message = "pairing required",
        details =
          GatewayErrorDetails(
            code = "PAIRING_REQUIRED",
            canRetryWithDeviceToken = false,
            recommendedNextStep = "wait_then_retry",
            pauseReconnect = false,
            reason = "not-paired",
          ),
      )

    assertFalse(
      shouldPauseGatewayReconnectAfterAuthFailure(
        error = error,
        hasBootstrapToken = true,
        role = "node",
        scopes = emptyList(),
        pendingDeviceTokenRetry = false,
      ),
    )
  }

  @Test
  fun bootstrapNodePairingRequiredWithoutRetryHintPausesReconnect() {
    val error =
      GatewaySession.ErrorShape(
        code = "NOT_PAIRED",
        message = "pairing required",
        details =
          GatewayErrorDetails(
            code = "PAIRING_REQUIRED",
            canRetryWithDeviceToken = false,
            recommendedNextStep = null,
            reason = "not-paired",
          ),
      )

    assertTrue(
      shouldPauseGatewayReconnectAfterAuthFailure(
        error = error,
        hasBootstrapToken = true,
        role = "node",
        scopes = emptyList(),
        pendingDeviceTokenRetry = false,
      ),
    )
  }

  @Test
  fun nonBootstrapPairingRequiredStillPausesReconnect() {
    val error =
      GatewaySession.ErrorShape(
        code = "NOT_PAIRED",
        message = "pairing required",
        details =
          GatewayErrorDetails(
            code = "PAIRING_REQUIRED",
            canRetryWithDeviceToken = false,
            recommendedNextStep = "wait_then_retry",
            reason = "not-paired",
          ),
      )

    assertTrue(
      shouldPauseGatewayReconnectAfterAuthFailure(
        error = error,
        hasBootstrapToken = false,
        role = "node",
        scopes = emptyList(),
        pendingDeviceTokenRetry = false,
      ),
    )
  }

  @Test
  fun tokenFailuresPauseUnlessOneDeviceTokenRetryIsPending() {
    val cases =
      listOf(
        Triple("AUTH_TOKEN_MISMATCH", false, true),
        Triple("AUTH_TOKEN_MISMATCH", true, false),
        Triple("AUTH_DEVICE_TOKEN_MISMATCH", false, true),
        Triple("AUTH_TOKEN_NOT_CONFIGURED", false, true),
        Triple("AUTH_PASSWORD_MISSING", false, true),
        Triple("AUTH_PASSWORD_NOT_CONFIGURED", false, true),
        Triple("AUTH_SCOPE_MISMATCH", false, true),
        Triple("AUTH_VERIFIED_USER_REQUIRED", false, true),
      )

    for ((code, pendingDeviceTokenRetry, expected) in cases) {
      val error =
        GatewaySession.ErrorShape(
          code = "INVALID_REQUEST",
          message = "authentication failed",
          details =
            GatewayErrorDetails(
              code = code,
              canRetryWithDeviceToken = false,
              recommendedNextStep = null,
            ),
        )
      val actual =
        shouldPauseGatewayReconnectAfterAuthFailure(
          error = error,
          hasBootstrapToken = false,
          role = "operator",
          scopes = listOf("operator.read"),
          pendingDeviceTokenRetry = pendingDeviceTokenRetry,
        )

      assertEquals("$code pending=$pendingDeviceTokenRetry", expected, actual)
    }
  }

  @Test
  fun structuredRecoveryAdviceControlsReconnectPause() {
    val cases =
      listOf(
        Triple("wait_then_retry", false, false),
        Triple("retry_with_device_token", true, false),
        Triple("retry_with_device_token", false, true),
        Triple("update_auth_configuration", false, true),
        Triple("update_auth_credentials", false, true),
        Triple("review_auth_configuration", false, true),
      )

    for ((nextStep, pendingDeviceTokenRetry, expected) in cases) {
      val error =
        GatewaySession.ErrorShape(
          code = "INVALID_REQUEST",
          message = "authentication failed",
          details =
            GatewayErrorDetails(
              code = "AUTH_UNAUTHORIZED",
              canRetryWithDeviceToken = nextStep == "retry_with_device_token",
              recommendedNextStep = nextStep,
            ),
        )
      val actual =
        shouldPauseGatewayReconnectAfterAuthFailure(
          error = error,
          hasBootstrapToken = false,
          role = "operator",
          scopes = listOf("operator.read"),
          pendingDeviceTokenRetry = pendingDeviceTokenRetry,
        )

      assertEquals("$nextStep pending=$pendingDeviceTokenRetry", expected, actual)
    }
  }

  @Test
  fun authRateLimitPausesDespiteRetryAdvice() {
    val error =
      GatewaySession.ErrorShape(
        code = "INVALID_REQUEST",
        message = "authentication rate limited",
        details =
          GatewayErrorDetails(
            code = "AUTH_RATE_LIMITED",
            canRetryWithDeviceToken = false,
            recommendedNextStep = "wait_then_retry",
          ),
      )

    assertTrue(
      shouldPauseGatewayReconnectAfterAuthFailure(
        error = error,
        hasBootstrapToken = false,
        role = "operator",
        scopes = listOf("operator.read"),
        pendingDeviceTokenRetry = false,
      ),
    )
  }

  @Test
  fun protocolMismatchPausesReconnect() {
    val error =
      GatewaySession.ErrorShape(
        code = "INVALID_REQUEST",
        message = "protocol mismatch",
        details =
          GatewayErrorDetails(
            code = "PROTOCOL_MISMATCH",
            canRetryWithDeviceToken = false,
            recommendedNextStep = null,
            clientMinProtocol = 4,
            clientMaxProtocol = 4,
            expectedProtocol = 5,
            minimumProbeProtocol = 4,
          ),
      )

    assertTrue(
      shouldPauseGatewayReconnectAfterAuthFailure(
        error = error,
        hasBootstrapToken = false,
        role = "node",
        scopes = emptyList(),
        pendingDeviceTokenRetry = false,
      ),
    )
  }

  @Test
  fun bootstrapRoleUpgradeStillPausesReconnect() {
    val error =
      GatewaySession.ErrorShape(
        code = "NOT_PAIRED",
        message = "pairing required",
        details =
          GatewayErrorDetails(
            code = "PAIRING_REQUIRED",
            canRetryWithDeviceToken = false,
            recommendedNextStep = null,
            reason = "role-upgrade",
          ),
      )

    assertTrue(
      shouldPauseGatewayReconnectAfterAuthFailure(
        error = error,
        hasBootstrapToken = true,
        role = "node",
        scopes = emptyList(),
        pendingDeviceTokenRetry = false,
      ),
    )
  }
}
