package ai.openclaw.app.ui

import ai.openclaw.app.GatewayConnectionProblem
import ai.openclaw.app.GatewayNodeApprovalState
import ai.openclaw.app.gateway.GatewayEndpoint
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
  fun onboardingBackDestinationsMatchTheVisibleFlow() {
    assertEquals(null, onboardingBackDestination(OnboardingStep.Welcome))
    assertEquals(OnboardingBackDestination(OnboardingStep.Welcome), onboardingBackDestination(OnboardingStep.Gateway))
    assertEquals(OnboardingBackDestination(OnboardingStep.Gateway), onboardingBackDestination(OnboardingStep.SetupCode))
    assertEquals(
      OnboardingBackDestination(OnboardingStep.SetupCode),
      onboardingBackDestination(OnboardingStep.EnterSetupCode),
    )
    assertEquals(OnboardingBackDestination(OnboardingStep.Gateway), onboardingBackDestination(OnboardingStep.Manual))
    assertEquals(OnboardingBackDestination(OnboardingStep.Recovery), onboardingBackDestination(OnboardingStep.Permissions))
  }

  @Test
  fun setupCodeEntryBackRestoresInlineScannerOnlyWhenOpenedFromScanner() {
    assertEquals(
      OnboardingBackState(step = OnboardingStep.SetupCode, inlineQrScannerActive = true),
      onboardingBackStateAfterBack(
        step = OnboardingStep.EnterSetupCode,
        setupCodeEntryOpenedFromScanner = true,
      ),
    )
    assertEquals(
      OnboardingBackState(step = OnboardingStep.SetupCode, inlineQrScannerActive = false),
      onboardingBackStateAfterBack(
        step = OnboardingStep.EnterSetupCode,
        setupCodeEntryOpenedFromScanner = false,
      ),
    )
  }

  @Test
  fun onboardingBackStateClearsScannerOriginAfterBack() {
    assertEquals(
      OnboardingBackState(step = OnboardingStep.SetupCode, inlineQrScannerActive = true, setupCodeEntryOpenedFromScanner = false),
      onboardingBackStateAfterBack(
        step = OnboardingStep.EnterSetupCode,
        setupCodeEntryOpenedFromScanner = true,
      ),
    )
  }

  @Test
  fun recoveryBackRestoresInlineScannerOnlyForScannerConnections() {
    assertEquals(
      OnboardingBackDestination(OnboardingStep.SetupCode, inlineQrScannerActive = true),
      onboardingBackDestination(OnboardingStep.Recovery, lastGatewayInputSource = OnboardingGatewayInputSource.SetupScanner),
    )
    assertEquals(
      OnboardingBackDestination(OnboardingStep.SetupCode, inlineQrScannerActive = false),
      onboardingBackDestination(OnboardingStep.Recovery, lastGatewayInputSource = OnboardingGatewayInputSource.SetupGallery),
    )
    assertEquals(
      OnboardingBackDestination(OnboardingStep.SetupCode, inlineQrScannerActive = false),
      onboardingBackDestination(OnboardingStep.Recovery, lastGatewayInputSource = OnboardingGatewayInputSource.SetupEntry),
    )
  }

  @Test
  fun recoveryBackReturnsToManualFormAfterManualConnection() {
    assertEquals(
      OnboardingBackDestination(OnboardingStep.Manual),
      onboardingBackDestination(OnboardingStep.Recovery, lastGatewayInputSource = OnboardingGatewayInputSource.Manual),
    )
  }

  @Test
  fun cameraCapabilityStartsOffEvenWhenScannerPermissionWasGranted() {
    assertFalse(initialCameraCapabilityEnabled(androidCameraPermissionGranted = false))
    assertFalse(initialCameraCapabilityEnabled(androidCameraPermissionGranted = true))
  }

  @Test
  fun cameraPermissionRowDistinguishesAndroidPermissionFromCapabilityOptIn() {
    assertEquals("Not allowed", cameraPermissionRowStatusText(capabilityEnabled = false, androidCameraPermissionGranted = false))
    assertEquals("Off", cameraPermissionRowStatusText(capabilityEnabled = false, androidCameraPermissionGranted = true))
    assertEquals("Enabled", cameraPermissionRowStatusText(capabilityEnabled = true, androidCameraPermissionGranted = true))
  }

  @Test
  fun nearbyGatewayManualPortUsesResolvedDiscoveryEndpointPort() {
    val endpoint =
      GatewayEndpoint(
        stableId = "_openclaw-gw._tcp.|local.|Home",
        name = "Home",
        host = "192.168.1.12",
        port = 53122,
        gatewayPort = 18789,
      )

    assertEquals("53122", nearbyGatewayManualPort(endpoint))
  }

  @Test
  fun nearbyGatewayManualTlsOnlyUsesDiscoveryTlsHints() {
    assertFalse(
      nearbyGatewayManualTls(
        GatewayEndpoint(
          stableId = "_openclaw-gw._tcp.|local.|Lan",
          name = "Lan",
          host = "192.168.1.12",
          port = 18789,
        ),
      ),
    )
    assertTrue(
      nearbyGatewayManualTls(
        GatewayEndpoint(
          stableId = "_openclaw-gw._tcp.|local.|Secure",
          name = "Secure",
          host = "192.168.1.12",
          port = 18789,
          tlsEnabled = true,
        ),
      ),
    )
    assertTrue(
      nearbyGatewayManualTls(
        GatewayEndpoint(
          stableId = "_openclaw-gw._tcp.|local.|Pinned",
          name = "Pinned",
          host = "127.0.0.1",
          port = 18789,
          tlsFingerprintSha256 = "abc123",
        ),
      ),
    )
    assertFalse(
      nearbyGatewayManualTls(
        GatewayEndpoint(
          stableId = "_openclaw-gw._tcp.|local.|Loopback",
          name = "Loopback",
          host = "127.0.0.1",
          port = 18789,
        ),
      ),
    )
  }

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
  fun recoveryGatewayNamePrefersServerThenAttemptedGateway() {
    assertEquals("Server Gateway", recoveryGatewayName(serverName = "Server Gateway", attemptedGatewayName = "Discovered Gateway"))
    assertEquals("Discovered Gateway", recoveryGatewayName(serverName = null, attemptedGatewayName = "Discovered Gateway"))
    assertEquals("Home Gateway", recoveryGatewayName(serverName = " ", attemptedGatewayName = " "))
  }

  @Test
  fun recoveryNodeApprovalCommandUsesRequestIdWhenAvailable() {
    assertEquals("openclaw nodes approve request-1", recoveryNodeApprovalCommand(" request-1 "))
    assertEquals("openclaw nodes approve REQUEST_ID", recoveryNodeApprovalCommand(null))
    assertEquals("openclaw nodes approve REQUEST_ID", recoveryNodeApprovalCommand(" "))
  }

  @Test
  fun nodeCapabilityApprovalNeedsUserActionOnlyForPendingStates() {
    assertTrue(nodeCapabilityApprovalNeedsUserAction(GatewayNodeApprovalState.PendingApproval))
    assertTrue(nodeCapabilityApprovalNeedsUserAction(GatewayNodeApprovalState.PendingReapproval))
    assertTrue(nodeCapabilityApprovalNeedsUserAction(GatewayNodeApprovalState.Unapproved))
    assertFalse(nodeCapabilityApprovalNeedsUserAction(GatewayNodeApprovalState.Approved))
    assertFalse(nodeCapabilityApprovalNeedsUserAction(GatewayNodeApprovalState.Loading))
    assertFalse(nodeCapabilityApprovalNeedsUserAction(GatewayNodeApprovalState.Unsupported))
  }

  @Test
  fun recoveryNodeApprovalPollingWaitsForInFlightRefresh() {
    assertTrue(
      shouldRefreshNodeApprovalDuringRecovery(
        nodeCapabilityApprovalState = GatewayNodeApprovalState.Loading,
        nodesDevicesRefreshing = false,
      ),
    )
    assertFalse(
      shouldRefreshNodeApprovalDuringRecovery(
        nodeCapabilityApprovalState = GatewayNodeApprovalState.Loading,
        nodesDevicesRefreshing = true,
      ),
    )
    assertTrue(
      shouldRefreshNodeApprovalDuringRecovery(
        nodeCapabilityApprovalState = GatewayNodeApprovalState.PendingApproval,
        nodesDevicesRefreshing = false,
      ),
    )
    assertFalse(
      shouldRefreshNodeApprovalDuringRecovery(
        nodeCapabilityApprovalState = GatewayNodeApprovalState.PendingApproval,
        nodesDevicesRefreshing = true,
      ),
    )
    assertFalse(
      shouldRefreshNodeApprovalDuringRecovery(
        nodeCapabilityApprovalState = GatewayNodeApprovalState.Approved,
        nodesDevicesRefreshing = false,
      ),
    )
  }

  @Test
  fun showsPairingStateForPairingRequiredGatewayStatus() {
    assertEquals(
      GatewayRecoveryUiState.Pairing,
      gatewayRecoveryUiState(
        ready = false,
        statusText = "Gateway error: pairing required; approval in progress",
        connectSettling = false,
        connectTimedOut = true,
        nodeCapabilityApprovalState = GatewayNodeApprovalState.Approved,
      ),
    )
  }

  @Test
  fun showsSlowConnectionStateWhenLoadingOutlastsConnectionTimeout() {
    assertEquals(
      GatewayRecoveryUiState.TakingLonger,
      gatewayRecoveryUiState(
        ready = false,
        statusText = "Connecting",
        connectSettling = false,
        connectTimedOut = true,
        nodeCapabilityApprovalState = GatewayNodeApprovalState.Loading,
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
  fun recoveryGatewayDetailPreservesRetryablePairingGuidance() {
    assertEquals(
      "Gateway approval is in progress. OpenClaw will retry automatically.",
      recoveryGatewayDetail(
        ready = false,
        remoteAddress = null,
        statusText = "Connected (node offline)",
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
  fun recoveryGatewayDetailPrefersAuthProblemOverStaleAddressWhenNotReady() {
    assertEquals(
      "Saved authentication is invalid. Re-authenticate or reset this gateway connection.",
      recoveryGatewayDetail(
        ready = false,
        remoteAddress = "wss://gateway.example.test",
        statusText = "Connected (node offline)",
        nodeCapabilityApprovalState = GatewayNodeApprovalState.Approved,
        gatewayConnectionProblem =
          GatewayConnectionProblem(
            code = "AUTH_DEVICE_TOKEN_MISMATCH",
            message = "authentication needed",
            reason = null,
            requestId = null,
            recommendedNextStep = "update_auth_credentials",
            pauseReconnect = true,
            retryable = false,
          ),
      ),
    )
  }

  @Test
  fun recoveryGatewayDetailPrefersAuthProblemWhileNodeApprovalIsLoading() {
    assertEquals(
      "Saved authentication is invalid. Re-authenticate or reset this gateway connection.",
      recoveryGatewayDetail(
        ready = false,
        remoteAddress = "wss://gateway.example.test",
        statusText = "Connected (node offline)",
        nodeCapabilityApprovalState = GatewayNodeApprovalState.Loading,
        gatewayConnectionProblem =
          GatewayConnectionProblem(
            code = "AUTH_DEVICE_TOKEN_MISMATCH",
            message = "authentication needed",
            reason = null,
            requestId = null,
            recommendedNextStep = "update_auth_credentials",
            pauseReconnect = true,
            retryable = false,
          ),
      ),
    )
  }

  @Test
  fun recoveryGatewayAuthDetailShowsSpecificAuthRecoveryActions() {
    val cases =
      listOf(
        "AUTH_BOOTSTRAP_TOKEN_INVALID" to "The code may have expired or been generated for another Gateway.",
        "AUTH_DEVICE_TOKEN_MISMATCH" to "Saved authentication is invalid. Re-authenticate or reset this gateway connection.",
        "AUTH_PASSWORD_MISMATCH" to "Gateway password is invalid. Re-enter it or reset this gateway connection.",
        "AUTH_TOKEN_MISSING" to "Gateway token is required. Enter it again or edit this connection.",
        "DEVICE_IDENTITY_REQUIRED" to "Gateway requires this device identity. Re-authenticate or reset this gateway connection.",
      )

    cases.forEach { (code, expected) ->
      assertEquals(
        expected,
        recoveryGatewayAuthDetail(
          GatewayConnectionProblem(
            code = code,
            message = "authentication needed",
            reason = null,
            requestId = null,
            recommendedNextStep = null,
            pauseReconnect = true,
            retryable = false,
          ),
        ),
      )
    }
  }

  @Test
  fun recoveryGatewayAuthDetailPreservesProtocolMismatchGuidance() {
    assertEquals(
      "This app is older than the Gateway. Update OpenClaw on this device, then retry. (app protocol v4, gateway protocol v5).",
      recoveryGatewayAuthDetail(
        GatewayConnectionProblem(
          code = "PROTOCOL_MISMATCH",
          message = "protocol mismatch",
          reason = null,
          requestId = null,
          recommendedNextStep = null,
          pauseReconnect = true,
          retryable = false,
          clientMinProtocol = 4,
          clientMaxProtocol = 4,
          expectedProtocol = 5,
        ),
      ),
    )
  }

  @Test
  fun recoveryGatewayAuthDetailUsesRecommendedNextStepFallbacks() {
    assertEquals(
      "Gateway authentication is not configured. Edit this connection and try again.",
      recoveryGatewayAuthDetail(
        GatewayConnectionProblem(
          code = "UNKNOWN",
          message = "authentication needed",
          reason = null,
          requestId = null,
          recommendedNextStep = "update_auth_configuration",
          pauseReconnect = true,
          retryable = false,
        ),
      ),
    )
    assertEquals(
      "gateway says no",
      recoveryGatewayAuthDetail(
        GatewayConnectionProblem(
          code = "UNKNOWN",
          message = "gateway says no",
          reason = null,
          requestId = null,
          recommendedNextStep = null,
          pauseReconnect = true,
          retryable = false,
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
  fun showsFinishingStateForPartialGatewayConnectionAfterTimeout() {
    assertEquals(
      GatewayRecoveryUiState.Finishing,
      gatewayRecoveryUiState(
        ready = false,
        statusText = "Connected (node offline)",
        connectSettling = false,
        connectTimedOut = true,
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

  @Test
  fun showsSlowConnectionStateWhenGenericConnectionTimesOut() {
    assertEquals(
      GatewayRecoveryUiState.TakingLonger,
      gatewayRecoveryUiState(
        ready = false,
        statusText = "Connecting…",
        connectSettling = false,
        connectTimedOut = true,
        nodeCapabilityApprovalState = GatewayNodeApprovalState.Approved,
      ),
    )
  }

  @Test
  fun recoveryPrimaryActionOnlyAppearsForCompleteFailureOrSlowConnectionStates() {
    assertEquals(GatewayRecoveryPrimaryAction.Finish, gatewayRecoveryPrimaryAction(GatewayRecoveryUiState.Connected))
    assertEquals(GatewayRecoveryPrimaryAction.StartOver, gatewayRecoveryPrimaryAction(GatewayRecoveryUiState.Failed))
    assertEquals(GatewayRecoveryPrimaryAction.StartOver, gatewayRecoveryPrimaryAction(GatewayRecoveryUiState.TakingLonger))
    assertEquals(GatewayRecoveryPrimaryAction.Retry, gatewayRecoveryPrimaryAction(GatewayRecoveryUiState.ApprovalRequired))

    listOf(
      GatewayRecoveryUiState.NodeCapabilityApprovalPending,
      GatewayRecoveryUiState.Pairing,
      GatewayRecoveryUiState.Finishing,
    ).forEach { state ->
      assertEquals(null, gatewayRecoveryPrimaryAction(state))
    }
  }

  @Test
  fun recoveryProgressStartsAtGatewayEndpointWhileConnecting() {
    assertEquals(
      listOf(
        GatewayRecoveryProgressItem("Connecting to the Gateway endpoint", GatewayRecoveryProgressStatus.Current),
        GatewayRecoveryProgressItem("Checking Gateway access", GatewayRecoveryProgressStatus.Pending),
        GatewayRecoveryProgressItem("Checking node access", GatewayRecoveryProgressStatus.Pending),
      ),
      gatewayRecoveryProgressItems(
        state = GatewayRecoveryUiState.Finishing,
        statusText = "Connecting…",
        connectSettling = true,
      ),
    )
  }

  @Test
  fun recoveryProgressMovesDownToGatewayAccessAfterSettling() {
    assertEquals(
      listOf(
        GatewayRecoveryProgressItem("Connecting to the Gateway endpoint", GatewayRecoveryProgressStatus.Complete),
        GatewayRecoveryProgressItem("Checking Gateway access", GatewayRecoveryProgressStatus.Current),
        GatewayRecoveryProgressItem("Checking node access", GatewayRecoveryProgressStatus.Pending),
      ),
      gatewayRecoveryProgressItems(
        state = GatewayRecoveryUiState.Finishing,
        statusText = "Connecting…",
        connectSettling = false,
      ),
    )
  }

  @Test
  fun recoveryProgressMovesDownToNodeAccessAfterGatewayConnects() {
    assertEquals(
      listOf(
        GatewayRecoveryProgressItem("Connecting to the Gateway endpoint", GatewayRecoveryProgressStatus.Complete),
        GatewayRecoveryProgressItem("Checking Gateway access", GatewayRecoveryProgressStatus.Complete),
        GatewayRecoveryProgressItem("Checking node access", GatewayRecoveryProgressStatus.Current),
      ),
      gatewayRecoveryProgressItems(
        state = GatewayRecoveryUiState.Finishing,
        statusText = "Connected (node offline)",
      ),
    )
  }

  @Test
  fun resolvesOnboardingSetupCodeConnectConfigForScannedQr() {
    val setupCode =
      encodeSetupCode("""{"url":"ws://10.0.2.2:18789","bootstrapToken":"bootstrap-1"}""")
    val scanned = resolveScannedSetupCodeResult(setupCode)

    val resolved =
      resolveOnboardingGatewayConnectConfig(
        setupCode = requireNotNull(scanned.setupCode),
        manualHost = "127.0.0.1",
        manualPort = "18789",
        manualTls = false,
        token = "stale-shared-token",
        password = "stale-shared-password",
      )

    assertEquals("10.0.2.2", resolved?.host)
    assertEquals(18789, resolved?.port)
    assertEquals(false, resolved?.tls)
    assertEquals("bootstrap-1", resolved?.bootstrapToken)
    assertEquals("", resolved?.token)
    assertEquals("", resolved?.password)
    assertNull(scanned.error)
  }

  @Test
  fun resolvesOnboardingManualConnectConfigWhenSetupCodeIsBlank() {
    val resolved =
      resolveOnboardingGatewayConnectConfig(
        setupCode = "",
        manualHost = "127.0.0.1",
        manualPort = "18789",
        manualTls = false,
        token = "shared-token",
        password = "shared-password",
      )

    assertEquals("127.0.0.1", resolved?.host)
    assertEquals(18789, resolved?.port)
    assertEquals(false, resolved?.tls)
    assertEquals("", resolved?.bootstrapToken)
    assertEquals("shared-token", resolved?.token)
    assertEquals("shared-password", resolved?.password)
  }

  private fun encodeSetupCode(payloadJson: String): String = Base64.getUrlEncoder().withoutPadding().encodeToString(payloadJson.toByteArray(Charsets.UTF_8))
}
