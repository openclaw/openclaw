import CoreGraphics
import Foundation
import OpenClawChatUI
import OpenClawKit
import SwiftUI

extension EnvironmentValues {
    @Entry var userNavigationAction: (@MainActor @Sendable () -> Bool)?
}

/// A fork keeps the click's navigation and connection owners through every await.
/// The receipt never renews itself when a newer root, target, or route takes over.
@MainActor
struct PreparedChatNavigation {
    struct Fork {
        let target: OpenClawChatSessionTarget
        let route: GatewayNodeSessionRoute?
    }

    let parent: OpenClawChatSessionTarget
    let transport: any OpenClawChatTransport
    let gatewayID: String?
    let isLocalFixture: Bool
    let isCurrent: @MainActor () -> Bool
    let open: @MainActor (OpenClawChatSessionTarget) -> Bool

    static func capture(
        appModel: NodeAppModel,
        router: NativeActionRouter?,
        presentationID: UUID?,
        session: OpenClawChatSessionEntry,
        isCurrentContext: @escaping @MainActor () -> Bool,
        currentNativeBinding: @escaping @MainActor () -> IOSNativeActionBinding?,
        open: @escaping @MainActor (OpenClawChatSessionTarget) -> Void) -> Self?
    {
        guard isCurrentContext() else { return nil }
        let authority = router?.capturePresentationAuthority(presentationID)
        guard router == nil || authority != nil else { return nil }
        let config = appModel.activeGatewayConnectConfig
        let gatewayID = config?.nodeOptions.deviceAuthGatewayID ?? config?.effectiveStableID
        let inputs = config?.controlUIInputs
        let generation = appModel.gatewayConnectGeneration
        let accountGeneration = appModel.operatorAuthorityGeneration
        let selectedKey = appModel.chatSessionKey
        let selectedAgent = appModel.chatDeliveryAgentId
        let fixture = appModel.isScreenshotFixtureModeEnabled || appModel.isAppleReviewDemoModeEnabled
        let binding = currentNativeBinding()
        let isCurrent: @MainActor () -> Bool = {
            isCurrentContext() &&
                (router == nil || authority.map { router?.isCurrentPresentation($0) == true } == true) &&
                appModel.activeGatewayConnectConfig?.controlUIInputs == inputs &&
                appModel.gatewayConnectGeneration == generation &&
                appModel.operatorAuthorityGeneration == accountGeneration &&
                appModel.chatSessionKey == selectedKey && appModel.chatDeliveryAgentId == selectedAgent &&
                (appModel.isScreenshotFixtureModeEnabled || appModel.isAppleReviewDemoModeEnabled) == fixture &&
                // A newer native open can keep the same target without a selection change.
                // Own nil-binding synchronization must not retire this receipt.
                currentNativeBinding() === binding
        }
        return Self(
            parent: IOSGatewayChatTransport.sessionTarget(
                for: session.key,
                selectedAgentID: selectedAgent,
                overrideAgentID: session.agentId),
            transport: appModel.makeChatTransport(outboxGatewayID: gatewayID),
            gatewayID: gatewayID,
            isLocalFixture: fixture,
            isCurrent: isCurrent,
            open: { target in
                guard isCurrent() else { return false }
                open(target)
                return true
            })
    }

