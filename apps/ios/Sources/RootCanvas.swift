import OpenClawKit
import OpenClawProtocol
import SwiftUI
import UIKit

struct RootCanvas: View {
    @Environment(NodeAppModel.self) private var appModel
    @Environment(GatewayConnectionController.self) private var gatewayController
    @Environment(VoiceWakeManager.self) private var voiceWake
    @Environment(\.colorScheme) private var systemColorScheme
    @Environment(\.scenePhase) private var scenePhase
    @AppStorage(VoiceWakePreferences.enabledKey) private var voiceWakeEnabled: Bool = false
    @AppStorage("screen.preventSleep") private var preventSleep: Bool = true
    @AppStorage("canvas.debugStatusEnabled") private var canvasDebugStatusEnabled: Bool = false
    @AppStorage("onboarding.requestID") private var onboardingRequestID: Int = 0
    @AppStorage("gateway.onboardingComplete") private var onboardingComplete: Bool = false
    @AppStorage("gateway.hasConnectedOnce") private var hasConnectedOnce: Bool = false
    @AppStorage("gateway.preferredStableID") private var preferredGatewayStableID: String = ""
    @AppStorage("gateway.manual.enabled") private var manualGatewayEnabled: Bool = false
    @AppStorage("gateway.manual.host") private var manualGatewayHost: String = ""
    @AppStorage("onboarding.quickSetupDismissed") private var quickSetupDismissed: Bool = false
    @State private var presentedSheet: PresentedSheet?
    @State private var voiceWakeToastText: String?
    @State private var toastDismissTask: Task<Void, Never>?
    @State private var showOnboarding: Bool = false
    @State private var onboardingAllowSkip: Bool = true
    @State private var didEvaluateOnboarding: Bool = false
    @State private var didAutoOpenSettings: Bool = false
    @State private var homeActionQueue: [HomeCanvasActionQueueItem] = []
    @State private var homeActionRefreshTask: Task<Void, Never>?

    private enum PresentedSheet: Identifiable {
        case settings
        case chat
        case quickSetup

        var id: Int {
            switch self {
            case .settings: 0
            case .chat: 1
            case .quickSetup: 2
            }
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
        // On first run or explicit launch onboarding state, onboarding always wins.
        if shouldPresentOnLaunch || !hasConnectedOnce || !onboardingComplete {
            return .onboarding
        }
        // Settings auto-open is a recovery path for previously-connected installs only.
        if !hasExistingGatewayConfig {
            return .settings
        }
        return .none
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
        // If a gateway target is already configured (manual or last-known), skip quick setup.
        guard !hasExistingGatewayConfig else { return false }
        return discoveredGatewayCount > 0
    }

