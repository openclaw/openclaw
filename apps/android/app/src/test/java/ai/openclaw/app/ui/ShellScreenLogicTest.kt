package ai.openclaw.app.ui

import ai.openclaw.app.AppearanceThemeMode
import ai.openclaw.app.GatewayAgentSummary
import ai.openclaw.app.GatewayChannelSummary
import ai.openclaw.app.GatewayChannelsSummary
import ai.openclaw.app.GatewayNodeApprovalState
import ai.openclaw.app.GatewayNodeSummary
import ai.openclaw.app.GatewayNodesDevicesSummary
import ai.openclaw.app.GatewayPendingDeviceSummary
import ai.openclaw.app.ui.design.ClawStatus
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
    assertEquals(SettingsRoute.ProvidersModels, providersRow.settingsRoute)
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
  fun overviewHeaderStateReflectsGatewayConnectionAndAttention() {
    assertEquals(OverviewHeaderState("Offline", ClawStatus.Neutral), overviewHeaderState(isConnected = false, hasAttention = true))
    assertEquals(OverviewHeaderState("Needs attention", ClawStatus.Warning), overviewHeaderState(isConnected = true, hasAttention = true))
    assertEquals(OverviewHeaderState("Online", ClawStatus.Success), overviewHeaderState(isConnected = true, hasAttention = false))
  }

  @Test
  fun overviewHeaderRouteUsesFirstAttentionDestination() {
    assertEquals(SettingsRoute.Gateway, overviewHeaderRoute(emptyList()))
    assertEquals(
      SettingsRoute.Approvals,
      overviewHeaderRoute(
        listOf(
          HomeAttentionRow("Approvals", "2 pending", Icons.Default.Settings, Tab.Settings, SettingsRoute.Approvals),
          HomeAttentionRow("Nodes & Devices", "Review node access", Icons.Default.Settings, Tab.Settings, SettingsRoute.NodesDevices),
        ),
      ),
    )
  }

  @Test
  fun overviewMetricCardsUseRealGatewayNodeApprovalAndSessionCounts() {
    val cards =
      overviewMetricCardSpecs(
        isConnected = true,
        hasAttention = true,
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
                  approvalState = GatewayNodeApprovalState.PendingReapproval,
                  pendingRequestId = "node-request",
                  capabilities = emptyList(),
                  commands = emptyList(),
                ),
              ),
            pendingDevices = emptyList(),
            pairedDevices = emptyList(),
          ),
        pendingApprovals = 2,
        sessionCount = 4,
      )

    assertEquals(listOf("Gateway", "Nodes", "Approvals", "Sessions"), cards.map { it.title })
    assertEquals("Online", cards.single { it.title == "Gateway" }.value)
    assertEquals("Review highlighted items", cards.single { it.title == "Gateway" }.subtitle)
    assertEquals("1/1", cards.single { it.title == "Nodes" }.value)
    assertEquals("Review node access", cards.single { it.title == "Nodes" }.subtitle)
    assertEquals(ClawStatus.Warning, cards.single { it.title == "Nodes" }.status)
    assertEquals(1f, cards.single { it.title == "Nodes" }.progressFraction ?: 0f, 0.001f)
    assertEquals("2", cards.single { it.title == "Approvals" }.value)
    assertEquals("4", cards.single { it.title == "Sessions" }.value)
  }

  @Test
  fun overviewNodeCardShowsRoundedOnlinePercentWhenNoNodeApprovalIsPending() {
    val cards =
      overviewMetricCardSpecs(
        isConnected = true,
        hasAttention = false,
        nodesDevicesSummary =
          GatewayNodesDevicesSummary(
            nodes =
              (1..3).map { index ->
                GatewayNodeSummary(
                  id = "node-$index",
                  displayName = "Node $index",
                  remoteIp = null,
                  version = null,
                  deviceFamily = null,
                  paired = true,
                  connected = index <= 2,
                  approvalState = GatewayNodeApprovalState.Approved,
                  pendingRequestId = null,
                  capabilities = emptyList(),
                  commands = emptyList(),
                )
              },
            pendingDevices = emptyList(),
            pairedDevices = emptyList(),
          ),
        pendingApprovals = 0,
        sessionCount = 0,
      )

    val nodes = cards.single { it.title == "Nodes" }
    assertEquals("2/3", nodes.value)
    assertEquals("67% online", nodes.subtitle)
    assertEquals(2f / 3f, nodes.progressFraction ?: 0f, 0.001f)
  }

  @Test
  fun overviewGatewayCardOnlyClaimsNominalWhenNoAttentionExists() {
    val cards =
      overviewMetricCardSpecs(
        isConnected = true,
        hasAttention = false,
        nodesDevicesSummary = emptyNodesDevices(),
        pendingApprovals = 0,
        sessionCount = 0,
      )

    val gateway = cards.single { it.title == "Gateway" }
    assertEquals("Healthy", gateway.value)
    assertEquals("All systems nominal", gateway.subtitle)
    assertEquals(ClawStatus.Success, gateway.status)
  }

  @Test
  fun overviewAgentNameUsesDefaultAgentWhenPresent() {
    val agents =
      listOf(
        GatewayAgentSummary(id = "main", name = "Main", emoji = null),
        GatewayAgentSummary(id = "scout", name = "Scout", emoji = "🦾"),
      )

    assertEquals("Scout", overviewAgentName(agents = agents, defaultAgentId = "scout"))
    assertEquals("Main", overviewAgentName(agents = agents, defaultAgentId = null))
    assertEquals("OpenClaw", overviewAgentName(agents = emptyList(), defaultAgentId = null))
  }

  @Test
  fun overviewAgentBadgeUsesEmojiBeforeInitials() {
    val agents =
      listOf(
        GatewayAgentSummary(id = "main", name = "Main Agent", emoji = null),
        GatewayAgentSummary(id = "scout", name = "Scout", emoji = "🦾"),
      )

    assertEquals("🦾", overviewAgentBadgeText(agents = agents, defaultAgentId = "scout"))
    assertEquals("MA", overviewAgentBadgeText(agents = agents, defaultAgentId = "main"))
    assertEquals("OC", overviewAgentBadgeText(agents = emptyList(), defaultAgentId = null))
  }

  @Test
  fun overviewAgentActivityTextUsesRealRuntimeCounts() {
    assertEquals(
      "Working · 2 active runs",
      overviewAgentActivityText(isConnected = true, pendingRunCount = 2, sessionCount = 50, cronJobCount = 19, statusText = "Online and ready"),
    )
    assertEquals(
      "Monitoring · 50 sessions",
      overviewAgentActivityText(isConnected = true, pendingRunCount = 0, sessionCount = 50, cronJobCount = 19, statusText = "Online and ready"),
    )
    assertEquals(
      "Gateway offline",
      overviewAgentActivityText(isConnected = false, pendingRunCount = 0, sessionCount = 50, cronJobCount = 19, statusText = "Gateway offline"),
    )
  }

  @Test
  fun sessionSourceLabelDerivesCompactSourceFromRealSessionKey() {
    assertEquals("Telegram", sessionSourceLabel("telegram:8227096397"))
    assertEquals("Discord", sessionSourceLabel("discord:1465779285020381361#daily-inf"))
    assertEquals("Cron", sessionSourceLabel("Cron: nightly-reflection"))
    assertEquals("Telegram", sessionSourceLabel("agent:main:telegram:direct:584667058"))
    assertEquals("Discord", sessionSourceLabel("agent:main:discord:channel:1001"))
    assertEquals("Slack", sessionSourceLabel("agent:main:slack:channel:C123"))
    assertEquals("OpenClaw", sessionSourceLabel("agent:main:node-android"))
    assertEquals("OpenClaw", sessionSourceLabel("agent:main:main"))
    assertEquals("OpenClaw", sessionSourceLabel("Daily standup"))
  }

  @Test
  fun sessionSourceLabelUsesGatewayChannelLabelsForFutureSources() {
    val channels =
      GatewayChannelsSummary(
        channels =
          listOf(
            GatewayChannelSummary(
              id = "matrix",
              label = "Matrix",
              accountCount = 1,
              enabled = true,
              configured = true,
              linked = true,
              running = true,
              connected = true,
              error = null,
            ),
          ),
      )

    assertEquals("Matrix", sessionSourceLabel("agent:main:matrix:room:abc", channels))
  }

  @Test
  fun settingsSectionTitlesGroupPowerSettingsByMeaning() {
    assertEquals("Connection", settingsSectionTitleForRoute(SettingsRoute.Gateway))
    assertEquals("Connection", settingsSectionTitleForRoute(SettingsRoute.NodesDevices))
    assertEquals("Agents & automation", settingsSectionTitleForRoute(SettingsRoute.ProvidersModels))
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
