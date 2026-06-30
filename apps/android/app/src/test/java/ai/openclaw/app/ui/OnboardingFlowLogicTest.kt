package ai.openclaw.app.ui

import ai.openclaw.app.GatewayConnectionProblem
import ai.openclaw.app.GatewayNodeApprovalState
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.Base64

class OnboardingFlowLogicTest {
  @Test
  fun blocksFinishWhenOnlyOperatorIsConnected() {
    assertFalse(canFinishOnboarding(isConnected = true, isNodeConnected = false, nodeCapabilityApprovalState = GatewayNodeApprovalState.Approved))
  }

  @Test
  fun blocksFinishWhenDisconnected() {
    assertFalse(canFinishOnboarding(isConnected = false, isNodeConnected = false, nodeCapabilityApprovalState = GatewayNodeApprovalState.Approved))
  }

  @Test
  fun blocksFinishWhenOnlyNodeIsConnected() {
    assertFalse(canFinishOnboarding(isConnected = false, isNodeConnected = true, nodeCapabilityApprovalState = GatewayNodeApprovalState.Approved))
  }

  @Test
  fun blocksFinishWhenNodeCapabilityApprovalIsPending() {
    assertFalse(canFinishOnboarding(isConnected = true, isNodeConnected = true, nodeCapabilityApprovalState = GatewayNodeApprovalState.PendingApproval))
    assertFalse(canFinishOnboarding(isConnected = true, isNodeConnected = true, nodeCapabilityApprovalState = GatewayNodeApprovalState.PendingReapproval))
    assertFalse(canFinishOnboarding(isConnected = true, isNodeConnected = true, nodeCapabilityApprovalState = GatewayNodeApprovalState.Unapproved))
  }

  @Test
  fun allowsFinishWhenOperatorNodeAndCapabilityApprovalAreReady() {
    assertTrue(canFinishOnboarding(isConnected = true, isNodeConnected = true, nodeCapabilityApprovalState = GatewayNodeApprovalState.Approved))
  }

  @Test
  fun blocksFinishWhileDelayedNodeListResolvesPendingApproval() =
    runTest {
      val delayedNodeList = CompletableDeferred<GatewayNodeApprovalState>()
      var approvalState = GatewayNodeApprovalState.Loading
      val refresh = launch { approvalState = delayedNodeList.await() }

      assertFalse(canFinishOnboarding(isConnected = true, isNodeConnected = true, nodeCapabilityApprovalState = approvalState))

      delayedNodeList.complete(GatewayNodeApprovalState.PendingApproval)
      refresh.join()
      assertFalse(canFinishOnboarding(isConnected = true, isNodeConnected = true, nodeCapabilityApprovalState = approvalState))
    }

  @Test
  fun allowsFinishWhenSuccessfulLegacyNodeListOmitsApprovalState() {
    assertTrue(canFinishOnboarding(isConnected = true, isNodeConnected = true, nodeCapabilityApprovalState = GatewayNodeApprovalState.Unsupported))
  }

  @Test
  fun nearbyGatewayFoundStateCanOnlyPrefillEndpoint() {
    assertEquals(
      NearbyGatewayUiState(
        subtitle = "Studio Gateway found. Use it to fill host and port, then scan or paste a setup code.",
        status = "Endpoint",
        canUseEndpoint = true,
      ),
      nearbyGatewayUiState(nearbyGatewayName = "Studio Gateway", discoveryStatusText = "Searching…", discoveryStarted = false),
    )
  }

  @Test
  fun nearbyGatewayBeforeDiscoveryStartsIsNotConnectable() {
    assertEquals(
      NearbyGatewayUiState(subtitle = "Starting discovery...", status = "Starting", canUseEndpoint = false),
      nearbyGatewayUiState(nearbyGatewayName = null, discoveryStatusText = "Searching…", discoveryStarted = false, searchTimedOut = true),
    )
  }

  @Test
  fun nearbyGatewaySearchingStateIsNotConnectable() {
    assertEquals(
      NearbyGatewayUiState(subtitle = "Searching for gateways...", status = "Searching", canUseEndpoint = false),
      nearbyGatewayUiState(nearbyGatewayName = null, discoveryStatusText = "Searching for gateways…"),
    )
  }

  @Test
  fun nearbyGatewayTimedOutSearchShowsEmptyState() {
    assertEquals(
      NearbyGatewayUiState(subtitle = "No gateway found", status = "Not found", canUseEndpoint = false),
      nearbyGatewayUiState(nearbyGatewayName = null, discoveryStatusText = "Searching for gateways…", searchTimedOut = true),
    )
  }

  @Test
  fun nearbyGatewayEmptyResultStateIsNotConnectable() {
    assertEquals(
      NearbyGatewayUiState(subtitle = "No gateway found", status = "Not found", canUseEndpoint = false),
      nearbyGatewayUiState(nearbyGatewayName = null, discoveryStatusText = "Local: 0 • Wide: 0"),
    )
  }