    var body: some View {
        ZStack {
            CanvasContent(
                systemColorScheme: self.systemColorScheme,
                gatewayStatus: self.gatewayStatus,
                voiceWakeEnabled: self.voiceWakeEnabled,
                voiceWakeToastText: self.voiceWakeToastText,
                cameraHUDText: self.appModel.cameraHUDText,
                cameraHUDKind: self.appModel.cameraHUDKind,
                openChat: {
                    self.presentedSheet = .chat
                },
                openSettings: {
                    self.presentedSheet = .settings
                },
                retryGatewayConnection: {
                    Task { await self.gatewayController.connectLastKnown() }
                })
                .preferredColorScheme(.dark)

            if self.appModel.cameraFlashNonce != 0 {
                CameraFlashOverlay(nonce: self.appModel.cameraFlashNonce)
            }
        }
        .gatewayTrustPromptAlert()
        .deepLinkAgentPromptAlert()
        .execApprovalPromptDialog()
        .sheet(item: self.$presentedSheet) { sheet in
            switch sheet {
            case .settings:
                SettingsTab()
                    .environment(self.appModel)
                    .environment(self.appModel.voiceWake)
                    .environment(self.gatewayController)
            case .chat:
                ChatSheet(
                    // Chat RPCs run on the operator session (read/write scopes).
                    gateway: self.appModel.operatorSession,
                    sessionKey: self.appModel.chatSessionKey,
                    agentName: self.appModel.activeAgentName,
                    userAccent: self.appModel.seamColor)
            case .quickSetup:
                GatewayQuickSetupSheet()
                    .environment(self.appModel)
                    .environment(self.gatewayController)
            }
        }
        .fullScreenCover(isPresented: self.$showOnboarding) {
            OnboardingWizardView(
                allowSkip: self.onboardingAllowSkip,
                onClose: {
                    self.showOnboarding = false
                })
                .environment(self.appModel)
                .environment(self.appModel.voiceWake)
                .environment(self.gatewayController)
        }
        .onAppear { self.updateIdleTimer() }
        .onAppear { self.updateHomeCanvasState() }
        .onAppear { self.refreshHomeActionQueueIfNeeded() }
        .onAppear { self.evaluateOnboardingPresentation(force: false) }
        .onAppear { self.maybeAutoOpenSettings() }
        .onChange(of: self.preventSleep) { _, _ in self.updateIdleTimer() }
        .onChange(of: self.scenePhase) { _, newValue in
            self.updateIdleTimer()
            self.updateHomeCanvasState()
            guard newValue == .active else { return }
            Task {
                await self.appModel.refreshGatewayOverviewIfConnected()
                await self.refreshHomeActionQueue()
                await MainActor.run {
                    self.updateHomeCanvasState()
                }
            }
        }
        .onAppear { self.maybeShowQuickSetup() }
        .onChange(of: self.gatewayController.gateways.count) { _, _ in self.maybeShowQuickSetup() }
        .onAppear { self.updateCanvasDebugStatus() }
        .onChange(of: self.canvasDebugStatusEnabled) { _, _ in self.updateCanvasDebugStatus() }
        .onChange(of: self.appModel.gatewayStatusText) { _, _ in
            self.updateCanvasDebugStatus()
            self.updateHomeCanvasState()
        }
        .onChange(of: self.appModel.gatewayServerName) { _, _ in
            self.updateCanvasDebugStatus()
            self.updateHomeCanvasState()
        }
        .onChange(of: self.appModel.gatewayServerName) { _, newValue in
            if newValue != nil {
                self.showOnboarding = false
            }
        }
        .onChange(of: self.onboardingRequestID) { _, _ in
            self.evaluateOnboardingPresentation(force: true)
        }
        .onChange(of: self.appModel.gatewayRemoteAddress) { _, _ in
            self.updateCanvasDebugStatus()
            self.updateHomeCanvasState()
        }
        .onChange(of: self.appModel.homeCanvasRevision) { _, _ in
            self.updateHomeCanvasState()
            self.refreshHomeActionQueueIfNeeded()
        }
        .onChange(of: self.appModel.gatewayServerName) { _, newValue in
            if newValue != nil {
                self.onboardingComplete = true
                self.hasConnectedOnce = true
                OnboardingStateStore.markCompleted(mode: nil)
            }
            self.maybeAutoOpenSettings()
        }
        .onChange(of: self.appModel.openChatRequestID) { _, _ in
            self.presentedSheet = .chat
        }
        .onChange(of: self.voiceWake.lastTriggeredCommand) { _, newValue in
            guard let newValue else { return }
            let trimmed = newValue.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !trimmed.isEmpty else { return }

            self.toastDismissTask?.cancel()
            withAnimation(.spring(response: 0.25, dampingFraction: 0.85)) {
                self.voiceWakeToastText = trimmed
            }

            self.toastDismissTask = Task {
                try? await Task.sleep(nanoseconds: 2_300_000_000)
                await MainActor.run {
                    withAnimation(.easeOut(duration: 0.25)) {
                        self.voiceWakeToastText = nil
                    }
                }
            }
        }
        .onDisappear {
            UIApplication.shared.isIdleTimerDisabled = false
            self.toastDismissTask?.cancel()
            self.toastDismissTask = nil
            self.homeActionRefreshTask?.cancel()
            self.homeActionRefreshTask = nil
        }
    }

    private var gatewayStatus: StatusPill.GatewayState {
        GatewayStatusBuilder.build(appModel: self.appModel)
    }

    private func updateIdleTimer() {
        UIApplication.shared.isIdleTimerDisabled = (self.scenePhase == .active && self.preventSleep)
    }

    private func updateCanvasDebugStatus() {
        self.appModel.screen.setDebugStatusEnabled(self.canvasDebugStatusEnabled)
        guard self.canvasDebugStatusEnabled else { return }
        let title = self.appModel.gatewayDisplayStatusText.trimmingCharacters(in: .whitespacesAndNewlines)
        let subtitle = self.appModel.gatewayServerName ?? self.appModel.gatewayRemoteAddress
        self.appModel.screen.updateDebugStatus(title: title, subtitle: subtitle)
    }

