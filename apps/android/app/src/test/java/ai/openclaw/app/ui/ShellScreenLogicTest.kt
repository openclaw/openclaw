package ai.openclaw.app.ui

import ai.openclaw.app.AppearanceThemeMode
import ai.openclaw.app.GatewayAgentSummary
import ai.openclaw.app.GatewayChannelSummary
import ai.openclaw.app.GatewayChannelsSummary
import ai.openclaw.app.GatewayConnectionDisplay
import ai.openclaw.app.GatewayConnectionProblem
import ai.openclaw.app.GatewayNodeCapabilityApproval
import ai.openclaw.app.GatewayNodeSummary
import ai.openclaw.app.GatewayNodesDevicesSummary
import ai.openclaw.app.GatewayPendingDeviceSummary
import ai.openclaw.app.chat.ChatSessionEntry
import ai.openclaw.app.gatewayConnectionDisplay
import ai.openclaw.app.i18n.resolveNativeText
import ai.openclaw.app.i18n.verbatimText
import ai.openclaw.app.normalizeOperatorScopes
import ai.openclaw.app.ui.design.ClawStatus
import androidx.compose.runtime.saveable.SaverScope
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.util.Locale

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class ShellScreenLogicTest {
  @Test
  fun localizedUppercaseUsesTheSelectedAppLocale() {
    assertEquals("İLETİŞİM", localizedUppercase("iletişim", languageTag = "tr", fallbackLocale = Locale.US))
  }

  @Test
  fun settingsDisclosureUsesTheLocalizedTitle() {
    assertEquals("Open Nœuds et appareils", settingsRowDisclosureDescription("Nœuds et appareils", opensRoute = true))
    assertEquals("Nœuds et appareils", settingsRowDisclosureDescription("Nœuds et appareils", opensRoute = false))
  }

  @Test
  fun appearanceThemeModeDefaultsToDarkForExistingInstalls() {
    assertEquals(AppearanceThemeMode.Dark, AppearanceThemeMode.fromRawValue(null))
    assertEquals(AppearanceThemeMode.Dark, AppearanceThemeMode.fromRawValue("unknown"))
  }

  @Test
  fun appearanceThemeLabelsFollowSettingsOptionOrder() {
    assertEquals(listOf("System", "Dark", "Light"), AppearanceThemeMode.entries.map(::appearanceThemeSummary))
  }

  @Test
  fun appearanceThemeModeResolvesAgainstSystemPreference() {
    assertFalse(AppearanceThemeMode.System.isDark(systemDark = false))
    assertTrue(AppearanceThemeMode.System.isDark(systemDark = true))
    assertTrue(AppearanceThemeMode.Dark.isDark(systemDark = false))
    assertFalse(AppearanceThemeMode.Light.isDark(systemDark = true))
  }

  @Test
  fun settingsRouteOpenedCrossTabReturnsToOriginTab() {
    val nav = ShellNavigation()
    nav.selectTab(Tab.Chat)
    nav.openSettingsRoute(SettingsRoute.Gateway)
    assertEquals(Tab.Settings, nav.activeTab)
    assertEquals(SettingsRoute.Gateway, nav.settingsRoute)

    nav.back()
    assertEquals(Tab.Chat, nav.activeTab)
    assertEquals(SettingsRoute.Home, nav.settingsRoute)

    nav.back()
    assertEquals(Tab.Overview, nav.activeTab)
  }

  @Test
  fun settingsRouteOpenedFromOverviewReturnsToOverview() {
    val nav = ShellNavigation()
    nav.openSettingsRoute(SettingsRoute.Approvals)
    nav.back()
    assertEquals(Tab.Overview, nav.activeTab)
    assertEquals(SettingsRoute.Home, nav.settingsRoute)
  }

  @Test
  fun tabBarSettingsSelectionOpensHomeAndBacksToOverview() {
    val nav = ShellNavigation()
    nav.selectTab(Tab.Chat)
    nav.openSettingsRoute(SettingsRoute.Voice)
    nav.selectTab(Tab.Settings)
    assertEquals(SettingsRoute.Home, nav.settingsRoute)

    nav.back()
    assertEquals(Tab.Overview, nav.activeTab)
  }

  @Test
  fun settingsDetailOpenedFromHomeUnwindsToHomeBeforeLeavingSettings() {
    val nav = ShellNavigation()
    nav.selectTab(Tab.Chat)
    nav.openSettingsRoute(SettingsRoute.Home)
    nav.openSettingsRouteFromHome(SettingsRoute.Gateway)

    nav.back()
    assertEquals(Tab.Settings, nav.activeTab)
    assertEquals(SettingsRoute.Home, nav.settingsRoute)

    nav.back()
    assertEquals(Tab.Chat, nav.activeTab)
  }

  @Test
  fun detailTabsReturnToTheTabThatOpenedThem() {
    val nav = ShellNavigation()
    nav.selectTab(Tab.Chat)
    nav.openDetailTab(Tab.Sessions)
    nav.back()
    assertEquals(Tab.Chat, nav.activeTab)

    nav.selectTab(Tab.Chat)
    nav.openDetailTab(Tab.ProvidersModels)
    nav.back()
    assertEquals(Tab.Chat, nav.activeTab)
  }

  @Test
  fun sessionDashboardRoutePreservesTheOpeningSessionAndReturnsToChat() {
    val nav = ShellNavigation()
    nav.selectTab(Tab.Chat)

    nav.openSessionDashboard("agent:main:phone")

    assertEquals(Tab.Dashboard, nav.activeTab)
    assertEquals("agent:main:phone", nav.dashboardSessionKey)
    nav.back()
    assertEquals(Tab.Chat, nav.activeTab)
  }

  @Test
  fun tabBarSelectionClearsCrossTabReturnOrigin() {
    val nav = ShellNavigation()
    nav.selectTab(Tab.Chat)
    nav.openDetailTab(Tab.Sessions)
    nav.selectTab(Tab.Chat)
    nav.back()
    assertEquals(Tab.Overview, nav.activeTab)
  }

  @Test
  fun shellNavigationSaverRoundTripsCrossTabState() {
    val nav = ShellNavigation()
    nav.selectTab(Tab.Chat)
    nav.openSettingsRoute(SettingsRoute.Gateway)

    val saveAnything = SaverScope { true }
    val saved = with(ShellNavigation.Saver) { saveAnything.save(nav) }!!
    val restored = ShellNavigation.Saver.restore(saved)!!

    assertEquals(Tab.Settings, restored.activeTab)
    assertEquals(SettingsRoute.Gateway, restored.settingsRoute)
    restored.back()
    assertEquals(Tab.Chat, restored.activeTab)
  }

  @Test
  fun shellNavigationSaverRestoresLegacyVoiceDestinationsToChat() {
    val activeVoice = ShellNavigation.Saver.restore(listOf("Voice", "Home", "", "false", "main"))!!
    assertEquals(Tab.Chat, activeVoice.activeTab)

    val returnToVoice = ShellNavigation.Saver.restore(listOf("Settings", "Gateway", "Voice", "false", "main"))!!
    returnToVoice.back()
    assertEquals(Tab.Chat, returnToVoice.activeTab)

    val saveAnything = SaverScope { true }
    val saved = with(ShellNavigation.Saver) { saveAnything.save(returnToVoice) }!!
    assertEquals(listOf("Chat", "Home", "", "false", "main"), saved)
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
  fun homeAttentionRowsDoNotClaimUnknownProvidersAreUnavailable() {
    val rows =
      homeAttentionRows(
        isConnected = true,
        pendingApprovals = 0,
        channelsSummary = emptyChannels(),
        nodesDevicesSummary = emptyNodesDevices(),
        readyProviderCount = 0,
        unknownProviderCount = 1,
      )

    assertEquals(emptyList<String>(), rows.map { it.title })
  }

  @Test
  fun operatorScopesNormalizeForStableAdminChecks() {
    assertEquals(
      listOf("operator.admin", "operator.read", "operator.write"),
      normalizeOperatorScopes(
        listOf(" operator.write ", "operator.admin", "", "operator.write", "operator.read"),
      ),
    )
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
                  approvalState = GatewayNodeCapabilityApproval.PendingApproval(null),
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
          HomeAttentionRow("Approvals", "2 pending", SettingsRoute.Approvals),
          HomeAttentionRow("Nodes & Devices", "Review node access", SettingsRoute.NodesDevices),
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
                  approvalState = GatewayNodeCapabilityApproval.PendingReapproval("node-request"),
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

    assertEquals(listOf("Gateway", "Nodes", "Approvals", "Threads", "Files"), cards.map { it.title })
    assertEquals("Online", cards.single { it.title == "Gateway" }.value)
    assertEquals("Review highlighted items", cards.single { it.title == "Gateway" }.subtitle)
    assertNull(cards.single { it.title == "Nodes" }.value)
    assertEquals("Review node access", cards.single { it.title == "Nodes" }.subtitle)
    assertEquals(ClawStatus.Warning, cards.single { it.title == "Nodes" }.status)
    assertEquals("2", cards.single { it.title == "Approvals" }.value)
    assertEquals("4", cards.single { it.title == "Threads" }.value)
    assertEquals("Browse", cards.single { it.title == "Files" }.value)
    assertEquals(Tab.Files, cards.single { it.title == "Files" }.tab)
  }

  @Test
  fun overviewRecentSessionCountIgnoresRetainedRowsOutsideTheRecentWindow() {
    val sessions =
      (1..51).map { index ->
        ChatSessionEntry(key = "session-$index", updatedAtMs = index.toLong())
      }

    assertEquals(50, overviewRecentSessions(sessions).size)
    assertEquals((51 downTo 2).map { "session-$it" }, overviewRecentSessions(sessions).map { it.key })
  }

  @Test
  fun overviewRecentSessionsSortByMostRecentTimestamp() {
    val sessions =
      listOf(
        ChatSessionEntry(key = "cron", updatedAtMs = 2),
        ChatSessionEntry(key = "main", updatedAtMs = 3),
        ChatSessionEntry(key = "telegram", updatedAtMs = 1),
      )

    assertEquals(listOf("main", "cron", "telegram"), overviewRecentSessions(sessions).map { session -> session.key })
  }

  @Test
  fun overviewRecentSessionsPreferLastActivityForRecency() {
    val sessions =
      listOf(
        ChatSessionEntry(key = "main", updatedAtMs = 10, lastActivityAt = 10),
        ChatSessionEntry(key = "cron", updatedAtMs = 50, lastActivityAt = 20),
        ChatSessionEntry(key = "telegram", updatedAtMs = 1, lastActivityAt = 100),
      )

    assertEquals(listOf("telegram", "cron", "main"), overviewRecentSessions(sessions).map { session -> session.key })
  }

  @Test
  fun overviewRecentSessionsDeduplicateByNewestEntry() {
    val sessions =
      overviewRecentSessions(
        listOf(
          ChatSessionEntry(key = "main", displayName = "Stale main", updatedAtMs = 10, lastActivityAt = 10),
          ChatSessionEntry(key = "cron", displayName = "Cron", updatedAtMs = 2),
          ChatSessionEntry(key = "main", displayName = "Fresh main", updatedAtMs = 3, lastActivityAt = 30),
        ),
      )

    assertEquals(listOf("main", "cron"), sessions.map { session -> session.key })
    assertEquals("Fresh main", sessions.first().displayName)
  }

  @Test
  fun overviewRecentSessionsUseStableKeyOrderWhenTimestampsMatch() {
    assertEquals(
      listOf("cron", "main", "telegram"),
      overviewRecentSessions(
        listOf(
          ChatSessionEntry(key = "telegram", updatedAtMs = 1),
          ChatSessionEntry(key = "main", updatedAtMs = 1),
          ChatSessionEntry(key = "cron", updatedAtMs = 1),
        ),
      ).map { session -> session.key },
    )
  }

  @Test
  fun overviewRecentSessionRowsUseLastActivityForMetadata() {
    val rows =
      overviewRecentSessionRows(
        sessions = listOf(ChatSessionEntry(key = "main", updatedAtMs = null, lastActivityAt = System.currentTimeMillis())),
        channelsSummary = emptyChannels(),
      )

    assertTrue(rows.single().metadata.isNotBlank())
  }

  @Test
  fun stableOverviewRecentRowsKeepPreviousMetadataDuringPartialRefresh() {
    val rows =
      stableOverviewRecentRows(
        previousRows =
          listOf(
            RecentSessionListItem(key = "main", title = "Main session", source = "OpenClaw", metadata = "1h"),
          ),
        candidateRows =
          listOf(
            RecentSessionListItem(key = "main", title = "Main session", source = "OpenClaw", metadata = ""),
          ),
      )

    assertEquals("1h", rows.single().metadata)
  }

  @Test
  fun stableOverviewRecentRowsFollowCandidateRows() {
    val rows =
      stableOverviewRecentRows(
        previousRows =
          listOf(
            RecentSessionListItem(key = "main", title = "Main session", source = "OpenClaw", metadata = "1h"),
            RecentSessionListItem(key = "discord", title = "Discord", source = "Discord", metadata = "2h"),
          ),
        candidateRows =
          listOf(
            RecentSessionListItem(key = "main", title = "Main session", source = "OpenClaw", metadata = "1h"),
            RecentSessionListItem(key = "cron", title = "Cron", source = "Cron", metadata = "4h"),
          ),
      )

    assertEquals(listOf("main", "cron"), rows.map { row -> row.key })
  }

  @Test
  fun overviewNodeCardSummarizesOnlineNodesOnceWhenNoApprovalIsPending() {
    for ((online, total, expected) in listOf(
      Triple(8, 9, "8 of 9 online"),
      Triple(9, 9, "9 online"),
      Triple(0, 9, "0 of 9 online"),
      Triple(0, 0, "None paired"),
      Triple(1, 1, "1 online"),
    )) {
      val cards =
        overviewMetricCardSpecs(
          isConnected = true,
          hasAttention = false,
          nodesDevicesSummary =
            GatewayNodesDevicesSummary(
              nodes =
                (1..total).map { index ->
                  GatewayNodeSummary(
                    id = "node-$index",
                    displayName = "Node $index",
                    remoteIp = null,
                    version = null,
                    deviceFamily = null,
                    paired = true,
                    connected = index <= online,
                    approvalState = GatewayNodeCapabilityApproval.Approved,
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
      assertNull(nodes.value)
      assertEquals(expected, nodes.subtitle)
      assertEquals(SettingsRoute.NodesDevices, nodes.settingsRoute)
    }
  }

  @Test
  fun overviewGatewayCardDoesNotClaimHealthWhenProviderAvailabilityIsUnknown() {
    val attentionRows =
      homeAttentionRows(
        isConnected = true,
        pendingApprovals = 0,
        channelsSummary = emptyChannels(),
        nodesDevicesSummary = emptyNodesDevices(),
        readyProviderCount = 0,
        unknownProviderCount = 1,
      )
    val cards =
      overviewMetricCardSpecs(
        isConnected = true,
        hasAttention = attentionRows.isNotEmpty(),
        nodesDevicesSummary = emptyNodesDevices(),
        pendingApprovals = 0,
        sessionCount = 0,
      )

    val gateway = cards.single { it.title == "Gateway" }
    assertEquals("Online", gateway.value)
    assertEquals("No highlighted items", gateway.subtitle)
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
    assertEquals(
      "🧭S",
      overviewAgentBadgeText(
        agents = listOf(GatewayAgentSummary(id = "emoji", name = "🧭 Scout", emoji = null)),
        defaultAgentId = "emoji",
      ),
    )
    assertEquals("OC", overviewAgentBadgeText(agents = emptyList(), defaultAgentId = null))
  }

  @Test
  fun overviewAgentActivityTextUsesRealRuntimeCounts() {
    assertEquals(
      "Working · 2 active runs",
      overviewAgentActivityText(isConnected = true, pendingRunCount = 2, sessionCount = 50, cronJobCount = 19, statusText = "Online and ready"),
    )
    assertEquals(
      "Monitoring · 50 threads",
      overviewAgentActivityText(isConnected = true, pendingRunCount = 0, sessionCount = 50, cronJobCount = 19, statusText = "Online and ready"),
    )
    assertEquals(
      "Gateway offline",
      overviewAgentActivityText(isConnected = false, pendingRunCount = 0, sessionCount = 50, cronJobCount = 19, statusText = "Gateway offline"),
    )
  }

  @Test
  fun channelsSummaryTextUsesDistinctIssuePluralization() {
    fun channel(
      id: String,
      error: String?,
    ) = GatewayChannelSummary(
      id = id,
      label = id,
      accountCount = 1,
      enabled = true,
      configured = true,
      linked = true,
      running = error == null,
      connected = error == null,
      error = error,
    )

    assertEquals(
      "1 issue",
      channelsSummaryText(GatewayChannelsSummary(channels = listOf(channel("one", "offline")))),
    )
    assertEquals(
      "2 issues",
      channelsSummaryText(
        GatewayChannelsSummary(
          channels = listOf(channel("one", "offline"), channel("two", "unauthorized")),
        ),
      ),
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
  fun settingsSectionsSeparatePersonalConfigurationFromWorkspaceAndFeaturedRoutes() {
    val sections =
      settingsSections(
        listOf(
          settingsRow(SettingsRoute.Voice),
          settingsRow(SettingsRoute.SystemAgent),
          settingsRow(SettingsRoute.Gateway),
          settingsRow(SettingsRoute.Appearance),
          settingsRow(SettingsRoute.ProvidersModels),
          settingsRow(SettingsRoute.Approvals),
          settingsRow(SettingsRoute.NodesDevices),
          settingsRow(SettingsRoute.CronJobs),
          settingsRow(SettingsRoute.PhoneCapabilities),
          settingsRow(SettingsRoute.Notifications),
          settingsRow(SettingsRoute.Health),
        ),
      )

    assertEquals(
      listOf(
        "Profile & appearance" to listOf(SettingsRoute.Appearance),
        "This phone" to listOf(SettingsRoute.Voice, SettingsRoute.PhoneCapabilities, SettingsRoute.Notifications),
        "Connections" to listOf(SettingsRoute.Gateway, SettingsRoute.NodesDevices),
        "Configuration" to listOf(SettingsRoute.ProvidersModels, SettingsRoute.Approvals),
        "System" to listOf(SettingsRoute.Health),
      ),
      sections.map { section -> section.title.resolveNativeText() to section.rows.map { it.route } },
    )
  }

  @Test
  fun gatewaySummaryUsesStructuredProblemForCurrentAuthFailure() {
    assertEquals(
      "Gateway token needed",
      gatewaySummary(
        "Gateway error: unauthorized: gateway token missing",
        isConnected = false,
        gatewayConnectionProblem = authProblem("AUTH_TOKEN_MISSING"),
      ),
    )
    assertEquals(
      "Device identity required",
      gatewaySummary(
        "Gateway error: device identity required",
        isConnected = false,
        gatewayConnectionProblem = authProblem("DEVICE_IDENTITY_REQUIRED"),
      ),
    )
  }

  @Test
  fun gatewaySummaryFallsBackToGenericAuthLabelWithoutAKnownReason() {
    assertEquals("Authentication needed", gatewaySummary("auth failed", isConnected = false, gatewayConnectionProblem = null))
    assertEquals("Authentication needed", gatewaySummary("auth failed", isConnected = false, gatewayConnectionProblem = authProblem("SOME_UNMAPPED_CODE")))
  }

  @Test
  fun gatewaySummaryPreservesNodeFailureWhileOperatorStaysConnected() {
    val display =
      gatewayConnectionDisplay(
        operatorConnected = true,
        nodeConnected = false,
        operatorStatusText = "Connected",
        nodeStatusText = "Gateway error: pairing required",
        operatorProblem = null,
        nodeProblem = authProblem("PAIRING_REQUIRED"),
      )

    assertEquals("Connected (node offline)", gatewaySummary(display))
  }

  @Test
  fun gatewaySummaryLeavesUnrelatedStatesUnaffectedByConnectionProblem() {
    val problem = authProblem("AUTH_TOKEN_MISSING")
    assertEquals("Online and ready", gatewaySummary("auth failed", isConnected = true, gatewayConnectionProblem = authProblem("AUTH_TOKEN_MISSING")))
    assertEquals("Connecting...", gatewaySummary("Reconnecting", isConnected = false, gatewayConnectionProblem = problem))
    assertEquals("Waiting for pairing", gatewaySummary("Pairing in progress", isConnected = false, gatewayConnectionProblem = problem))
    assertEquals("Certificate review needed", gatewaySummary("TLS handshake failed", isConnected = false, gatewayConnectionProblem = problem))
  }

  @Test
  fun gatewaySummaryUsesAtomicRetryDisplayAfterAuthFailure() {
    val retrying =
      GatewayConnectionDisplay(
        isConnected = false,
        statusText = "Reconnecting…",
        problem = null,
      )

    assertEquals("Connecting...", gatewaySummary(retrying))
  }

  private fun emptyChannels(): GatewayChannelsSummary = GatewayChannelsSummary(channels = emptyList())

  private fun emptyNodesDevices(): GatewayNodesDevicesSummary = GatewayNodesDevicesSummary(nodes = emptyList(), pendingDevices = emptyList(), pairedDevices = emptyList())

  private fun settingsRow(route: SettingsRoute): SettingsRow = SettingsRow(route, verbatimText("Value"))

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
