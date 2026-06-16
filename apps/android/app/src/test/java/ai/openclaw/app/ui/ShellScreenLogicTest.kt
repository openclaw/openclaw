package ai.openclaw.app.ui

import ai.openclaw.app.AppearanceThemeMode
import ai.openclaw.app.GatewayChannelSummary
import ai.openclaw.app.GatewayChannelsSummary
import ai.openclaw.app.GatewayNodeApprovalState
import ai.openclaw.app.GatewayNodeSummary
import ai.openclaw.app.GatewayNodesDevicesSummary
import ai.openclaw.app.GatewayPendingDeviceSummary
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ShellScreenLogicTest {
  @Test
  fun bottomNavHidesForKeyboardAndCommandPalette() {
    assertTrue(shellBottomNavVisible(keyboardVisible = false, commandOpen = false))
    assertFalse(shellBottomNavVisible(keyboardVisible = true, commandOpen = false))
    assertFalse(shellBottomNavVisible(keyboardVisible = false, commandOpen = true))
  }

  @Test
  fun appearanceThemeModeDefaultsToDarkForExistingInstalls() {
    assertEquals(AppearanceThemeMode.Dark, AppearanceThemeMode.fromRawValue(null))
    assertEquals(AppearanceThemeMode.Dark, AppearanceThemeMode.fromRawValue("unknown"))
  }

  @Test
  fun appearanceThemeLabelsRoundTripFromSettingsOptions() {
    assertEquals(listOf("System", "Dark", "Light"), appearanceThemeOptions())
    assertEquals(AppearanceThemeMode.System, appearanceThemeModeForLabel("System"))
    assertEquals(AppearanceThemeMode.Dark, appearanceThemeModeForLabel("Dark"))
    assertEquals(AppearanceThemeMode.Light, appearanceThemeModeForLabel("Light"))
  }

  @Test
  fun appearanceThemeModeResolvesAgainstSystemPreference() {
    assertFalse(AppearanceThemeMode.System.isDark(systemDark = false))
    assertTrue(AppearanceThemeMode.System.isDark(systemDark = true))
    assertTrue(AppearanceThemeMode.Dark.isDark(systemDark = false))
    assertFalse(AppearanceThemeMode.Light.isDark(systemDark = true))
  }

  @Test
  fun homeAttentionRowsSurfaceGatewayWhenDisconnected() {
    val rows =
      homeAttentionRows(
        isConnected = false,
        pendingApprovals = 0,
        channelsSummary = emptyChannels(),
        nodesDevicesSummary = emptyNodesDevices(),
        readyProviderCount = 0,
      )

    assertEquals(listOf("Gateway"), rows.map { it.title })
  }

  @Test
  fun homeAttentionRowsSurfaceOnlyActionableConnectedIssues() {
    val rows =
      homeAttentionRows(
        isConnected = true,
        pendingApprovals = 2,
        channelsSummary =
          GatewayChannelsSummary(
            channels =
              listOf(
                GatewayChannelSummary(
                  id = "telegram",
                  label = "Telegram",
                  accountCount = 1,
                  enabled = true,
                  configured = true,
                  linked = true,
                  running = false,
                  connected = false,
                  error = "offline",
                ),
              ),
          ),
        nodesDevicesSummary =
          GatewayNodesDevicesSummary(
            nodes = emptyList(),
            pendingDevices =
              listOf(
                GatewayPendingDeviceSummary(
                  requestId = "request-1",
                  deviceId = "device-1",
                  displayName = "Phone",
                  remoteIp = null,
                  roles = emptyList(),
                  scopes = emptyList(),
                  requestedAtMs = null,
                  repair = false,
                ),
              ),
            pairedDevices = emptyList(),
          ),
        readyProviderCount = 0,
      )

    assertEquals(listOf("Approvals", "Channels", "Nodes & Devices", "Providers"), rows.map { it.title })
    val providersRow = rows.single { it.title == "Providers" }
    assertEquals(Tab.Settings, providersRow.tab)
    assertEquals(SettingsRoute.Gateway, providersRow.settingsRoute)
  }

  @Test
  fun homeAttentionRowsStayQuietWhenConnectedAndHealthy() {
    val rows =
      homeAttentionRows(
        isConnected = true,
        pendingApprovals = 0,
        channelsSummary = emptyChannels(),
        nodesDevicesSummary = emptyNodesDevices(),
        readyProviderCount = 1,
      )

    assertEquals(emptyList<String>(), rows.map { it.title })
  }

  @Test
  fun nodeRowsDistinguishTransportPairingFromCapabilityApproval() {
    val pending = androidNode(approvalState = GatewayNodeApprovalState.PendingApproval, pendingRequestId = "node-request-1")
    val unapproved = androidNode(approvalState = GatewayNodeApprovalState.Unapproved, connected = false)
    val approved = androidNode(approvalState = GatewayNodeApprovalState.Approved, commands = listOf("device.status"))

    assertEquals("Approval Pending", nodeStatusText(pending))
    assertTrue(nodeSubtitle(pending).contains("Transport paired"))
    assertTrue(nodeSubtitle(pending).contains("openclaw nodes pending"))
    assertTrue(nodeSubtitle(pending).contains("openclaw nodes approve node-request-1"))
    assertEquals("Unavailable", nodeStatusText(unapproved))
    assertTrue(nodeSubtitle(unapproved).contains("Capabilities unavailable"))
    assertEquals("Ready", nodeStatusText(approved))
    assertTrue(nodeSubtitle(approved).contains("Ready"))
  }

  @Test
  fun homeAttentionRowsSurfaceNodeCapabilityApprovalRequests() {
    val rows =
      homeAttentionRows(
        isConnected = true,
        pendingApprovals = 0,
        channelsSummary = emptyChannels(),
        nodesDevicesSummary =
          GatewayNodesDevicesSummary(
            nodes = listOf(androidNode(approvalState = GatewayNodeApprovalState.PendingApproval, pendingRequestId = "node-request-1")),
            pendingDevices = emptyList(),
            pairedDevices = emptyList(),
          ),
        readyProviderCount = 1,
      )

    assertEquals(listOf("Nodes & Devices"), rows.map { it.title })
    assertEquals("1 pending", rows.single().subtitle)
  }

  @Test
  fun homeAttentionRowsSurfacePendingNodeCapabilityWithoutTransportPairing() {
    val pendingNode =
      androidNode(
        paired = false,
        approvalState = GatewayNodeApprovalState.PendingApproval,
        pendingRequestId = "node-request-1",
      )

    val rows =
      homeAttentionRows(
        isConnected = true,
        pendingApprovals = 0,
        channelsSummary = emptyChannels(),
        nodesDevicesSummary =
          GatewayNodesDevicesSummary(
            nodes = listOf(pendingNode),
            pendingDevices = emptyList(),
            pairedDevices = emptyList(),
          ),
        readyProviderCount = 1,
      )

    assertEquals("Approval Pending", nodeStatusText(pendingNode))
    assertTrue(nodeSubtitle(pendingNode).contains("openclaw nodes approve node-request-1"))
    assertEquals(listOf("Nodes & Devices"), rows.map { it.title })
    assertEquals("1 pending", rows.single().subtitle)
  }

  @Test
  fun homeAttentionRowsSurfaceUnavailableNodeCapabilitiesSeparatelyFromPendingRequests() {
    val rows =
      homeAttentionRows(
        isConnected = true,
        pendingApprovals = 0,
        channelsSummary = emptyChannels(),
        nodesDevicesSummary =
          GatewayNodesDevicesSummary(
            nodes = listOf(androidNode(approvalState = GatewayNodeApprovalState.Unapproved)),
            pendingDevices = emptyList(),
            pairedDevices = emptyList(),
          ),
        readyProviderCount = 1,
      )

    assertEquals(listOf("Nodes & Devices"), rows.map { it.title })
    assertEquals("1 unavailable", rows.single().subtitle)
  }

  private fun emptyChannels(): GatewayChannelsSummary = GatewayChannelsSummary(channels = emptyList())

  private fun emptyNodesDevices(): GatewayNodesDevicesSummary = GatewayNodesDevicesSummary(nodes = emptyList(), pendingDevices = emptyList(), pairedDevices = emptyList())

  private fun androidNode(
    approvalState: GatewayNodeApprovalState,
    pendingRequestId: String? = null,
    paired: Boolean = true,
    connected: Boolean = true,
    commands: List<String> = emptyList(),
  ): GatewayNodeSummary =
    GatewayNodeSummary(
      id = "android-node",
      displayName = "Android",
      remoteIp = null,
      version = null,
      deviceFamily = "Android",
      paired = paired,
      connected = connected,
      approvalState = approvalState,
      pendingRequestId = pendingRequestId,
      capabilities = emptyList(),
      commands = commands,
    )
}
