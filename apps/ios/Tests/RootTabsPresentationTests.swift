import SwiftUI
import Testing
import UIKit
@testable import OpenClaw

@MainActor
@Suite struct RootTabsPresentationTests {
    @Test func quickSetupDoesNotPresentWhenGatewayAlreadyConfigured() {
        let shouldPresent = RootTabs.shouldPresentQuickSetup(
            quickSetupDismissed: false,
            showOnboarding: false,
            hasPresentedSheet: false,
            gatewayConnected: false,
            hasExistingGatewayConfig: true,
            discoveredGatewayCount: 1)

        #expect(!shouldPresent)
    }

    @Test func quickSetupPresentsForFreshInstallWithDiscoveredGateway() {
        let shouldPresent = RootTabs.shouldPresentQuickSetup(
            quickSetupDismissed: false,
            showOnboarding: false,
            hasPresentedSheet: false,
            gatewayConnected: false,
            hasExistingGatewayConfig: false,
            discoveredGatewayCount: 1)

        #expect(shouldPresent)
    }

    @Test func quickSetupDoesNotPresentWhenAlreadyConnected() {
        let shouldPresent = RootTabs.shouldPresentQuickSetup(
            quickSetupDismissed: false,
            showOnboarding: false,
            hasPresentedSheet: false,
            gatewayConnected: true,
            hasExistingGatewayConfig: false,
            discoveredGatewayCount: 1)

        #expect(!shouldPresent)
    }