    private func updateHomeCanvasState() {
        let payload = self.makeHomeCanvasPayload()
        guard let data = try? JSONEncoder().encode(payload),
              let json = String(data: data, encoding: .utf8)
        else {
            self.appModel.screen.updateHomeCanvasState(json: nil)
            return
        }
        self.appModel.screen.updateHomeCanvasState(json: json)
    }

    private func refreshHomeActionQueueIfNeeded() {
        guard self.gatewayStatus == .connected else {
            if !self.homeActionQueue.isEmpty {
                self.homeActionQueue = []
                self.updateHomeCanvasState()
            }
            return
        }
        self.homeActionRefreshTask?.cancel()
        self.homeActionRefreshTask = Task { [gateway = self.appModel.operatorSession] in
            struct Params: Codable {
                var status: String
                var limit: Int
            }
            struct Response: Codable {
                var items: [HomeCanvasActionQueueItem]
            }
            do {
                let data = try JSONEncoder().encode(Params(status: "open", limit: 6))
                let json = String(data: data, encoding: .utf8)
                let res = try await gateway.request(method: "actions.list", paramsJSON: json, timeoutSeconds: 10)
                let decoded = try JSONDecoder().decode(Response.self, from: res)
                await MainActor.run {
                    self.homeActionQueue = decoded.items
                    self.updateHomeCanvasState()
                }
            } catch {
                // Best-effort; the static dashboard remains usable while the gateway warms up.
            }
        }
    }

    private func refreshHomeActionQueue() async {
        guard self.gatewayStatus == .connected else { return }
        struct Params: Codable {
            var status: String
            var limit: Int
        }
        struct Response: Codable {
            var items: [HomeCanvasActionQueueItem]
        }
        do {
            let data = try JSONEncoder().encode(Params(status: "open", limit: 6))
            let json = String(data: data, encoding: .utf8)
            let res = try await appModel.operatorSession.request(
                method: "actions.list",
                paramsJSON: json,
                timeoutSeconds: 10)
            let decoded = try JSONDecoder().decode(Response.self, from: res)
            self.homeActionQueue = decoded.items
        } catch {
            // Best-effort; dashboard state will refresh again on foreground/reconnect.
        }
    }

    private func makeHomeCanvasPayload() -> HomeCanvasPayload {
        let gatewayName = self.normalized(self.appModel.gatewayServerName)
        let gatewayAddress = self.normalized(self.appModel.gatewayRemoteAddress)
        let gatewayLabel = gatewayName ?? gatewayAddress ?? "Gateway"
        let activeAgentID = self.resolveActiveAgentID()
        let agents = self.homeCanvasAgents(activeAgentID: activeAgentID)

        switch self.gatewayStatus {
        case .connected:
            var payload = HomeCanvasPayload(
                gatewayState: "connected",
                eyebrow: "Connected to \(gatewayLabel)",
                title: "Your agents are ready",
                subtitle:
                "This phone stays dormant until the gateway needs it, then wakes, syncs, and goes back to sleep.",
                gatewayLabel: gatewayLabel,
                activeAgentName: appModel.activeAgentName,
                activeAgentBadge: agents.first(where: { $0.isActive })?.badge ?? "OC",
                activeAgentCaption: "Selected on this phone",
                agentCount: agents.count,
                agents: Array(agents.prefix(6)),
                footer: "The overview refreshes on reconnect and when the app returns to foreground.")
            let actionCards = Self.homeActionCards(from: self.homeActionQueue)
            if let leadingAction = homeActionQueue.first {
                payload.nextLabel = leadingAction.actionLabel ?? "Proactive queue"
                payload.nextCaption =
                    "\(leadingAction.title): \(Self.compact(leadingAction.caption, maxLength: 120))"
            }
            if !actionCards.isEmpty {
                payload.attention = Array(actionCards.prefix(3))
                payload.actions = Array((actionCards + payload.actions).prefix(4))
            }
            return payload
        case .connecting:
            return HomeCanvasPayload(
                gatewayState: "connecting",
                eyebrow: "Reconnecting",
                title: "OpenClaw is syncing back up",
                subtitle:
                "The gateway session is coming back online. "
                    + "Agent shortcuts should settle automatically in a moment.",
                gatewayLabel: gatewayLabel,
                activeAgentName: self.appModel.activeAgentName,
                activeAgentBadge: "OC",
                activeAgentCaption: "Gateway session in progress",
                agentCount: agents.count,
                agents: Array(agents.prefix(4)),
                footer: "If the gateway is reachable, reconnect should complete without intervention.")
        case .error, .disconnected:
            return HomeCanvasPayload(
                gatewayState: self.gatewayStatus == .error ? "error" : "offline",
                eyebrow: "Welcome to OpenClaw",
                title: "Your phone stays quiet until it is needed",
                subtitle:
                "Pair this device to your gateway to wake it only for real work, "
                    + "keep a live agent overview handy, and avoid battery-draining background loops.",
                gatewayLabel: gatewayLabel,
                activeAgentName: "Main",
                activeAgentBadge: "OC",
                activeAgentCaption: "Connect to load your agents",
                agentCount: agents.count,
                agents: Array(agents.prefix(4)),
                footer:
                "When connected, the gateway can wake the phone with a silent push "
                    + "instead of holding an always-on session.")
        }
    }