    func fork(fromLastCompleted: Bool) async throws -> Fork {
        guard self.isCurrent(), !Task.isCancelled else { throw CancellationError() }
        let key: String
        let route: GatewayNodeSessionRoute?
        if self.isLocalFixture {
            // Local review/screenshot transports deliberately retain their unsupported
            // fork result. They must never fall through to a real Gateway request.
            route = nil
            key = try await self.transport.forkSession(
                parentKey: self.parent.sessionKey,
                fromLastCompleted: fromLastCompleted,
                agentID: self.parent.agentID)
        } else {
            guard let transport = transport as? IOSGatewayChatTransport,
                  let gatewayID,
                  let captured = await transport.gateway.currentRoute(ifGatewayID: gatewayID)
            else { throw OpenClawChatTransportSendError.notDispatched }
            guard self.isCurrent(), !Task.isCancelled else { throw CancellationError() }
            route = captured
            do {
                key = try await transport.forkSession(
                    parentKey: self.parent.sessionKey,
                    fromLastCompleted: fromLastCompleted,
                    agentID: self.parent.agentID,
                    ifCurrentRoute: captured)
            } catch {
                guard await transport.gateway.currentRoute(ifGatewayID: gatewayID) == captured,
                      self.isCurrent(), !Task.isCancelled else { throw CancellationError() }
                throw error
            }
        }
        guard self.isCurrent(), !Task.isCancelled else { throw CancellationError() }
        return Fork(target: .init(sessionKey: key, agentID: self.parent.agentID), route: route)
    }

    func commit(_ fork: Fork) async -> Bool {
        guard self.isCurrent(), !Task.isCancelled else { return false }
        if !self.isLocalFixture {
            guard let transport = transport as? IOSGatewayChatTransport,
                  let gatewayID, let route = fork.route,
                  await transport.gateway.currentRoute(ifGatewayID: gatewayID) == route
            else { return false }
        }
        guard self.isCurrent(), !Task.isCancelled else { return false }
        return self.open(fork.target)
    }
}

extension RootTabs {
    struct SessionObserverTaskIdentity: Equatable {
        let sidebarRefreshID: String
        let isSceneActive: Bool
        let isSidebarVisible: Bool

        var isObserverVisible: Bool {
            self.isSceneActive && self.isSidebarVisible
        }
    }

    static func initialDestination(arguments: [String]) -> SidebarDestination {
        if let requested = self.requestedInitialSidebarDestination(arguments: arguments) {
            return requested
        }
        guard let flagIndex = arguments.firstIndex(of: "--openclaw-initial-tab") else { return .chat }
        let valueIndex = arguments.index(after: flagIndex)
        guard arguments.indices.contains(valueIndex) else { return .chat }
        return switch arguments[valueIndex].trimmingCharacters(in: .whitespacesAndNewlines).lowercased() {
        case "control", "overview": .overview
        case "chat", "talk", "voice": .chat
        case "agent", "agents": .agents
        case "settings": .settings
        default: .chat
        }
    }

    static func requestedInitialSidebarDestination(arguments: [String]) -> SidebarDestination? {
        guard let flagIndex = arguments.firstIndex(of: "--openclaw-initial-destination") else {
            return nil
        }
        let valueIndex = arguments.index(after: flagIndex)
        guard arguments.indices.contains(valueIndex) else { return nil }
        let requested = arguments[valueIndex].trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        return SidebarDestination.allCases.first { $0.rawValue.lowercased() == requested }
    }

    struct SidebarPagesPresentation: Identifiable, Equatable {
        let id = UUID()
    }

    enum PresentedSheet: Identifiable, Equatable {
        case quickSetup
        case notificationSettings(path: String)
        case sessionDashboard(sessionKey: String, agentId: String?)
        case backgroundTasks(agentID: String, receipt: OpenClawChatModalPresentations.Receipt)
        case newSessionOptions(OpenClawChatViewModel, receipt: OpenClawChatModalPresentations.Receipt)
        case transcriptShare(URL, receipt: OpenClawChatModalPresentations.Receipt)

        var chatReceipt: OpenClawChatModalPresentations.Receipt? {
            switch self {
            case let .backgroundTasks(_, receipt), let .newSessionOptions(_, receipt),
                 let .transcriptShare(_, receipt): receipt
            default: nil
            }
        }