    @Test func gatewayEntryKeepsConfiguredOfflineUsersInGatewaySettings() {
        #expect(
            RootTabs.gatewayEntryPresentationRoute(
                gatewayConnected: false,
                hasConnectedOnce: false,
                onboardingComplete: false,
                hasExistingGatewayConfig: true,
                isPreviewMode: false) == .gateway)
        #expect(
            RootTabs.gatewayEntryPresentationRoute(
                gatewayConnected: false,
                hasConnectedOnce: true,
                onboardingComplete: false,
                hasExistingGatewayConfig: false,
                isPreviewMode: false) == .gateway)
        #expect(
            RootTabs.gatewayEntryPresentationRoute(
                gatewayConnected: false,
                hasConnectedOnce: false,
                onboardingComplete: true,
                hasExistingGatewayConfig: false,
                isPreviewMode: false) == .gateway)
    }

    @Test func gatewayEntryOpensOnboardingForFreshAndPreviewUsers() {
        #expect(
            RootTabs.gatewayEntryPresentationRoute(
                gatewayConnected: false,
                hasConnectedOnce: false,
                onboardingComplete: false,
                hasExistingGatewayConfig: false,
                isPreviewMode: false) == .onboarding)
        #expect(
            RootTabs.gatewayEntryPresentationRoute(
                gatewayConnected: false,
                hasConnectedOnce: true,
                onboardingComplete: true,
                hasExistingGatewayConfig: true,
                isPreviewMode: true) == .onboarding)
    }

    @Test func startupKeepsSavedGatewayUsersOutOfFirstRunOnboarding() {
        let savedConfigRoute = RootTabs.startupPresentationRoute(
            gatewayConnected: false,
            hasConnectedOnce: false,
            onboardingComplete: false,
            hasExistingGatewayConfig: true,
            shouldPresentOnLaunch: false)
        let manualConfigRoute = RootTabs.startupPresentationRoute(
            gatewayConnected: false,
            hasConnectedOnce: false,
            onboardingComplete: false,
            hasExistingGatewayConfig: true,
            shouldPresentOnLaunch: true)
        let completedWithConfigRoute = RootTabs.startupPresentationRoute(
            gatewayConnected: false,
            hasConnectedOnce: true,
            onboardingComplete: true,
            hasExistingGatewayConfig: true,
            shouldPresentOnLaunch: false)

        #expect(savedConfigRoute == .none)
        #expect(manualConfigRoute == .none)
        #expect(completedWithConfigRoute == .none)
    }

    @Test func startupStillGuidesFreshAndBrokenGatewayStates() {
        #expect(
            RootTabs.startupPresentationRoute(
                gatewayConnected: true,
                hasConnectedOnce: false,
                onboardingComplete: false,
                hasExistingGatewayConfig: false,
                shouldPresentOnLaunch: true) == .none)
        #expect(
            RootTabs.startupPresentationRoute(
                gatewayConnected: false,
                hasConnectedOnce: false,
                onboardingComplete: false,
                hasExistingGatewayConfig: false,
                shouldPresentOnLaunch: true) == .onboarding)
        #expect(
            RootTabs.startupPresentationRoute(
                gatewayConnected: false,
                hasConnectedOnce: true,
                onboardingComplete: true,
                hasExistingGatewayConfig: false,
                shouldPresentOnLaunch: false) == .settings)
    }

    @Test func previewApprovalPresentationStaysSampleOnly() {
        #expect(
            SettingsProTab.approvalsDetail(
                isDemoMode: true,
                showPreviewApprovalExample: false,
                notificationsNeedAttention: true,
                hasPendingApproval: true) == "Example available")
        #expect(
            SettingsProTab.approvalsDetail(
                isDemoMode: true,
                showPreviewApprovalExample: true,
                notificationsNeedAttention: false,
                hasPendingApproval: false) == "Example request showing")
        #expect(
            SettingsProTab.shouldShowApprovalRows(
                hasPendingApproval: false,
                isDemoMode: true,
                showPreviewApprovalExample: true))
        #expect(!SettingsProTab.shouldResolveApprovalThroughGateway(isDemoMode: true))
    }

    @Test func realApprovalPresentationKeepsGatewayResolvePath() {
        #expect(
            SettingsProTab.approvalsDetail(
                isDemoMode: false,
                showPreviewApprovalExample: true,
                notificationsNeedAttention: true,
                hasPendingApproval: true) == "1 waiting, notifications off")
        #expect(
            SettingsProTab.approvalsDetail(
                isDemoMode: false,
                showPreviewApprovalExample: false,
                notificationsNeedAttention: false,
                hasPendingApproval: true) == "1 request waiting")
        #expect(
            SettingsProTab.shouldShowApprovalRows(
                hasPendingApproval: true,
                isDemoMode: false,
                showPreviewApprovalExample: false))
        #expect(!SettingsProTab.shouldShowApprovalRows(
            hasPendingApproval: false,
            isDemoMode: false,
            showPreviewApprovalExample: true))
        #expect(SettingsProTab.shouldResolveApprovalThroughGateway(isDemoMode: false))
    }

    @Test func sidebarTabsEnabledForIPadRegularWidth() {
        #expect(
            RootTabs.shouldUseSidebarTabs(
                idiom: .pad,
                horizontalSizeClass: .regular))
    }

    @Test func sidebarTabsEnabledForIPadCompactWidth() {
        #expect(
            RootTabs.shouldUseSidebarTabs(
                idiom: .pad,
                horizontalSizeClass: .compact))
    }

    @Test func sidebarTabsDisabledForIPhone() {
        #expect(
            !RootTabs.shouldUseSidebarTabs(
                idiom: .phone,
                horizontalSizeClass: .regular))
    }

    @Test func sidebarGroupsMatchAdaptiveNavigationModel() {
        let groups = RootTabs.sidebarGroups
        let destinationIDs = RootTabs.SidebarDestination.allCases.map(\.rawValue)

        #expect(groups.map(\.title) == ["CHAT", "CONTROL", "SETTINGS", "REFERENCE"])
        #expect(groups[0].destinations.map(\.rawValue) == ["chat", "talk"])
        #expect(groups[1].destinations == [
            .overview,
            .activity,
            .agents,
            .workboard,
            .skillWorkshop,
            .instances,
            .sessions,
            .dreaming,
            .usage,
            .cron,
        ])
        #expect(groups[2].destinations == [.settings])
        #expect(groups[3].destinations == [.docs])
        #expect(destinationIDs == [
            "chat",
            "talk",
            "overview",
            "activity",
            "agents",
            "workboard",
            "skillWorkshop",
            "instances",
            "sessions",
            "dreaming",
            "usage",
            "cron",
            "docs",
            "settings",
            "gateway",
        ])
        #expect(!destinationIDs.contains("agent"))
        #expect(!RootTabs.sidebarGroups.flatMap(\.destinations).contains(.gateway))
    }

    @Test func phoneControlGroupsAvoidDuplicatingTheAgentTab() {
        let groups = RootTabs.phoneControlGroups
        let destinations = groups.flatMap(\.destinations)

        #expect(groups.map(\.title) == ["CHAT", "CONTROL", "SETTINGS", "REFERENCE"])
        #expect(!destinations.contains(.agents))
        #expect(RootTabs.sidebarGroups.flatMap(\.destinations).contains(.agents))
        #expect(destinations.contains(.dreaming))
        #expect(destinations.contains(.instances))
    }

    @Test func sidebarUsesCompactLabelsForLongRoutes() {
        #expect(RootTabs.SidebarDestination.settings.title == "Settings")
        #expect(RootTabs.SidebarDestination.gateway.title == "Settings / Gateway")
        #expect(RootTabs.SidebarDestination.gateway.sidebarTitle == "Connection")
    }

    @Test func phoneHubUsesRootTabsOnlyForNativeChatAgentAndGateway() {
        #expect(RootTabs.shouldOpenRootTabFromPhoneHub(.chat))
        #expect(RootTabs.shouldOpenRootTabFromPhoneHub(.talk))
        #expect(RootTabs.shouldOpenRootTabFromPhoneHub(.agents))
        #expect(RootTabs.shouldOpenRootTabFromPhoneHub(.gateway))
        #expect(RootTabs.shouldOpenRootTabFromPhoneHub(.settings))

        for destination in RootTabs.SidebarDestination.allCases
            where destination != .chat && destination != .talk && destination != .agents && destination != .gateway && destination != .settings
        {
            #expect(!RootTabs.shouldOpenRootTabFromPhoneHub(destination))
        }
    }

    @Test func legacyInitialTabsMapToMatchingSidebarDestinations() {
        #expect(RootTabs.defaultSidebarDestination(for: .control) == .overview)
        #expect(RootTabs.defaultSidebarDestination(for: .chat) == .chat)
        #expect(RootTabs.defaultSidebarDestination(for: .talk) == .talk)
        #expect(RootTabs.defaultSidebarDestination(for: .agent) == .agents)
        #expect(RootTabs.defaultSidebarDestination(for: .settings) == .settings)
    }

    @Test func skillWorkshopMutationsRequireAdminScope() {
        #expect(IPadSkillWorkshopScreen.shouldEnableProposalMutation(canWrite: true, hasOperatorAdminScope: true))
        #expect(!IPadSkillWorkshopScreen.shouldEnableProposalMutation(canWrite: true, hasOperatorAdminScope: false))
        #expect(!IPadSkillWorkshopScreen.shouldEnableProposalMutation(canWrite: false, hasOperatorAdminScope: true))
    }

    @Test func skillWorkshopHeldFilterIncludesQuarantinedAndStale() {
        #expect(IPadSkillWorkshopScreen.proposalStatusFilters.contains("held"))
        #expect(IPadSkillWorkshopScreen.proposalStatusMatchesFilter(status: "quarantined", filter: "held"))
        #expect(IPadSkillWorkshopScreen.proposalStatusMatchesFilter(status: "stale", filter: "held"))
        #expect(!IPadSkillWorkshopScreen.proposalStatusMatchesFilter(status: "pending", filter: "held"))
    }

    @Test func skillWorkshopBoardLanesMatchStatusFilter() {
        #expect(
            IPadSkillWorkshopScreen.proposalStatusBoardLanes(
                filter: "pending",
                proposalStatuses: ["pending", "applied"]) == ["pending"])
        #expect(
            IPadSkillWorkshopScreen.proposalStatusBoardLanes(
                filter: "held",
                proposalStatuses: ["quarantined", "stale"]) == ["quarantined", "stale"])
        #expect(
            IPadSkillWorkshopScreen.proposalStatusBoardLanes(
                filter: "all",
                proposalStatuses: ["pending", "needs-review"]) == [
                "pending",
                "quarantined",
                "stale",
                "applied",
                "rejected",
                "needs-review",
            ])
        #expect(IPadSkillWorkshopScreen.proposalLaneLabel("quarantined") == "Quarantined")
        #expect(IPadSkillWorkshopScreen.proposalLaneLabel("pending") == "Pending")
        #expect(IPadSkillWorkshopScreen.proposalLaneLabel("needs-review") == "Needs Review")
        #expect(IPadSkillWorkshopScreen.proposalLaneLabel("manual_QA") == "Manual QA")
    }

    @Test func skillWorkshopSelectionStaysInsideActiveFilter() {
        let proposals = [
            (id: "applied-1", status: "applied"),
            (id: "pending-1", status: "pending"),
            (id: "held-1", status: "quarantined"),
        ]

        #expect(
            IPadSkillWorkshopScreen.nextSelectedProposalID(
                current: "applied-1",
                proposals: proposals,
                filter: "pending") == "pending-1")
        #expect(
            IPadSkillWorkshopScreen.nextSelectedProposalID(
                current: "held-1",
                proposals: proposals,
                filter: "held") == "held-1")
        #expect(
            IPadSkillWorkshopScreen.nextSelectedProposalID(
                current: "pending-1",
                visibleProposalIDs: ["held-1"]) == "held-1")
        #expect(
            IPadSkillWorkshopScreen.nextSelectedProposalID(
                current: "pending-1",
                visibleProposalIDs: []) == nil)
    }

    @Test func workboardBoardScopeLabelsStayCompact() {
        #expect(IPadWorkboardScreen.normalizedScopeID("  planning ") == "planning")
        #expect(IPadWorkboardScreen.boardScopeLabel(for: "") == "All boards")
        #expect(IPadWorkboardScreen.boardScopeLabel(for: "planning") == "planning")
        #expect(IPadWorkboardScreen.boardScopeOptions(
            knownBoardIDs: ["default", " empty-board ", ""],
            cardBoardIDs: ["planning", "default"]) == ["default", "empty-board", "planning"])
        #expect(IPadWorkboardScreen
            .workboardSubtitle(boardScopeLabel: "All boards", selectedStatus: "active") == "All boards / Active")
        #expect(IPadWorkboardScreen
            .workboardSubtitle(boardScopeLabel: "planning", selectedStatus: "running") == "planning / Running")
    }

    @Test func workboardCompactUnavailableCopyExplainsRealCapabilityState() {
        #expect(IPadWorkboardScreen
            .compactWriteUnavailableMessage(canRead: false) ==
            "Connect from Settings to create, move, and dispatch cards.")
        #expect(IPadWorkboardScreen.compactWriteUnavailableMessage(canRead: true) == "Read-only gateway.")
    }

    @Test func skillWorkshopAgentScopeNormalizesGatewayIds() {
        #expect(IPadSkillWorkshopScreen.normalizedScopeID("  aiden ") == "aiden")
        #expect(IPadSkillWorkshopScreen.normalizedScopeID(nil) == "")
    }

    @Test func channelLifecycleControlsRequireAdminScope() {
        #expect(SettingsChannelsDestination.shouldEnableChannelOperation(canRead: true, hasOperatorAdminScope: true))
        #expect(!SettingsChannelsDestination.shouldEnableChannelOperation(canRead: true, hasOperatorAdminScope: false))
        #expect(!SettingsChannelsDestination.shouldEnableChannelOperation(canRead: false, hasOperatorAdminScope: true))
    }

    @Test func clickClackStaysInChannelsIntegrationMetadata() {
        #expect(SettingsChannelsDestination.fallbackLabel("clickclack") == "ClickClack")
        #expect(SettingsChannelsDestination.fallbackDetail("clickclack") == "Self-hosted chat bot routing.")
        #expect(SettingsChannelsDestination.fallbackSystemImage("clickclack") == "bubble.left.and.bubble.right")
    }

    @Test func iPadOverviewCanSuppressStandaloneHeaderBranding() {
        #expect(CommandCenterTab.shouldShowHeaderMark(hasLeadingAction: false, showsHeaderMark: true))
        #expect(!CommandCenterTab.shouldShowHeaderMark(hasLeadingAction: true, showsHeaderMark: true))
        #expect(!CommandCenterTab.shouldShowHeaderMark(hasLeadingAction: false, showsHeaderMark: false))
    }

    @Test func embeddedOverviewDefersNavigationStackOwnership() throws {
        let commandCenterSource = try String(contentsOf: Self.commandCenterSourceURL(), encoding: .utf8)
        let phoneControlSource = try String(contentsOf: Self.phoneControlHubSourceURL(), encoding: .utf8)
        let rootTabsSource = try String(contentsOf: Self.rootTabsSourceURL(), encoding: .utf8)

        #expect(commandCenterSource.contains("var ownsNavigationStack: Bool = true"))
        #expect(commandCenterSource.contains("var openSessions: (() -> Void)?"))
        #expect(commandCenterSource.contains("if let openSessions"))
        #expect(phoneControlSource.contains("ownsNavigationStack: false"))
        #expect(phoneControlSource.contains("openSessions: { self.navigationPath.append(.sessions) }"))
        #expect(rootTabsSource.contains("ownsNavigationStack: false"))
        #expect(rootTabsSource.contains("openSessions: { self.selectSidebarDestination(.sessions) }"))
    }

    @Test func exploreModeReturnsToControlOverview() throws {
        let onboardingSource = try String(contentsOf: Self.onboardingWizardSourceURL(), encoding: .utf8)
        let rootTabsSource = try String(contentsOf: Self.rootTabsSourceURL(), encoding: .utf8)

        #expect(onboardingSource.contains("case explore"))
        #expect(onboardingSource.contains("self.onClose(.explore)"))
        #expect(rootTabsSource.contains("case .explore:"))
        #expect(rootTabsSource.contains("self.selectSidebarDestination(.overview)"))
    }

    @Test func gatewayOnboardingWelcomeKeepsHumanPreviewChoices() throws {
        let onboardingStepsSource = try String(contentsOf: Self.onboardingWizardStepsSourceURL(), encoding: .utf8)

        #expect(onboardingStepsSource.contains("OnboardingPreviewStrip()"))
        #expect(onboardingStepsSource.contains("OnboardingGatewayExplainer()"))
        #expect(onboardingStepsSource.contains("Mobile connects to your Gateway"))
        #expect(onboardingStepsSource.contains("OpenClaw runs on a computer or server."))
        #expect(onboardingStepsSource.contains("Try a demo"))
        #expect(onboardingStepsSource.contains("Preview chat, tasks, and approvals with sample data."))
        #expect(onboardingStepsSource.contains("Enter a setup code"))
        #expect(onboardingStepsSource.contains("Preview uses sample data."))
        #expect(onboardingStepsSource.contains("OnboardingChoiceDivider()"))
        #expect(onboardingStepsSource.contains(".fill(Color(uiColor: .secondarySystemGroupedBackground))"))
        #expect(!onboardingStepsSource.contains(".fill(self.isPrimary ? OpenClawBrand.accent"))
    }

    @Test func gatewaySetupEducationKeepsNumberedStepsAndUnlocks() throws {
        let onboardingStepsSource = try String(contentsOf: Self.onboardingWizardStepsSourceURL(), encoding: .utf8)

        #expect(onboardingStepsSource.contains("GatewaySetupNoteCard()"))
        #expect(onboardingStepsSource.contains("Gateway runs the work"))
        #expect(onboardingStepsSource.contains("Mobile stays lightweight"))
        #expect(onboardingStepsSource.contains("GatewaySetupStepRow(index: index + 1, title: step)"))
        #expect(onboardingStepsSource.contains("GatewayUnlockRow(icon: \"person.2.fill\""))
        #expect(onboardingStepsSource.contains("After pairing"))
        #expect(!onboardingStepsSource.contains("let onBack: () -> Void"))
        #expect(!onboardingStepsSource.contains("Label(\"Back\", systemImage: \"chevron.left\")"))
    }

    @Test func gatewaySetupCommandCanBeCopiedOrShared() throws {
        let onboardingStepsSource = try String(contentsOf: Self.onboardingWizardStepsSourceURL(), encoding: .utf8)

        #expect(onboardingStepsSource.contains("UIPasteboard.general.string = self.platform.command"))
        #expect(onboardingStepsSource.contains("ShareLink("))
        #expect(onboardingStepsSource.contains("openclaw qr"))
        #expect(onboardingStepsSource.contains("Open the mobile app and scan or paste the code."))
    }

    @Test func previewModeBannerStaysCompactAndActionable() throws {
        let rootTabsSource = try String(contentsOf: Self.rootTabsSourceURL(), encoding: .utf8)

        #expect(rootTabsSource.contains("Text(\"Demo\")"))
        #expect(rootTabsSource.contains("Text(\"Set up OpenClaw\")"))
        #expect(rootTabsSource.contains(".background(.regularMaterial, in: Capsule())"))
        #expect(rootTabsSource.contains(".frame(maxWidth: 380)"))
    }

    @Test func chatSidebarDestinationCanUseRouteHeaderInsteadOfAgentBranding() {
        let standalone = ChatProTab()
        let routed = ChatProTab(
            headerTitle: "Chat",
            headerSubtitle: "Agent conversation",
            showsAgentBadge: false,
            openSettings: {})

        #expect(standalone.showsAgentBadge)
        #expect(standalone.headerTitle == nil)
        #expect(standalone.openSettings == nil)
        #expect(routed.headerTitle == "Chat")
        #expect(routed.headerSubtitle == "Agent conversation")
        #expect(!routed.showsAgentBadge)
        #expect(routed.openSettings != nil)
        #expect(ChatProTab.defaultHeaderTitle(showsAgentBadge: true, agentDisplayName: "OpenClaw") == "OpenClaw")
        #expect(ChatProTab.defaultHeaderTitle(showsAgentBadge: false, agentDisplayName: "OpenClaw") == "Chat")
    }

    @Test func agentRoutesCanOpenGatewaySettingsFromHeaderPill() {
        let standalone = AgentProTab()
        let routed = AgentProTab(
            directRoute: .instances,
            headerTitle: "Instances",
            openSettings: {})

        #expect(standalone.headerTitle == "Agents")
        #expect(standalone.directRoute == nil)
        #expect(standalone.openSettings == nil)
        #expect(AgentProTab(directRoute: .agents).directRoute == .agents)
        #expect(routed.directRoute == .instances)
        #expect(routed.headerTitle == "Instances")
        #expect(routed.openSettings != nil)
    }

    @Test func workboardDispatchSummaryReportsStartedAndFailures() throws {
        let payload = Data(
            """
            {
              "count": 2,
              "started": [{}],
              "startFailures": [{}],
              "promoted": [],
              "reclaimed": [],
              "blocked": [],
              "orchestrated": []
            }
            """.utf8)
        let summary = try JSONDecoder().decode(IPadWorkboardDispatchSummary.self, from: payload)

        #expect(summary.summaryText == "2 dispatched: 1 started, 1 failed.")
    }

    @Test func talkSidebarDestinationCanReceiveRevealAction() {
        let action = OpenClawSidebarHeaderAction(
            systemName: "sidebar.left",
            accessibilityLabel: "Show Sidebar",
            action: {})
        let routed = TalkProTab(headerLeadingAction: action, openSettings: {})

        #expect(routed.headerLeadingAction?.systemName == "sidebar.left")
        #expect(routed.headerLeadingAction?.accessibilityLabel == "Show Sidebar")
    }

    @Test func iPadPortraitUsesHiddenDrawerSidebar() {
        let mode = RootTabs.sidebarLayoutMode(containerSize: CGSize(width: 1024, height: 1366))

        #expect(mode == .drawer)
        #expect(!RootTabs.preferredSidebarVisibility(layoutMode: mode))
    }

    @Test func iPadWideLandscapeUsesVisibleSplitSidebar() {
        let mode = RootTabs.sidebarLayoutMode(containerSize: CGSize(width: 1366, height: 1024))

        #expect(mode == .split)
        #expect(RootTabs.preferredSidebarVisibility(layoutMode: mode))
    }

    @Test func iPadSplitSidebarWidthStaysUsable() {
        let width = RootTabs.sidebarWidth(containerWidth: 1366, isDrawerLayout: false)

        #expect(width >= RootTabs.sidebarSplitIdealWidth)
        #expect(width <= RootTabs.sidebarSplitMaximumWidth)
    }

    @Test func iPadCollapsedSplitSidebarUsesHeaderRevealWithoutReservedRail() {
        #expect(
            RootTabs.shouldShowSidebarRevealInDestinationHeader(
                isSidebarVisible: false,
                layoutMode: .split))
        #expect(
            RootTabs.shouldShowSidebarRevealInDestinationHeader(
                isSidebarVisible: true,
                layoutMode: .split))
        #expect(
            RootTabs.shouldShowSidebarRevealInDestinationHeader(
                isSidebarVisible: false,
                layoutMode: .drawer))
        #expect(
            !RootTabs.shouldShowSidebarRevealInDestinationHeader(
                isSidebarVisible: true,
                layoutMode: .drawer))
    }

    @Test func initialSidebarVisibilityParsesLaunchArgument() {
        #expect(
            RootTabs.requestedInitialSidebarVisibility(arguments: [
                "OpenClaw",
                "--openclaw-sidebar-visibility",
                "hidden",
            ]) == false)
        #expect(
            RootTabs.requestedInitialSidebarVisibility(arguments: [
                "OpenClaw",
                "--openclaw-sidebar-visibility",
                "visible",
            ]) == true)
        #expect(
            RootTabs.requestedInitialSidebarVisibility(arguments: [
                "OpenClaw",
                "--openclaw-sidebar-visibility",
                "unknown",
            ]) == nil)
    }

    @Test func sidebarControlsHaveStableAccessibilityIdentifiers() {
        #expect(RootTabs.sidebarShowButtonAccessibilityIdentifier == "RootTabs.Sidebar.Show")
        #expect(RootTabs.sidebarHideButtonAccessibilityIdentifier == "RootTabs.Sidebar.Hide")
    }

    @Test func iPadDrawerSidebarWidthStaysInsideScreen() {
        let width = RootTabs.sidebarWidth(containerWidth: 744, isDrawerLayout: true)

        #expect(width >= 280)
        #expect(width <= RootTabs.sidebarDrawerMaximumWidth)
    }

    @Test func narrowLandscapeKeepsDrawerSidebar() {
        let mode = RootTabs.sidebarLayoutMode(containerSize: CGSize(width: 900, height: 600))

        #expect(mode == .drawer)
        #expect(!RootTabs.preferredSidebarVisibility(layoutMode: mode))
    }

    @Test func drawerSelectionCollapsesSidebarButSplitSelectionDoesNot() {
        #expect(RootTabs.shouldCollapseSidebarAfterSelection(layoutMode: .drawer))
        #expect(!RootTabs.shouldCollapseSidebarAfterSelection(layoutMode: .split))
    }

    @Test func hiddenSidebarShowsRevealControl() {
        #expect(RootTabs.shouldShowSidebarRevealControl(isSidebarVisible: false))
    }

    @Test func sidebarRevealControlsHideWhenSidebarIsVisible() {
        #expect(!RootTabs.shouldShowSidebarRevealControl(isSidebarVisible: true))
    }

    @Test func iPadSplitPrefersIntegratedVisibleSidebar() {
        #expect(RootTabs.preferredSidebarVisibility(layoutMode: .split))
        #expect(!RootTabs.shouldCollapseSidebarAfterSelection(layoutMode: .split))
        #expect(!RootTabs.preferredSidebarVisibility(layoutMode: .drawer))
        #expect(RootTabs.shouldCollapseSidebarAfterSelection(layoutMode: .drawer))
    }

    @Test func destinationHeadersOwnHiddenSidebarRevealControl() {
        #expect(
            RootTabs.shouldShowSidebarRevealInDestinationHeader(
                isSidebarVisible: false,
                layoutMode: .drawer))
        #expect(
            RootTabs.shouldShowSidebarRevealInDestinationHeader(
                isSidebarVisible: false,
                layoutMode: .split))
        #expect(
            !RootTabs.shouldShowSidebarRevealInDestinationHeader(
                isSidebarVisible: true,
                layoutMode: .drawer))
        #expect(
            RootTabs.shouldShowSidebarRevealInDestinationHeader(
                isSidebarVisible: true,
                layoutMode: .split))
    }

    @Test func workboardAndSkillWorkshopUseCompactTaskFlowOnPhoneSizes() {
        #expect(
            IPadWorkboardScreen.usesCompactTaskFlow(
                horizontalSizeClass: .compact,
                verticalSizeClass: .regular))
        #expect(
            IPadSkillWorkshopScreen.usesCompactTaskFlow(
                horizontalSizeClass: .compact,
                verticalSizeClass: .regular))
        #expect(
            IPadWorkboardScreen.usesCompactTaskFlow(
                horizontalSizeClass: .regular,
                verticalSizeClass: .compact))
        #expect(
            IPadSkillWorkshopScreen.usesCompactTaskFlow(
                horizontalSizeClass: .regular,
                verticalSizeClass: .compact))
    }

    @Test func workboardAndSkillWorkshopKeepRegularTaskFlowOnWideIPadSizes() {
        #expect(
            !IPadWorkboardScreen.usesCompactTaskFlow(
                horizontalSizeClass: .regular,
                verticalSizeClass: .regular))
        #expect(
            !IPadSkillWorkshopScreen.usesCompactTaskFlow(
                horizontalSizeClass: .regular,
                verticalSizeClass: .regular))
    }

    @Test func phoneHubLeavesRoomForFloatingTabBar() {
        #expect(RootTabsPhoneControlHub.bottomScrollInset(verticalSizeClass: .regular) == 112)
        #expect(RootTabsPhoneControlHub.bottomScrollInset(verticalSizeClass: .compact) == 72)
    }

    private static func rootTabsSourceURL() -> URL {
        self.iosSourcesURL().appendingPathComponent("RootTabs.swift")
    }

    private static func phoneControlHubSourceURL() -> URL {
        self.iosSourcesURL()
            .appendingPathComponent("Design/RootTabsPhoneControlHub.swift")
    }

    private static func commandCenterSourceURL() -> URL {
        self.iosSourcesURL()
            .appendingPathComponent("Design/CommandCenterTab.swift")
    }

    private static func onboardingWizardSourceURL() -> URL {
        self.iosSourcesURL()
            .appendingPathComponent("Onboarding/OnboardingWizardView.swift")
    }

    private static func onboardingWizardStepsSourceURL() -> URL {
        self.iosSourcesURL()
            .appendingPathComponent("Onboarding/OnboardingWizardSteps.swift")
    }

    private static func iosSourcesURL() -> URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("Sources")
    }
}
