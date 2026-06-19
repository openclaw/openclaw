package ai.openclaw.app.ui

import ai.openclaw.app.GatewayConnectionProblem
import ai.openclaw.app.GatewayNodeApprovalState
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

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
  fun nearbyGatewayFoundStateIsConnectable() {
    assertEquals(
      NearbyGatewayUiState(subtitle = "Studio Gateway", status = "Found", canConnect = true),
      nearbyGatewayUiState(nearbyGatewayName = "Studio Gateway", discoveryStatusText = "Searching…", discoveryStarted = false),
    )
  }

  @Test
  fun nearbyGatewayBeforeDiscoveryStartsIsNotConnectable() {
    assertEquals(
      NearbyGatewayUiState(subtitle = "Starting discovery...", status = "Starting", canConnect = false),
      nearbyGatewayUiState(nearbyGatewayName = null, discoveryStatusText = "Searching…", discoveryStarted = false, searchTimedOut = true),
    )
  }

  @Test
  fun nearbyGatewaySearchingStateIsNotConnectable() {
    assertEquals(
      NearbyGatewayUiState(subtitle = "Searching for gateways...", status = "Searching", canConnect = false),
      nearbyGatewayUiState(nearbyGatewayName = null, discoveryStatusText = "Searching for gateways…"),
    )
  }

  @Test
  fun nearbyGatewayTimedOutSearchShowsEmptyState() {
    assertEquals(
      NearbyGatewayUiState(subtitle = "No gateway found", status = "Not found", canConnect = false),
      nearbyGatewayUiState(nearbyGatewayName = null, discoveryStatusText = "Searching for gateways…", searchTimedOut = true),
    )
  }

  @Test
  fun nearbyGatewayEmptyResultStateIsNotConnectable() {
    assertEquals(
      NearbyGatewayUiState(subtitle = "No gateway found", status = "Not found", canConnect = false),
      nearbyGatewayUiState(nearbyGatewayName = null, discoveryStatusText = "Local: 0 • Wide: 0"),
    )
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
}