    private func resolveActiveAgentID() -> String {
        let selected = self.normalized(self.appModel.selectedAgentId) ?? ""
        if !selected.isEmpty {
            return selected
        }
        return self.resolveDefaultAgentID()
    }

    private func resolveDefaultAgentID() -> String {
        self.normalized(self.appModel.gatewayDefaultAgentId) ?? ""
    }

    private func homeCanvasAgents(activeAgentID: String) -> [HomeCanvasAgentCard] {
        let defaultAgentID = self.resolveDefaultAgentID()
        let cards = self.appModel.gatewayAgents.map { agent -> HomeCanvasAgentCard in
            let isActive = !activeAgentID.isEmpty && agent.id == activeAgentID
            let isDefault = !defaultAgentID.isEmpty && agent.id == defaultAgentID
            return HomeCanvasAgentCard(
                id: agent.id,
                name: self.homeCanvasName(for: agent),
                badge: self.homeCanvasBadge(for: agent),
                caption: isActive ? "Active on this phone" : (isDefault ? "Default agent" : "Ready"),
                isActive: isActive)
        }

        return cards.sorted { lhs, rhs in
            if lhs.isActive != rhs.isActive {
                return lhs.isActive
            }
            return lhs.name.localizedCaseInsensitiveCompare(rhs.name) == .orderedAscending
        }
    }

    private func homeCanvasName(for agent: AgentSummary) -> String {
        self.normalized(agent.name) ?? agent.id
    }

    private func homeCanvasBadge(for agent: AgentSummary) -> String {
        if let identity = agent.identity,
           let emoji = identity["emoji"]?.value as? String,
           let normalizedEmoji = normalized(emoji)
        {
            return normalizedEmoji
        }
        let words = self.homeCanvasName(for: agent)
            .split(whereSeparator: { $0.isWhitespace || $0 == "-" || $0 == "_" })
            .prefix(2)
        let initials = words.compactMap(\.first).map(String.init).joined()
        if !initials.isEmpty {
            return initials.uppercased()
        }
        return "OC"
    }

    private func normalized(_ value: String?) -> String? {
        guard let value else { return nil }
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }

    private static func homeActionCards(from items: [HomeCanvasActionQueueItem]) -> [HomeCanvasCard] {
        items
            .filter { $0.status == "open" || $0.status == "in_progress" }
            .prefix(8)
            .map { item in
                HomeCanvasCard(
                    kicker: Self.actionSourceLabel(item.source),
                    title: Self.compact(item.title, maxLength: 54),
                    caption: Self.compact(item.caption, maxLength: 130),
                    status: item.priority,
                    badge: item.actionLabel,
                    id: item.id,
                    isActive: item.status == "in_progress")
            }
    }

    private static func compact(_ value: String?, maxLength: Int) -> String {
        let trimmed = (value ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return "No summary provided." }
        guard trimmed.count > maxLength else { return trimmed }
        let end = trimmed.index(trimmed.startIndex, offsetBy: max(1, maxLength - 1))
        return String(trimmed[..<end]).trimmingCharacters(in: .whitespacesAndNewlines) + "..."
    }

    private static func actionSourceLabel(_ source: String) -> String {
        switch source.lowercased() {
        case "bluebubbles": "BlueBubbles"
        case "notion": "Notion"
        case "cron": "Cron"
        case "talk": "Talk"
        case "canvas": "Canvas"
        case "system": "System"
        default: "Thomas"
        }
    }