  @Test
  fun setupCodeUiShowsScannedCodeReadyToPair() {
    val setupCode =
      encodeSetupCode("""{"url":"wss://gateway.example:18789","bootstrapToken":"bootstrap-1"}""")

    assertEquals(
      SetupCodePairingUiState(
        subtitle = "Setup code ready. Pair with Gateway will use this code for the authenticated bootstrap handoff.",
        status = "Ready",
        canPair = true,
      ),
      setupCodePairingUiState(setupCode),
    )
  }

  @Test
  fun onboardingScannedSetupCodeResolvesBootstrapPairingConfig() {
    val setupCode =
      encodeSetupCode("""{"url":"wss://gateway.example:18789","bootstrapToken":"bootstrap-1"}""")

    val resolved =
      resolveOnboardingGatewayConfig(
        setupCode = setupCode,
        manualHost = "",
        manualPort = "",
        manualTls = true,
        token = "stale-token",
        password = "stale-password",
      )

    assertEquals("gateway.example", resolved?.host)
    assertEquals(18789, resolved?.port)
    assertEquals("bootstrap-1", resolved?.bootstrapToken)
    assertEquals("", resolved?.token)
    assertEquals("", resolved?.password)
  }

  @Test
  fun onboardingPastedQrJsonResolvesInnerSetupCode() {
    val setupCode =
      encodeSetupCode("""{"url":"wss://gateway.example:18789","bootstrapToken":"bootstrap-1"}""")
    val qrJson = """{"setupCode":"$setupCode","gatewayUrl":"wss://gateway.example:18789"}"""

    val resolved =
      resolveOnboardingGatewayConfig(
        setupCode = qrJson,
        manualHost = "",
        manualPort = "",
        manualTls = true,
        token = "",
        password = "",
      )

    assertEquals("gateway.example", resolved?.host)
    assertEquals("bootstrap-1", resolved?.bootstrapToken)
  }

  @Test
  fun onboardingManualEndpointWithoutAuthCannotPair() {
    val resolved =
      resolveOnboardingGatewayConfig(
        setupCode = "",
        manualHost = "192.168.1.20",
        manualPort = "18789",
        manualTls = false,
        token = "",
        password = "",
      )

    assertNull(resolved)
    assertEquals(
      "Scan or paste a setup code. Manual endpoint is for recovery and still needs a token or password when no setup code is available.",
      gatewayOnboardingValidationMessage(""),
    )
  }

  @Test
  fun onboardingManualEndpointWithTokenCanPair() {
    val resolved =
      resolveOnboardingGatewayConfig(
        setupCode = "",
        manualHost = "192.168.1.20",
        manualPort = "18789",
        manualTls = false,
        token = "shared-token",
        password = "",
      )

    assertEquals("192.168.1.20", resolved?.host)
    assertEquals(18789, resolved?.port)
    assertEquals("shared-token", resolved?.token)
  }

  @Test
  fun recoveryGatewayNamePrefersServerThenAttemptedGateway() {
    assertEquals("Server Gateway", recoveryGatewayName(serverName = "Server Gateway", attemptedGatewayName = "Discovered Gateway"))
    assertEquals("Discovered Gateway", recoveryGatewayName(serverName = null, attemptedGatewayName = "Discovered Gateway"))
    assertEquals("Home Gateway", recoveryGatewayName(serverName = " ", attemptedGatewayName = " "))
  }

  @Test
  fun showsPairingStateForPairingRequiredGatewayStatus() {
    assertEquals(
      GatewayRecoveryUiState.Pairing,
      gatewayRecoveryUiState(
        ready = false,
        statusText = "Gateway error: pairing required; approval in progress",
        connectSettling = false,
        nodeCapabilityApprovalState = GatewayNodeApprovalState.Approved,
      ),
    )
  }

  @Test
  fun showsConnectedStateWhenGatewayBecomesReady() {
    assertEquals(
      GatewayRecoveryUiState.Connected,
      gatewayRecoveryUiState(
        ready = true,
        statusText = "Gateway error: pairing required",
        connectSettling = false,
        nodeCapabilityApprovalState = GatewayNodeApprovalState.Approved,
      ),
    )
  }

  @Test
  fun showsNodeApprovalStateWhenCapabilityApprovalIsPending() {
    assertEquals(
      GatewayRecoveryUiState.NodeCapabilityApprovalPending,
      gatewayRecoveryUiState(
        ready = false,
        statusText = "Connected",
        connectSettling = false,
        nodeCapabilityApprovalState = GatewayNodeApprovalState.PendingApproval,
      ),
    )
  }

  @Test
  fun showsFinishingStateWhileNodeApprovalLoads() {
    assertEquals(
      GatewayRecoveryUiState.Finishing,
      gatewayRecoveryUiState(
        ready = false,
        statusText = "Connected",
        connectSettling = false,
        nodeCapabilityApprovalState = GatewayNodeApprovalState.Loading,
      ),
    )
  }

