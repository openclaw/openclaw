package ai.openclaw.app.ui

import ai.openclaw.app.AppearanceThemeMode
import ai.openclaw.app.GatewayChannelSummary
import ai.openclaw.app.GatewayChannelsSummary
import ai.openclaw.app.GatewayNodeApprovalState
import ai.openclaw.app.GatewayNodeSummary
import ai.openclaw.app.GatewayNodesDevicesSummary
import ai.openclaw.app.GatewayPendingDeviceSummary
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Settings
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
  fun homeAttentionRowsSurfacePendingNodeCapabilityApproval() {
    val rows =
      homeAttentionRows(
        isConnected = true,
        pendingApprovals = 0,
        channelsSummary = emptyChannels(),
        nodesDevicesSummary =
          GatewayNodesDevicesSummary(
            nodes =
              listOf(
                GatewayNodeSummary(
                  id = "android-node",
                  displayName = "Android",
                  remoteIp = null,
                  version = null,
                  deviceFamily = "Android",
                  paired = true,
                  connected = true,
                  approvalState = GatewayNodeApprovalState.PendingApproval,
                  pendingRequestId = null,
                  capabilities = emptyList(),
                  commands = emptyList(),
                ),
              ),
            pendingDevices = emptyList(),
            pairedDevices = emptyList(),
          ),
        readyProviderCount = 1,
      )

    assertEquals(listOf("Nodes & Devices"), rows.map { it.title })
    assertEquals("Node approval pending", rows.single().subtitle)
  }

  @Test
  fun settingsSectionTitlesGroupPowerSettingsByMeaning() {
    assertEquals("Connection", settingsSectionTitleForRoute(SettingsRoute.Gateway))
    assertEquals("Connection", settingsSectionTitleForRoute(SettingsRoute.NodesDevices))
    assertEquals("Agents & automation", settingsSectionTitleForRoute(SettingsRoute.Approvals))
    assertEquals("Agents & automation", settingsSectionTitleForRoute(SettingsRoute.CronJobs))
    assertEquals("Phone context & privacy", settingsSectionTitleForRoute(SettingsRoute.PhoneCapabilities))
    assertEquals("Phone context & privacy", settingsSectionTitleForRoute(SettingsRoute.Notifications))
    assertEquals("Profile & device", settingsSectionTitleForRoute(SettingsRoute.Appearance))
    assertEquals("Diagnostics", settingsSectionTitleForRoute(SettingsRoute.Health))
  }

  @Test
  fun settingsSectionsPreserveMeaningfulOrder() {
    val sections =
      settingsSections(
        listOf(
          settingsRow(SettingsRoute.Voice),
          settingsRow(SettingsRoute.Agents),
          settingsRow(SettingsRoute.Gateway),
          settingsRow(SettingsRoute.Appearance),
          settingsRow(SettingsRoute.Health),
        ),
      )

    assertEquals(
      listOf(
        "Connection",
        "Agents & automation",
        "Phone context & privacy",
        "Profile & device",
        "Diagnostics",
      ),
      sections.map { it.title },
    )
  }

  private fun emptyChannels(): GatewayChannelsSummary = GatewayChannelsSummary(channels = emptyList())

  private fun emptyNodesDevices(): GatewayNodesDevicesSummary = GatewayNodesDevicesSummary(nodes = emptyList(), pendingDevices = emptyList(), pairedDevices = emptyList())

  private fun settingsRow(route: SettingsRoute): SettingsRow = SettingsRow(route.name, "Value", Icons.Default.Settings, route = route)
}