        static func == (lhs: Self, rhs: Self) -> Bool {
            switch (lhs, rhs) {
            case (.quickSetup, .quickSetup): true
            case let (.notificationSettings(left), .notificationSettings(right)): left == right
            case let (.sessionDashboard(leftKey, leftAgent), .sessionDashboard(rightKey, rightAgent)):
                leftKey == rightKey && leftAgent == rightAgent
            case let (.backgroundTasks(_, left), .backgroundTasks(_, right)),
                 let (.newSessionOptions(_, left), .newSessionOptions(_, right)),
                 let (.transcriptShare(_, left), .transcriptShare(_, right)): left.id == right.id
            default: false
            }
        }

        var id: String {
            switch self {
            case .quickSetup: "quick-setup"
            case .notificationSettings: "notification-settings"
            case let .sessionDashboard(sessionKey, agentId):
                "session-dashboard:\(agentId ?? ""):\(sessionKey)"
            case let .backgroundTasks(_, receipt), let .newSessionOptions(_, receipt),
                 let .transcriptShare(_, receipt): receipt.id.uuidString
            }
        }
    }

    private static var sidebarPersistentWidthThreshold: CGFloat {
        980
    }

    static let sidebarSplitIdealWidth: CGFloat = 316
    static let sidebarSplitMaximumWidth: CGFloat = 340
    // Keep the web drawer's 86% reveal while using more of current iPhone widths.
    static let sidebarDrawerMaximumWidth: CGFloat = 340
    static let sidebarShowButtonAccessibilityIdentifier = "RootTabs.Sidebar.Show"
    static let sidebarHideButtonAccessibilityIdentifier = "RootTabs.Sidebar.Hide"

    enum SidebarDestination: String, CaseIterable, Hashable, Identifiable {
        case chat
        case overview
        case activity
        case agents
        case workboard
        case skillWorkshop
        case instances
        case sessions
        case files
        case dreaming
        case usage
        case cron
        case desktop
        case terminal
        case docs
        case settings
        case gateway

        var id: String {
            rawValue
        }

        var title: String {
            switch self {
            case .chat: String(localized: "Chat")
            case .overview: String(localized: "Overview")
            case .activity: String(localized: "Activity")
            case .agents: String(localized: "Agents")
            case .workboard: String(localized: "Workboard")
            case .skillWorkshop: String(localized: "Skill Workshop")
            case .instances: String(localized: "Instances")
            case .sessions: String(localized: "Sessions")
            case .files: String(localized: "Files")
            case .dreaming: String(localized: "Dreaming")
            case .usage: String(localized: "Usage")
            case .cron: String(localized: "Automations")
            case .desktop: String(localized: "Desktop")
            case .terminal: String(localized: "Terminal")
            case .docs: String(localized: "Docs")
            case .settings: String(localized: "Settings")
            case .gateway: String(localized: "Settings / Gateway")
            }
        }

        var sidebarTitle: String {
            switch self {
            case .gateway: String(localized: "Connection")
            default: self.title
            }
        }

        var systemImage: String {
            switch self {
            case .chat: "bubble.left"
            case .overview: "chart.bar"
            case .activity: "waveform.path.ecg"
            case .agents: "person.2"
            case .workboard: "folder"
            case .skillWorkshop: "hammer"
            case .instances: "dot.radiowaves.left.and.right"
            case .sessions: "doc.text"
            case .files: "folder.fill"
            case .dreaming: "moon.stars"
            case .usage: "chart.bar.xaxis"
            case .cron: "timer"
            case .desktop: "display"
            case .terminal: "terminal"
            case .docs: "book"
            case .settings: "gearshape"
            case .gateway: "gearshape"
            }
        }