  @Test
  fun authMissingProblemAsksForSetupCodeBeforeNodeApprovalLoading() {
    val problem =
      GatewayConnectionProblem(
        code = "AUTH_TOKEN_MISSING",
        message = "Gateway token required",
        reason = "token_missing",
        requestId = null,
        recommendedNextStep = null,
        pauseReconnect = true,
        retryable = false,
      )

    assertEquals(
      GatewayRecoveryUiState.SetupCodeRequired,
      gatewayRecoveryUiState(
        ready = false,
        statusText = "Gateway paired. Checking node capability approval.",
        connectSettling = false,
        nodeCapabilityApprovalState = GatewayNodeApprovalState.Loading,
        gatewayConnectionProblem = problem,
      ),
    )
    assertEquals(
      "This endpoint was reached without valid setup auth. Scan or paste a setup code before pairing.",
      recoveryGatewayDetail(
        ready = false,
        remoteAddress = null,
        statusText = "Gateway paired. Checking node capability approval.",
        nodeCapabilityApprovalState = GatewayNodeApprovalState.Loading,
        gatewayConnectionProblem = problem,
      ),
    )
  }

  @Test
  fun invalidBootstrapProblemAsksForFreshSetupCode() {
    val problem =
      GatewayConnectionProblem(
        code = "AUTH_BOOTSTRAP_TOKEN_INVALID",
        message = "bootstrap token invalid",
        reason = "bootstrap_token_invalid",
        requestId = null,
        recommendedNextStep = null,
        pauseReconnect = true,
        retryable = false,
      )

    assertEquals(
      GatewayRecoveryUiState.SetupCodeExpired,
      gatewayRecoveryUiState(
        ready = false,
        statusText = "Connecting…",
        connectSettling = false,
        nodeCapabilityApprovalState = GatewayNodeApprovalState.Approved,
        gatewayConnectionProblem = problem,
      ),
    )
    assertEquals(
      "Setup auth was rejected or expired. Generate a fresh setup code, scan or paste it here, then pair again.",
      recoveryGatewayDetail(
        ready = false,
        remoteAddress = null,
        statusText = "Connecting…",
        nodeCapabilityApprovalState = GatewayNodeApprovalState.Approved,
        gatewayConnectionProblem = problem,
      ),
    )
  }

  @Test
  fun showsApprovalRequiredForPausedPairingProblem() {
    assertEquals(
      GatewayRecoveryUiState.ApprovalRequired,
      gatewayRecoveryUiState(
        ready = false,
        statusText = "Connecting…",
        connectSettling = false,
        nodeCapabilityApprovalState = GatewayNodeApprovalState.Approved,
        gatewayConnectionProblem =
          GatewayConnectionProblem(
            code = "PAIRING_REQUIRED",
            message = "pairing required: device approval is required",
            reason = "not-paired",
            requestId = "request-1",
            recommendedNextStep = null,
            pauseReconnect = true,
            retryable = false,
          ),
      ),
    )
  }

  @Test
  fun showsPairingForRetryablePairingProblem() {
    assertEquals(
      GatewayRecoveryUiState.Pairing,
      gatewayRecoveryUiState(
        ready = false,
        statusText = "Connecting…",
        connectSettling = false,
        nodeCapabilityApprovalState = GatewayNodeApprovalState.Approved,
        gatewayConnectionProblem =
          GatewayConnectionProblem(
            code = "PAIRING_REQUIRED",
            message = "pairing required: device approval is required",
            reason = "not-paired",
            requestId = "request-1",
            recommendedNextStep = "wait_then_retry",
            pauseReconnect = false,
            retryable = true,
          ),
      ),
    )
  }

  @Test
  fun showsFinishingStateWhileGatewayConnectionSettles() {
    assertEquals(
      GatewayRecoveryUiState.Finishing,
      gatewayRecoveryUiState(
        ready = false,
        statusText = "Offline",
        connectSettling = true,
        nodeCapabilityApprovalState = GatewayNodeApprovalState.Approved,
      ),
    )
  }

  @Test
  fun showsFinishingStateForPartialGatewayConnection() {
    assertEquals(
      GatewayRecoveryUiState.Finishing,
      gatewayRecoveryUiState(
        ready = false,
        statusText = "Connected (node offline)",
        connectSettling = false,
        nodeCapabilityApprovalState = GatewayNodeApprovalState.Approved,
      ),
    )
  }

  @Test
  fun showsConnectionIssueForNonPairingFailure() {
    assertEquals(
      GatewayRecoveryUiState.Failed,
      gatewayRecoveryUiState(
        ready = false,
        statusText = "Gateway error: connection refused",
        connectSettling = false,
        nodeCapabilityApprovalState = GatewayNodeApprovalState.Approved,
      ),
    )
  }

  private fun encodeSetupCode(payloadJson: String): String = Base64.getUrlEncoder().withoutPadding().encodeToString(payloadJson.toByteArray(Charsets.UTF_8))
}