    private func evaluateOnboardingPresentation(force: Bool) {
        if force {
            self.onboardingAllowSkip = true
            self.showOnboarding = true
            return
        }

        guard !self.didEvaluateOnboarding else { return }
        self.didEvaluateOnboarding = true
        let route = Self.startupPresentationRoute(
            gatewayConnected: self.appModel.gatewayServerName != nil,
            hasConnectedOnce: self.hasConnectedOnce,
            onboardingComplete: self.onboardingComplete,
            hasExistingGatewayConfig: self.hasExistingGatewayConfig(),
            shouldPresentOnLaunch: OnboardingStateStore.shouldPresentOnLaunch(appModel: self.appModel))
        switch route {
        case .none:
            break
        case .onboarding:
            self.onboardingAllowSkip = true
            self.showOnboarding = true
        case .settings:
            self.didAutoOpenSettings = true
            self.presentedSheet = .settings
        }
    }

    private func hasExistingGatewayConfig() -> Bool {
        if self.appModel.activeGatewayConnectConfig != nil { return true }
        if GatewaySettingsStore.loadLastGatewayConnection() != nil { return true }

        let preferredStableID = self.preferredGatewayStableID.trimmingCharacters(in: .whitespacesAndNewlines)
        if !preferredStableID.isEmpty { return true }

        let manualHost = self.manualGatewayHost.trimmingCharacters(in: .whitespacesAndNewlines)
        return self.manualGatewayEnabled && !manualHost.isEmpty
    }

    private func maybeAutoOpenSettings() {
        guard !self.didAutoOpenSettings else { return }
        guard !self.showOnboarding else { return }
        let route = Self.startupPresentationRoute(
            gatewayConnected: self.appModel.gatewayServerName != nil,
            hasConnectedOnce: self.hasConnectedOnce,
            onboardingComplete: self.onboardingComplete,
            hasExistingGatewayConfig: self.hasExistingGatewayConfig(),
            shouldPresentOnLaunch: false)
        guard route == .settings else { return }
        self.didAutoOpenSettings = true
        self.presentedSheet = .settings
    }

