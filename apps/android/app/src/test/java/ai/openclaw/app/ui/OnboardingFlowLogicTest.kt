package ai.openclaw.app.ui

import ai.openclaw.app.GatewayConnectionProblem
import ai.openclaw.app.GatewayNodeApprovalState
import ai.openclaw.app.LocationMode
import ai.openclaw.app.gateway.GatewayEndpoint
import android.Manifest
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
    assertEquals(OnboardingBackDestination(OnboardingStep.Recovery), onboardingBackDestination(OnboardingStep.NodeApproval))
    assertEquals(OnboardingBackDestination(OnboardingStep.NodeApproval), onboardingBackDestination(OnboardingStep.Permissions))
  }

  @Test
  fun permissionsBackCanReturnToRecoveryWhenNodeApprovalWasSkipped() {
    assertEquals(
      OnboardingBackDestination(OnboardingStep.Recovery),
      onboardingBackDestination(
        step = OnboardingStep.Permissions,
        permissionsBackStep = OnboardingStep.Recovery,
      ),
    )
    assertEquals(
      OnboardingBackState(step = OnboardingStep.Recovery),
      onboardingBackStateAfterBack(
        step = OnboardingStep.Permissions,
        permissionsBackStep = OnboardingStep.Recovery,
      ),
    )
  }

  @Test
  fun nodeApprovalBackCanReturnToPermissionsDuringPermissionReapproval() {
    assertEquals(
      OnboardingBackDestination(OnboardingStep.Permissions),
      onboardingBackDestination(
        step = OnboardingStep.NodeApproval,
        nodeApprovalBackStep = OnboardingStep.Permissions,
      ),
    )
    assertEquals(
      OnboardingBackState(step = OnboardingStep.Permissions),
      onboardingBackStateAfterBack(
        step = OnboardingStep.NodeApproval,
        nodeApprovalBackStep = OnboardingStep.Permissions,
      ),
    )
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
    assertFalse(initialCameraCapabilityEnabled(savedCapabilityEnabled = false, androidCameraPermissionGranted = false))
    assertFalse(initialCameraCapabilityEnabled(savedCapabilityEnabled = false, androidCameraPermissionGranted = true))
    assertFalse(initialCameraCapabilityEnabled(savedCapabilityEnabled = true, androidCameraPermissionGranted = false))
    assertTrue(initialCameraCapabilityEnabled(savedCapabilityEnabled = true, androidCameraPermissionGranted = true))
  }

  @Test
  fun cameraPermissionRowDistinguishesAndroidPermissionFromCapabilityOptIn() {
    assertEquals("Not allowed", cameraPermissionRowStatusText(capabilityEnabled = false, androidCameraPermissionGranted = false))
    assertEquals("Off", cameraPermissionRowStatusText(capabilityEnabled = false, androidCameraPermissionGranted = true))
    assertEquals("Enabled", cameraPermissionRowStatusText(capabilityEnabled = true, androidCameraPermissionGranted = true))
  }

  @Test
  fun permissionChangesRequireNodeApprovalWhenAdvertisedSurfaceChanges() {
    assertTrue(
      permissionChangesRequireNodeApproval(
        currentCameraEnabled = false,
        requestedCameraEnabled = true,
        currentLocationMode = LocationMode.Off,
        requestedLocationMode = LocationMode.Off,
      ),
    )
    assertTrue(
      permissionChangesRequireNodeApproval(
        currentCameraEnabled = false,
        requestedCameraEnabled = false,
        currentLocationMode = LocationMode.Off,
        requestedLocationMode = LocationMode.WhileUsing,
      ),
    )
    assertFalse(
      permissionChangesRequireNodeApproval(
        currentCameraEnabled = true,
        requestedCameraEnabled = true,
        currentLocationMode = LocationMode.WhileUsing,
        requestedLocationMode = LocationMode.WhileUsing,
      ),
    )
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
  fun nearbyGatewayManualTlsPreservesDiscoverySecurityPolicy() {
    assertTrue(
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
  fun splitSmsPermissionCallbacksMergePerPermissionGrantState() {
    val requiredPermissions = listOf(Manifest.permission.SEND_SMS, Manifest.permission.READ_SMS)
    val afterSendOnly =
      mergedRequiredPermissionGrantState(
        permissions = mapOf(Manifest.permission.SEND_SMS to true),
        requiredPermissions = requiredPermissions,
        currentlyGranted = { false },
      )
    assertFalse(afterSendOnly)

    val afterReadOnly =
      mergedRequiredPermissionGrantState(
        permissions = mapOf(Manifest.permission.READ_SMS to true),
        requiredPermissions = requiredPermissions,
        currentlyGranted = { permission -> permission == Manifest.permission.SEND_SMS },
      )
    assertTrue(afterReadOnly)

    val deniedRead =
      mergedRequiredPermissionGrantState(
        permissions = mapOf(Manifest.permission.READ_SMS to false),
        requiredPermissions = requiredPermissions,
        currentlyGranted = { true },
      )
    assertFalse(deniedRead)
  }

  @Test
  fun contactAndCalendarPermissionGroupsRequireBothGrants() {
    val permissionGroups =
      listOf(
        listOf(Manifest.permission.READ_CONTACTS, Manifest.permission.WRITE_CONTACTS),
        listOf(Manifest.permission.READ_CALENDAR, Manifest.permission.WRITE_CALENDAR),
      )

    for (requiredPermissions in permissionGroups) {
      val readPermission = requiredPermissions.first()
      val writePermission = requiredPermissions.last()
      assertFalse(
        mergedRequiredPermissionGrantState(
          permissions = mapOf(readPermission to true),
          requiredPermissions = requiredPermissions,
          currentlyGranted = { false },
        ),
      )
      assertTrue(
        mergedRequiredPermissionGrantState(
          permissions = mapOf(writePermission to true),
          requiredPermissions = requiredPermissions,
          currentlyGranted = { permission -> permission == readPermission },
        ),
      )
    }
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
  fun gatewayPairingContinueOnlyRoutesToNodeApprovalWhenApprovalNeedsUserAction() {
    assertEquals(
      OnboardingStep.Permissions,
      gatewayPairingContinueDestination(
        ready = true,
        nodeCapabilityApprovalState = GatewayNodeApprovalState.PendingApproval,
      ),
    )
    assertEquals(
      OnboardingStep.NodeApproval,
      gatewayPairingContinueDestination(
        ready = false,
        nodeCapabilityApprovalState = GatewayNodeApprovalState.PendingApproval,
      ),
    )
    assertEquals(
      OnboardingStep.NodeApproval,
      gatewayPairingContinueDestination(
        ready = false,
        nodeCapabilityApprovalState = GatewayNodeApprovalState.PendingReapproval,
      ),
    )
    assertEquals(
      OnboardingStep.NodeApproval,
      gatewayPairingContinueDestination(
        ready = false,
        nodeCapabilityApprovalState = GatewayNodeApprovalState.Unapproved,
      ),
    )
    assertNull(
      gatewayPairingContinueDestination(
        ready = false,
        nodeCapabilityApprovalState = GatewayNodeApprovalState.Loading,
      ),
    )
    assertNull(
      gatewayPairingContinueDestination(
        ready = false,
        nodeCapabilityApprovalState = GatewayNodeApprovalState.Approved,
      ),
    )
    assertNull(
      gatewayPairingContinueDestination(
        ready = false,
        nodeCapabilityApprovalState = GatewayNodeApprovalState.Unsupported,
      ),
    )
  }

  @Test
  fun permissionContinueReturnsToNodeApprovalWhenApprovalIsStillPending() {
    assertTrue(
      permissionContinueNeedsNodeApproval(
        ready = false,
        requiresNodeApprovalAfterApply = false,
        nodeCapabilityApprovalState = GatewayNodeApprovalState.PendingReapproval,
      ),
    )
    assertTrue(
      permissionContinueNeedsNodeApproval(
        ready = false,
        requiresNodeApprovalAfterApply = true,
        nodeCapabilityApprovalState = GatewayNodeApprovalState.Approved,
      ),
    )
    assertTrue(
      permissionContinueNeedsNodeApproval(
        ready = true,
        requiresNodeApprovalAfterApply = true,
        nodeCapabilityApprovalState = GatewayNodeApprovalState.Approved,
      ),
    )
    assertFalse(
      permissionContinueNeedsNodeApproval(
        ready = true,
        requiresNodeApprovalAfterApply = true,
        nodeCapabilityApprovalState = GatewayNodeApprovalState.Unsupported,
      ),
    )
    assertFalse(
      permissionContinueNeedsNodeApproval(
        ready = true,
        requiresNodeApprovalAfterApply = false,
        nodeCapabilityApprovalState = GatewayNodeApprovalState.Approved,
      ),
    )
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
  fun nodeApprovalCheckingOnlyTracksActiveRefresh() {
    assertTrue(
      nodeApprovalCheckingInProgress(
        checkRequested = true,
        refreshStarted = false,
        nodesDevicesRefreshing = false,
      ),
    )
    assertTrue(
      nodeApprovalCheckingInProgress(
        checkRequested = true,
        refreshStarted = true,
        nodesDevicesRefreshing = true,
      ),
    )
    assertFalse(
      nodeApprovalCheckingInProgress(
        checkRequested = true,
        refreshStarted = true,
        nodesDevicesRefreshing = false,
      ),
    )
    assertFalse(
      nodeApprovalCheckingInProgress(
        checkRequested = false,
        refreshStarted = true,
        nodesDevicesRefreshing = true,
      ),
    )
  }

  @Test
  fun nodeApprovalCheckContinuesOnlyAfterRequestedRefreshCompletesReady() {
    assertFalse(
      nodeApprovalCheckCanContinue(
        checkRequested = true,
        refreshStarted = false,
        nodesDevicesRefreshing = false,
        ready = true,
      ),
    )
    assertFalse(
      nodeApprovalCheckCanContinue(
        checkRequested = true,
        refreshStarted = true,
        nodesDevicesRefreshing = true,
        ready = true,
      ),
    )
    assertFalse(
      nodeApprovalCheckCanContinue(
        checkRequested = true,
        refreshStarted = true,
        nodesDevicesRefreshing = false,
        ready = false,
      ),
    )
    assertTrue(
      nodeApprovalCheckCanContinue(
        checkRequested = true,
        refreshStarted = true,
        nodesDevicesRefreshing = false,
        ready = true,
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
  fun gatewayPairingStopsAtConnectedEvenWhenNodeApprovalIsStillPending() {
    assertEquals(
      GatewayRecoveryUiState.Connected,
      gatewayPairingUiState(
        gatewayPaired = true,
        gatewayPairingCanContinue = true,
        statusText = "Waiting for node approval",
        connectSettling = false,
        connectTimedOut = true,
      ),
    )
  }

  @Test
  fun gatewayPairingPrefersManualApprovalErrorOverPartialOperatorConnect() {
    assertEquals(
      GatewayRecoveryUiState.ApprovalRequired,
      gatewayPairingUiState(
        gatewayPaired = true,
        gatewayPairingCanContinue = false,
        statusText = "Connected (node offline)",
        connectSettling = false,
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
  fun gatewayPairingPrefersRetryableApprovalErrorOverPartialOperatorConnect() {
    assertEquals(
      GatewayRecoveryUiState.Pairing,
      gatewayPairingUiState(
        gatewayPaired = true,
        gatewayPairingCanContinue = false,
        statusText = "Connected (node offline)",
        connectSettling = false,
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
  fun gatewayPairingWaitsWhenOperatorConnectedButNoContinueDestinationExists() {
    assertEquals(
      GatewayRecoveryUiState.Finishing,
      gatewayPairingUiState(
        gatewayPaired = true,
        gatewayPairingCanContinue = false,
        statusText = "Connected (node offline)",
        connectSettling = false,
        connectTimedOut = false,
      ),
    )
    assertEquals(
      GatewayRecoveryUiState.TakingLonger,
      gatewayPairingUiState(
        gatewayPaired = true,
        gatewayPairingCanContinue = false,
        statusText = "Connected (node offline)",
        connectSettling = false,
        connectTimedOut = true,
      ),
    )
  }

  @Test
  fun gatewayPairingShowsSlowConnectionWhenGatewayNeverPairs() {
    assertEquals(
      GatewayRecoveryUiState.Finishing,
      gatewayPairingUiState(
        gatewayPaired = false,
        gatewayPairingCanContinue = false,
        statusText = "Connecting…",
        connectSettling = false,
        connectTimedOut = false,
      ),
    )
    assertEquals(
      GatewayRecoveryUiState.TakingLonger,
      gatewayPairingUiState(
        gatewayPaired = false,
        gatewayPairingCanContinue = false,
        statusText = "Connecting…",
        connectSettling = false,
        connectTimedOut = true,
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
  fun recoveryGatewayAuthDetailExplainsOlderGatewayProtocolMismatch() {
    assertEquals(
      "The Gateway is older than this app. Update OpenClaw on the Gateway host, then retry. (app protocol v6, gateway protocol v5).",
      recoveryGatewayAuthDetail(
        GatewayConnectionProblem(
          code = "PROTOCOL_MISMATCH",
          message = "protocol mismatch",
          reason = null,
          requestId = null,
          recommendedNextStep = null,
          pauseReconnect = true,
          retryable = false,
          clientMinProtocol = 6,
          clientMaxProtocol = 6,
          expectedProtocol = 5,
        ),
      ),
    )
  }

  @Test
  fun recoveryGatewayAuthDetailExplainsIncompatibleProtocolMismatch() {
    assertEquals(
      "The app and Gateway use incompatible protocol versions. Update OpenClaw on both, then retry. (app protocols v4-v6).",
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
          clientMaxProtocol = 6,
          expectedProtocol = null,
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
    assertEquals(GatewayRecoveryPrimaryAction.Back, gatewayRecoveryPrimaryAction(GatewayRecoveryUiState.Failed))
    assertEquals(GatewayRecoveryPrimaryAction.Back, gatewayRecoveryPrimaryAction(GatewayRecoveryUiState.TakingLonger))
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
        GatewayRecoveryProgressItem("Opening Gateway connection", GatewayRecoveryProgressStatus.Current),
        GatewayRecoveryProgressItem("Checking pairing access", GatewayRecoveryProgressStatus.Pending),
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
  fun recoveryProgressDoesNotAdvanceToGatewayAccessJustBecauseSettlingEnds() {
    assertEquals(
      listOf(
        GatewayRecoveryProgressItem("Opening Gateway connection", GatewayRecoveryProgressStatus.Current),
        GatewayRecoveryProgressItem("Checking pairing access", GatewayRecoveryProgressStatus.Pending),
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
        GatewayRecoveryProgressItem("Opening Gateway connection", GatewayRecoveryProgressStatus.Complete),
        GatewayRecoveryProgressItem("Checking pairing access", GatewayRecoveryProgressStatus.Complete),
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

    val plan =
      resolveOnboardingGatewayConnectPlan(
        setupCode = requireNotNull(scanned.setupCode),
        savedManualHost = "127.0.0.1",
        savedManualPort = "18789",
        savedManualTls = false,
        manualHost = "127.0.0.1",
        manualPort = "18789",
        manualTls = false,
        token = "stale-shared-token",
        password = "stale-shared-password",
      )

    assertEquals(GatewaySavedAuthAction.REPLACE_SETUP, plan?.savedAuthAction)
    assertEquals("10.0.2.2", plan?.config?.host)
    assertEquals(18789, plan?.config?.port)
    assertEquals(false, plan?.config?.tls)
    assertEquals("bootstrap-1", plan?.config?.bootstrapToken)
    assertEquals("", plan?.config?.token)
    assertEquals("", plan?.config?.password)
    assertNull(scanned.error)
  }

  @Test
  fun resolvesOnboardingManualConnectConfigWhenSetupCodeIsBlank() {
    val plan =
      resolveOnboardingGatewayConnectPlan(
        setupCode = "",
        savedManualHost = "127.0.0.1",
        savedManualPort = "18789",
        savedManualTls = false,
        manualHost = "127.0.0.1",
        manualPort = "18789",
        manualTls = false,
        token = "shared-token",
        password = "shared-password",
      )

    assertEquals(GatewaySavedAuthAction.PRESERVE, plan?.savedAuthAction)
    assertEquals("127.0.0.1", plan?.config?.host)
    assertEquals(18789, plan?.config?.port)
    assertEquals(false, plan?.config?.tls)
    assertEquals("", plan?.config?.bootstrapToken)
    assertEquals("shared-token", plan?.config?.token)
    assertEquals("", plan?.config?.password)
  }

  @Test
  fun onboardingManualEndpointChangeReplacesSavedGatewayAuth() {
    val plan =
      resolveOnboardingGatewayConnectPlan(
        setupCode = "",
        savedManualHost = "127.0.0.1",
        savedManualPort = "18789",
        savedManualTls = false,
        manualHost = "10.0.2.2",
        manualPort = "18790",
        manualTls = false,
        token = "replacement-token",
        password = "",
      )

    assertEquals(GatewaySavedAuthAction.REPLACE_ENDPOINT, plan?.savedAuthAction)
    assertEquals("10.0.2.2", plan?.config?.host)
    assertEquals("replacement-token", plan?.config?.token)
  }

  private fun encodeSetupCode(payloadJson: String): String = Base64.getUrlEncoder().withoutPadding().encodeToString(payloadJson.toByteArray(Charsets.UTF_8))
}