        var screen: SidebarScreen {
            switch self {
            case .activity: .dashboard(DashboardRouteMap.activityPagePath)
            case .workboard: .dashboard(DashboardRouteMap.workboardPagePath)
            case .skillWorkshop: .dashboard(DashboardRouteMap.skillWorkshopPagePath)
            case .instances: .dashboard(DashboardRouteMap.devicesSettingsPath)
            case .dreaming: .dashboard(DashboardRouteMap.dreamingPagePath)
            case .usage: .dashboard(DashboardRouteMap.usagePagePath)
            case .cron: .dashboard(DashboardRouteMap.cronJobsPagePath)
            case .chat: .chat
            case .overview: .overview
            case .agents: .agents
            case .sessions: .sessions
            case .files: .files
            case .desktop: .desktop
            case .terminal: .terminal
            case .docs: .docs
            case .settings: .settings
            case .gateway: .gateway
            }
        }

        var settingsRoute: SettingsRoute? {
            switch self {
            case .gateway:
                .gateway
            case .chat, .overview, .activity, .agents, .workboard, .skillWorkshop, .instances, .sessions,
                 .files,
                 .dreaming,
                 .usage, .cron, .desktop, .terminal, .settings, .docs:
                nil
            }
        }
    }

    enum SidebarScreen: Equatable {
        case dashboard(String)
        case chat, overview, agents, sessions, files, desktop, terminal, docs, settings, gateway
    }

    static func notificationSettingsPath(servingEnabled: Bool, disclosureAccepted: Bool) -> String {
        servingEnabled && disclosureAccepted
            ? DashboardRouteMap.devicePermissionsSettingsPath
            : DashboardRouteMap.deviceSettingsPath
    }

    enum SidebarLayoutMode: Equatable {
        case drawer
        case split
    }

    enum SidebarSessionPresentation: Equatable {
        case chat
        case dashboard
    }

    struct SidebarDashboardTarget: Equatable {
        let sessionKey: String
        let agentId: String?
    }

    static func sidebarPresentation(for session: OpenClawChatSessionEntry) -> SidebarSessionPresentation {
        session.boardFace == "dashboard" ? .dashboard : .chat
    }

    static func sidebarDashboardTarget(for session: OpenClawChatSessionEntry) -> SidebarDashboardTarget {
        SidebarDashboardTarget(sessionKey: session.key, agentId: session.agentId)
    }

    static func sidebarLayoutContainerSize(contentSize: CGSize, windowSize: CGSize?) -> CGSize {
        windowSize ?? contentSize
    }

    static func sidebarLayoutMode(containerSize: CGSize) -> SidebarLayoutMode {
        containerSize.width < self.sidebarPersistentWidthThreshold || containerSize.height > containerSize.width
            ? .drawer
            : .split
    }

    static func preferredSidebarVisibility(layoutMode: SidebarLayoutMode) -> Bool {
        layoutMode == .split
    }

    static func shouldCollapseSidebarAfterSelection(layoutMode: SidebarLayoutMode) -> Bool {
        layoutMode == .drawer
    }

    static func sidebarWidth(containerWidth: CGFloat, isDrawerLayout: Bool) -> CGFloat {
        if isDrawerLayout {
            return min(self.sidebarDrawerMaximumWidth, containerWidth * 0.86)
        }
        return min(self.sidebarSplitMaximumWidth, max(self.sidebarSplitIdealWidth, containerWidth * 0.25))
    }

    static func sidebarContentOffset(
        sidebarWidth: CGFloat,
        isVisible: Bool,
        dragOffset: CGFloat,
        reduceMotion: Bool) -> CGFloat
    {
        guard !reduceMotion else { return 0 }
        if isVisible {
            return max(0, sidebarWidth + min(0, dragOffset))
        }
        // Closed: a positive drag is the interactive edge-open follow.
        return max(0, min(sidebarWidth, dragOffset))
    }

    static func visibleSettingsRoute(
        navigationPath: [SettingsRoute],
        baseRoute: SettingsRoute?) -> SettingsRoute?
    {
        navigationPath.last ?? baseRoute
    }