    private func maybeShowQuickSetup() {
        let shouldPresent = Self.shouldPresentQuickSetup(
            quickSetupDismissed: self.quickSetupDismissed,
            showOnboarding: self.showOnboarding,
            hasPresentedSheet: self.presentedSheet != nil,
            gatewayConnected: self.appModel.gatewayServerName != nil,
            hasExistingGatewayConfig: self.hasExistingGatewayConfig(),
            discoveredGatewayCount: self.gatewayController.gateways.count)
        guard shouldPresent else { return }
        self.presentedSheet = .quickSetup
    }
}

private struct HomeCanvasPayload: Codable {
    var gatewayState: String
    var eyebrow: String
    var title: String
    var subtitle: String
    var mood: String = "Ready"
    var moodNote: String = "Personal, fast, and only mildly too pleased with itself."
    var gatewayLabel: String
    var gatewayCaption: String = "Gateway status is refreshed from this phone."
    var activeAgentName: String
    var activeAgentBadge: String
    var activeAgentCaption: String
    var talkLabel: String = "Standby"
    var talkCaption: String = "Voice can step in once a conversation starts."
    var nextLabel: String = "Proactive queue"
    var nextCaption: String = "Suggestions, useful handoffs, and gateway context land here."
    var plan: [HomeCanvasCard] = [
        HomeCanvasCard(
            title: "Keep priorities visible",
            caption: "Current work, approvals, reminders, and handoff stay in view.",
            status: "ready"),
        HomeCanvasCard(
            title: "Turn context into action",
            caption: "Use Canvas for previews, checklists, generated pages, and device actions.",
            status: "next"),
        HomeCanvasCard(
            title: "Stay useful and personal",
            caption: "Thomas should be quick, direct, funny when useful, and proactive without becoming noisy.",
            status: "soon"),
    ]
    var actions: [HomeCanvasCard] = [
        HomeCanvasCard(
            kicker: "Work",
            title: "Draft a message",
            caption: "Turn a summary into a BlueBubbles-ready approval draft."),
        HomeCanvasCard(
            kicker: "Voice",
            title: "Check Talk",
            caption: "Review provider, key, voice, and latency state."),
        HomeCanvasCard(kicker: "Notion", title: "Pin context", caption: "Keep important pages and reminders close."),
        HomeCanvasCard(
            kicker: "Files",
            title: "Preview output",
            caption: "Render generated pages, docs, and screenshots here."),
    ]
    var devices: [HomeCanvasCard] = [
        HomeCanvasCard(caption: "Local control center", badge: "Mac", name: "Mac gateway", isActive: true),
        HomeCanvasCard(caption: "Paired assistant mode", badge: "iOS", name: "iPhone"),
    ]
    var memories: [HomeCanvasCard] = [
        HomeCanvasCard(caption: "Personal, direct, funny when it helps.", badge: "Tone", name: "Tone"),
        HomeCanvasCard(caption: "Fast voice first, cloud deluxe when available.", badge: "Voice", name: "Voice"),
        HomeCanvasCard(caption: "Make the next useful action obvious.", badge: "Next", name: "Focus"),
    ]
    var notion: [HomeCanvasCard] = [
        HomeCanvasCard(
            kicker: "Notion",
            title: "Connect a source",
            caption: "Important Notion pages, projects, and reminders will sit here once Thomas has a source."),
    ]
    var cronRuns: [HomeCanvasCard] = [
        HomeCanvasCard(
            kicker: "Cron",
            title: "No recent run yet",
            caption: "Completed automation runs will appear here with compact summaries."),
    ]
    var attention: [HomeCanvasCard] = [
        HomeCanvasCard(
            kicker: "Ready",
            title: "Choose the next useful thing",
            caption: "Thomas is watching for follow-ups, failures, approvals, and handoffs."),
    ]
    var seriousSuggestion: HomeCanvasSuggestion = .init(
        kicker: "Serious suggestion",
        title: "Draft a useful BlueBubbles message",
        caption: "Summarize a news article, make it personal, and queue the message for approval before sending.",
        actionLabel: "Prepare draft")
    var funSuggestion: HomeCanvasSuggestion = .init(
        kicker: "Fun suggestion",
        title: "Teach Thomas image generation",
        caption: "Add a playful image mode with prompt templates, style memory, and Canvas previews.",
        actionLabel: "Explore image mode")
    var agentCount: Int
    var agents: [HomeCanvasAgentCard]
    var footer: String
}

private struct HomeCanvasActionQueueItem: Codable, Equatable {
    var id: String
    var title: String
    var caption: String?
    var kind: String
    var source: String
    var priority: String
    var status: String
    var createdAtMs: Int
    var updatedAtMs: Int
    var dueAtMs: Int?
    var actionLabel: String?
}

private struct HomeCanvasCard: Codable {
    var kicker: String?
    var title: String?
    var caption: String?
    var status: String?
    var badge: String?
    var name: String?
    var id: String?
    var isActive: Bool?
}

private struct HomeCanvasSuggestion: Codable {
    var kicker: String
    var title: String
    var caption: String
    var actionLabel: String
}

private struct HomeCanvasAgentCard: Codable {
    var id: String
    var name: String
    var badge: String
    var caption: String
    var isActive: Bool
}

private struct CanvasContent: View {
    @Environment(NodeAppModel.self) private var appModel
    @Environment(GatewayConnectionController.self) private var gatewayController
    @AppStorage("talk.enabled") private var talkEnabled: Bool = false
    @AppStorage("talk.button.enabled") private var talkButtonEnabled: Bool = true
    @State private var showGatewayActions: Bool = false
    @State private var showGatewayProblemDetails: Bool = false
    var systemColorScheme: ColorScheme
    var gatewayStatus: StatusPill.GatewayState
    var voiceWakeEnabled: Bool
    var voiceWakeToastText: String?
    var cameraHUDText: String?
    var cameraHUDKind: NodeAppModel.CameraHUDKind?
    var openChat: () -> Void
    var openSettings: () -> Void
    var retryGatewayConnection: () -> Void

    private var brightenButtons: Bool {
        self.systemColorScheme == .light
    }

    private var talkActive: Bool {
        self.appModel.talkMode.isEnabled || self.talkEnabled
    }