    static func shouldShowSidebarRevealInDestinationHeader(
        isSidebarVisible: Bool,
        layoutMode: SidebarLayoutMode) -> Bool
    {
        switch layoutMode {
        case .split:
            true
        case .drawer:
            !isSidebarVisible
        }
    }

    static func requestedInitialSidebarVisibility(arguments: [String]) -> Bool? {
        guard let flagIndex = arguments.firstIndex(of: "--openclaw-sidebar-visibility") else {
            return nil
        }
        let valueIndex = arguments.index(after: flagIndex)
        guard arguments.indices.contains(valueIndex) else { return nil }

        switch arguments[valueIndex].trimmingCharacters(in: .whitespacesAndNewlines).lowercased() {
        case "visible", "show", "shown", "open", "true", "1":
            return true
        case "hidden", "hide", "closed", "false", "0":
            return false
        default:
            return nil
        }
    }

    enum StartupPresentationRoute: Equatable {
        case none
        case onboarding
        case settings
    }

    static func startupPresentationRoute(
        gatewayConnected: Bool,
        hasConnectedOnce: Bool,
        onboardingComplete: Bool,
        hasExistingGatewayConfig: Bool,
        shouldPresentOnLaunch: Bool) -> StartupPresentationRoute
    {
        if gatewayConnected {
            return .none
        }
        // Saved gateway state survives independently of the onboarding markers.
        // Explicit resets bypass this route through evaluateOnboardingPresentation(force:).
        if hasExistingGatewayConfig {
            return .none
        }
        if shouldPresentOnLaunch || !hasConnectedOnce || !onboardingComplete {
            return .onboarding
        }
        return .settings
    }

    static func shouldPresentQuickSetup(
        quickSetupDismissed: Bool,
        showOnboarding: Bool,
        hasPresentedSheet: Bool,
        gatewayConnected: Bool,
        hasExistingGatewayConfig: Bool,
        discoveredGatewayCount: Int) -> Bool
    {
        guard !quickSetupDismissed else { return false }
        guard !showOnboarding else { return false }
        guard !hasPresentedSheet else { return false }
        guard !gatewayConnected else { return false }
        guard !hasExistingGatewayConfig else { return false }
        return discoveredGatewayCount > 0
    }

    static let sidebarDestinations: [SidebarDestination] = [
        .chat,
        .overview,
        .workboard,
        .usage,
        .cron,
        .sessions,
        .activity,
        .skillWorkshop,
        .agents,
        .instances,
        .files,
        .dreaming,
        .desktop,
        .terminal,
        .docs,
    ]

    /// Home (chat) is a fixed first row like the web sidebar; only these can be
    /// pinned/unpinned by the user.
    static let pinnableSidebarPages: [SidebarDestination] = sidebarDestinations.filter { $0 != .chat }

    /// Echoes the web first-run Pages zone (Home, Usage, Automations, …):
    /// compact by default so sessions stay above the fold. The Sessions page is
    /// intentionally unpinned — the sessions section + "All Sessions…" own it.
    static let defaultPinnedSidebarPages: [SidebarDestination] = [.overview, .usage, .cron]

    /// "" = never customized (defaults); "none" = user unpinned everything.
    /// Storage order is the user's pin order (web parity); unknown or
    /// unpinnable raw values are dropped.
    static func pinnedSidebarPages(from storage: String) -> [SidebarDestination] {
        let trimmed = storage.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty { return self.defaultPinnedSidebarPages }
        if trimmed == "none" { return [] }
        var seen = Set<String>()
        return trimmed.split(separator: ",").compactMap { raw in
            let value = String(raw)
            guard seen.insert(value).inserted,
                  let destination = SidebarDestination(rawValue: value),
                  self.pinnableSidebarPages.contains(destination)
            else { return nil }
            return destination
        }
    }

    static func pinnedSidebarPagesStorage(_ pages: [SidebarDestination]) -> String {
        pages.isEmpty ? "none" : pages.map(\.rawValue).joined(separator: ",")
    }
}