    var body: some View {
        ZStack {
            ScreenTab()
        }
        .overlay(alignment: .center) {
            if self.talkActive {
                TalkOrbOverlay()
                    .transition(.opacity)
            }
        }
        .safeAreaInset(edge: .bottom, spacing: 0) {
            HomeToolbar(
                gateway: self.gatewayStatus,
                voiceWakeEnabled: self.voiceWakeEnabled,
                activity: self.statusActivity,
                brighten: self.brightenButtons,
                talkButtonEnabled: self.talkButtonEnabled,
                talkActive: self.talkActive,
                talkTint: self.appModel.seamColor,
                onStatusTap: {
                    if self.gatewayStatus == .connected {
                        self.showGatewayActions = true
                    } else if self.appModel.lastGatewayProblem != nil {
                        self.showGatewayProblemDetails = true
                    } else {
                        self.openSettings()
                    }
                },
                onChatTap: {
                    self.openChat()
                },
                onTalkTap: {
                    let next = !self.talkActive
                    self.talkEnabled = next
                    self.appModel.setTalkEnabled(next)
                },
                onSettingsTap: {
                    self.openSettings()
                })
        }
        .overlay(alignment: .top) {
            if let gatewayProblem = self.appModel.lastGatewayProblem,
               self.gatewayStatus != .connected
            {
                GatewayProblemBanner(
                    problem: gatewayProblem,
                    primaryActionTitle: self.gatewayProblemPrimaryActionTitle(gatewayProblem),
                    onPrimaryAction: {
                        self.handleGatewayProblemPrimaryAction(gatewayProblem)
                    },
                    onShowDetails: {
                        self.showGatewayProblemDetails = true
                    })
                    .padding(.horizontal, 12)
                    .safeAreaPadding(.top, 10)
                    .transition(.move(edge: .top).combined(with: .opacity))
            }
        }
        .overlay(alignment: .topLeading) {
            if let voiceWakeToastText, !voiceWakeToastText.isEmpty {
                VoiceWakeToast(
                    command: voiceWakeToastText,
                    brighten: self.brightenButtons)
                    .padding(.leading, 10)
                    .safeAreaPadding(.top, self.appModel.lastGatewayProblem == nil ? 58 : 132)
                    .transition(.move(edge: .top).combined(with: .opacity))
            }
        }
        .gatewayActionsDialog(
            isPresented: self.$showGatewayActions,
            onDisconnect: { self.appModel.disconnectGateway() },
            onOpenSettings: { self.openSettings() })
        .sheet(isPresented: self.$showGatewayProblemDetails) {
            if let gatewayProblem = self.appModel.lastGatewayProblem {
                GatewayProblemDetailsSheet(
                    problem: gatewayProblem,
                    primaryActionTitle: self.gatewayProblemPrimaryActionTitle(gatewayProblem),
                    onPrimaryAction: {
                        self.handleGatewayProblemPrimaryAction(gatewayProblem)
                    })
            }
        }
        .onAppear {
            // Keep the runtime talk state aligned with persisted toggle state on cold launch.
            if self.talkEnabled != self.appModel.talkMode.isEnabled {
                self.appModel.setTalkEnabled(self.talkEnabled)
            }
        }
    }

    private var statusActivity: StatusPill.Activity? {
        StatusActivityBuilder.build(
            appModel: self.appModel,
            voiceWakeEnabled: self.voiceWakeEnabled,
            cameraHUDText: self.cameraHUDText,
            cameraHUDKind: self.cameraHUDKind)
    }

    private func gatewayProblemPrimaryActionTitle(_ problem: GatewayConnectionProblem) -> String {
        if problem.canTrustRotatedCertificate { return "Trust certificate" }
        return problem.retryable ? "Retry" : "Open Settings"
    }

    private func handleGatewayProblemPrimaryAction(_ problem: GatewayConnectionProblem) {
        if problem.canTrustRotatedCertificate {
            Task { await self.gatewayController.trustRotatedGatewayCertificate(from: problem) }
        } else if problem.retryable {
            self.retryGatewayConnection()
        } else {
            self.openSettings()
        }
    }
}

private struct CameraFlashOverlay: View {
    var nonce: Int

    @State private var opacity: CGFloat = 0
    @State private var task: Task<Void, Never>?

    var body: some View {
        Color.white
            .opacity(self.opacity)
            .ignoresSafeArea()
            .allowsHitTesting(false)
            .onChange(of: self.nonce) { _, _ in
                self.task?.cancel()
                self.task = Task { @MainActor in
                    withAnimation(.easeOut(duration: 0.08)) {
                        self.opacity = 0.85
                    }
                    try? await Task.sleep(nanoseconds: 110_000_000)
                    withAnimation(.easeOut(duration: 0.32)) {
                        self.opacity = 0
                    }
                }
            }
    }
}
