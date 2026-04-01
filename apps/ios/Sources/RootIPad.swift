import OpenClawChatUI
import OpenClawKit
import OpenClawProtocol
import SwiftUI
import UIKit

struct RootIPad: View {
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
    @AppStorage("gateway.addAnotherMode") private var addAnotherGatewayMode: Bool = false
    @State private var selectedPanel: Panel = .chat
    @State private var showGatewayActions: Bool = false
    @State private var showQuickSetup: Bool = false
    @State private var showOnboarding: Bool = false
    @State private var onboardingAllowSkip: Bool = true
    @State private var didEvaluateOnboarding: Bool = false
    @State private var didAutoSelectSettings: Bool = false
    @State private var voiceWakeToastText: String?
    @State private var toastDismissTask: Task<Void, Never>?

    private enum Panel: String, CaseIterable, Identifiable {
        case chat
        case voice
        case settings

        var id: String { self.rawValue }

        var title: String {
            switch self {
            case .chat: "Chat"
            case .voice: "Voice"
            case .settings: "Settings"
            }
        }

        var systemImage: String {
            switch self {
            case .chat: "text.bubble"
            case .voice: "waveform"
            case .settings: "gearshape"
            }
        }
    }

    var body: some View {
        GeometryReader { proxy in
            HStack(spacing: 0) {
                self.sidebar
                    .frame(width: self.sidebarWidth(for: proxy.size.width))
                    .background(Color(uiColor: .secondarySystemBackground))

                Divider()

                self.utilityPane
                    .frame(width: self.utilityWidth(for: proxy.size.width))
                    .background(Color(uiColor: .systemBackground))
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
            .background(Color(uiColor: .systemBackground).ignoresSafeArea())
        }
        .gatewayActionsDialog(
            isPresented: self.$showGatewayActions,
            savedGateways: self.savedGateways,
            currentGatewayProfileID: self.currentGatewayProfileID,
            onSwitchGateway: { gateway in
                Task { await self.gatewayController.connectSavedProfile(gateway) }
            },
            onAddGateway: { self.requestAddAnotherGateway() },
            onDisconnect: { self.appModel.disconnectGateway() },
            onOpenSettings: { self.selectedPanel = .settings })
        .sheet(isPresented: self.$showQuickSetup) {
            GatewayQuickSetupSheet()
                .environment(self.appModel)
                .environment(self.gatewayController)
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
        .gatewayTrustPromptAlert()
        .deepLinkAgentPromptAlert()
        .onAppear { self.updateIdleTimer() }
        .onAppear { self.updateHomeCanvasState() }
        .onAppear { self.evaluateOnboardingPresentation(force: false) }
        .onAppear { self.maybeSelectSettingsPanel() }
        .onAppear { self.maybeShowQuickSetup() }
        .onAppear { self.updateCanvasDebugStatus() }
        .onChange(of: self.preventSleep) { _, _ in self.updateIdleTimer() }
        .onChange(of: self.scenePhase) { _, newValue in
            self.updateIdleTimer()
            self.updateHomeCanvasState()
            guard newValue == .active else { return }
            Task {
                await self.appModel.refreshGatewayOverviewIfConnected()
                await MainActor.run {
                    self.updateHomeCanvasState()
                }
            }
        }
        .onChange(of: self.gatewayController.gateways.count) { _, _ in self.maybeShowQuickSetup() }
        .onChange(of: self.canvasDebugStatusEnabled) { _, _ in self.updateCanvasDebugStatus() }
        .onChange(of: self.appModel.gatewayStatusText) { _, _ in
            self.updateCanvasDebugStatus()
            self.updateHomeCanvasState()
        }
        .onChange(of: self.appModel.gatewayServerName) { _, newValue in
            self.updateCanvasDebugStatus()
            self.updateHomeCanvasState()
            if newValue != nil {
                self.showOnboarding = false
                self.onboardingComplete = true
                self.hasConnectedOnce = true
                OnboardingStateStore.markCompleted(mode: nil)
            }
            self.maybeSelectSettingsPanel()
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
        }
    }

    private var sidebar: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                VStack(alignment: .leading, spacing: 10) {
                    Text("OpenClaw")
                        .font(.system(size: 30, weight: .bold, design: .rounded))
                    Text("iPad workspace")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }

                StatusPill(
                    gateway: self.gatewayStatus,
                    voiceWakeEnabled: self.voiceWakeEnabled,
                    activity: self.statusActivity,
                    brighten: self.systemColorScheme == .light,
                    onTap: {
                        if self.gatewayStatus == .connected {
                            self.showGatewayActions = true
                        } else {
                            self.selectedPanel = .settings
                        }
                    })

                self.connectionCard

                self.panelPicker

                self.gatewayListCard
            }
            .padding(24)
        }
    }

    @ViewBuilder
    private var connectionCard: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Connection")
                .font(.headline)

            Text(self.connectionSummaryTitle)
                .font(.title3.weight(.semibold))

            Text(self.connectionSummaryDetail)
                .font(.subheadline)
                .foregroundStyle(.secondary)

            HStack(spacing: 10) {
                Button {
                    self.requestAddAnotherGateway()
                } label: {
                    Label("Add Gateway", systemImage: "plus.circle")
                }
                .buttonStyle(.borderedProminent)

                Button {
                    self.selectedPanel = .settings
                } label: {
                    Label("Settings", systemImage: "gearshape")
                }
                .buttonStyle(.bordered)
            }

            if self.appModel.gatewayServerName != nil {
                Button(role: .destructive) {
                    self.appModel.disconnectGateway()
                } label: {
                    Label("Disconnect", systemImage: "xmark.circle")
                }
                .buttonStyle(.bordered)
            }
        }
        .statusGlassCard(brighten: self.systemColorScheme == .light, verticalPadding: 16, horizontalPadding: 16)
    }

    private var panelPicker: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Workspace")
                .font(.headline)

            ForEach(Panel.allCases) { panel in
                Button {
                    self.selectedPanel = panel
                } label: {
                    HStack(spacing: 12) {
                        Image(systemName: panel.systemImage)
                            .frame(width: 20)
                        Text(panel.title)
                        Spacer()
                        if self.selectedPanel == panel {
                            Image(systemName: "checkmark.circle.fill")
                                .foregroundStyle(self.appModel.seamColor)
                        }
                    }
                    .padding(.horizontal, 14)
                    .padding(.vertical, 12)
                    .background(
                        RoundedRectangle(cornerRadius: 14, style: .continuous)
                            .fill(self.selectedPanel == panel ? self.appModel.seamColor.opacity(0.16) : Color.primary.opacity(0.05))
                    )
                }
                .buttonStyle(.plain)
            }
        }
    }

    private var gatewayListCard: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Saved Gateways")
                .font(.headline)

            if self.savedGateways.isEmpty {
                Text("No gateways saved yet.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            } else {
                ForEach(self.savedGateways) { gateway in
                    Button {
                        Task { await self.gatewayController.connectSavedProfile(gateway) }
                    } label: {
                        HStack(alignment: .top, spacing: 12) {
                            VStack(alignment: .leading, spacing: 4) {
                                Text(gateway.resolvedName)
                                    .font(.subheadline.weight(.semibold))
                                    .foregroundStyle(.primary)
                                Text(gateway.addressLabel)
                                    .font(.footnote)
                                    .foregroundStyle(.secondary)
                            }

                            Spacer(minLength: 0)

                            if gateway.id == self.currentGatewayProfileID {
                                Image(systemName: "checkmark.circle.fill")
                                    .foregroundStyle(.green)
                            }
                        }
                        .padding(.horizontal, 14)
                        .padding(.vertical, 12)
                        .background(
                            RoundedRectangle(cornerRadius: 14, style: .continuous)
                                .fill(gateway.id == self.currentGatewayProfileID ? Color.green.opacity(0.14) : Color.primary.opacity(0.04))
                        )
                    }
                    .buttonStyle(.plain)
                }
            }
        }
    }

    private var utilityPane: some View {
        ZStack(alignment: .topLeading) {
            Group {
                switch self.selectedPanel {
                case .chat:
                    IPadChatPanel(
                        gateway: self.appModel.operatorSession,
                        sessionKey: self.appModel.chatSessionKey,
                        userAccent: self.appModel.seamColor,
                        isConnected: self.appModel.gatewayServerName != nil)
                        .id(self.chatPanelIdentity)
                case .voice:
                    VoiceTab()
                case .settings:
                    SettingsTab(showsCloseButton: false)
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)

            if let voiceWakeToastText, !voiceWakeToastText.isEmpty {
                VoiceWakeToast(command: voiceWakeToastText, brighten: self.systemColorScheme == .light)
                    .padding(.leading, 18)
                    .padding(.top, 18)
                    .transition(.move(edge: .top).combined(with: .opacity))
            }
        }
    }

    private var gatewayStatus: StatusPill.GatewayState {
        GatewayStatusBuilder.build(appModel: self.appModel)
    }

    private var statusActivity: StatusPill.Activity? {
        StatusActivityBuilder.build(
            appModel: self.appModel,
            voiceWakeEnabled: self.voiceWakeEnabled,
            cameraHUDText: self.appModel.cameraHUDText,
            cameraHUDKind: self.appModel.cameraHUDKind)
    }

    private var savedGateways: [GatewaySettingsStore.SavedGatewayProfile] {
        GatewaySettingsStore.loadSavedGatewayProfiles()
    }

    private var currentGatewayProfileID: String? {
        let stableID = (self.appModel.connectedGatewayID ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        let host = self.appModel.activeGatewayConnectConfig?.url.host
        let port = self.appModel.activeGatewayConnectConfig?.url.port
        let useTLS = self.appModel.activeGatewayConnectConfig?.url.scheme?.lowercased() == "wss"

        return GatewaySettingsStore.findSavedGatewayProfile(
            stableID: stableID.isEmpty ? nil : stableID,
            hosts: host.map { [$0] } ?? [],
            port: port,
            useTLS: useTLS
        )?.id
    }

    private var connectionSummaryTitle: String {
        if let serverName = self.appModel.gatewayServerName {
            return serverName
        }
        return self.gatewayStatus.title
    }

    private var connectionSummaryDetail: String {
        if let address = self.appModel.gatewayRemoteAddress {
            return address
        }
        let status = self.appModel.gatewayStatusText.trimmingCharacters(in: .whitespacesAndNewlines)
        return status.isEmpty ? "Pair this iPad with a gateway to activate chat and canvas." : status
    }

    private var chatPanelIdentity: String {
        let gatewayID = (self.appModel.connectedGatewayID ?? "offline").trimmingCharacters(in: .whitespacesAndNewlines)
        return "\(gatewayID)|\(self.appModel.chatSessionKey)"
    }

    private func sidebarWidth(for totalWidth: CGFloat) -> CGFloat {
        min(max(totalWidth * 0.2, 260), 320)
    }

    private func utilityWidth(for totalWidth: CGFloat) -> CGFloat {
        max(totalWidth - self.sidebarWidth(for: totalWidth) - 1, totalWidth * 0.75)
    }

    private func requestAddAnotherGateway() {
        self.addAnotherGatewayMode = true
        self.onboardingRequestID += 1
    }

    private func updateIdleTimer() {
        UIApplication.shared.isIdleTimerDisabled = (self.scenePhase == .active && self.preventSleep)
    }

    private func updateCanvasDebugStatus() {
        self.appModel.screen.setDebugStatusEnabled(self.canvasDebugStatusEnabled)
        guard self.canvasDebugStatusEnabled else { return }
        let title = self.appModel.gatewayStatusText.trimmingCharacters(in: .whitespacesAndNewlines)
        let subtitle = self.appModel.gatewayServerName ?? self.appModel.gatewayRemoteAddress
        self.appModel.screen.updateDebugStatus(title: title, subtitle: subtitle)
    }

    private func evaluateOnboardingPresentation(force: Bool) {
        if force {
            self.onboardingAllowSkip = true
            self.showOnboarding = true
            return
        }

        guard !self.didEvaluateOnboarding else { return }
        self.didEvaluateOnboarding = true
        let route = RootCanvas.startupPresentationRoute(
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
            self.didAutoSelectSettings = true
            self.selectedPanel = .settings
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

    private func maybeSelectSettingsPanel() {
        guard !self.didAutoSelectSettings else { return }
        guard !self.showOnboarding else { return }
        let route = RootCanvas.startupPresentationRoute(
            gatewayConnected: self.appModel.gatewayServerName != nil,
            hasConnectedOnce: self.hasConnectedOnce,
            onboardingComplete: self.onboardingComplete,
            hasExistingGatewayConfig: self.hasExistingGatewayConfig(),
            shouldPresentOnLaunch: false)
        guard route == .settings else { return }
        self.didAutoSelectSettings = true
        self.selectedPanel = .settings
    }

    private func maybeShowQuickSetup() {
        let shouldPresent = RootCanvas.shouldPresentQuickSetup(
            quickSetupDismissed: self.quickSetupDismissed,
            showOnboarding: self.showOnboarding,
            hasPresentedSheet: self.showQuickSetup || self.showGatewayActions,
            gatewayConnected: self.appModel.gatewayServerName != nil,
            hasExistingGatewayConfig: self.hasExistingGatewayConfig(),
            discoveredGatewayCount: self.gatewayController.gateways.count)
        guard shouldPresent else { return }
        self.showQuickSetup = true
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

    private func makeHomeCanvasPayload() -> IPadHomeCanvasPayload {
        let gatewayName = self.normalized(self.appModel.gatewayServerName)
        let gatewayAddress = self.normalized(self.appModel.gatewayRemoteAddress)
        let gatewayLabel = gatewayName ?? gatewayAddress ?? "Gateway"
        let activeAgentID = self.resolveActiveAgentID()
        let agents = self.homeCanvasAgents(activeAgentID: activeAgentID)

        switch self.gatewayStatus {
        case .connected:
            return IPadHomeCanvasPayload(
                gatewayState: "connected",
                eyebrow: "Connected to \(gatewayLabel)",
                title: "Your agents are ready",
                subtitle: "This iPad stays ready for canvas and chat while the gateway handles the heavy lifting.",
                gatewayLabel: gatewayLabel,
                activeAgentName: self.appModel.activeAgentName,
                activeAgentBadge: agents.first(where: { $0.isActive })?.badge ?? "OC",
                activeAgentCaption: "Selected on this iPad",
                agentCount: agents.count,
                agents: Array(agents.prefix(6)),
                footer: "Switch gateways from the left column without leaving the workspace.")
        case .connecting:
            return IPadHomeCanvasPayload(
                gatewayState: "connecting",
                eyebrow: "Reconnecting",
                title: "OpenClaw is syncing back up",
                subtitle: "The gateway session is coming back online. Canvas and chat should settle automatically.",
                gatewayLabel: gatewayLabel,
                activeAgentName: self.appModel.activeAgentName,
                activeAgentBadge: "OC",
                activeAgentCaption: "Gateway session in progress",
                agentCount: agents.count,
                agents: Array(agents.prefix(4)),
                footer: "If the gateway is reachable, reconnect should complete without intervention.")
        case .error, .disconnected:
            return IPadHomeCanvasPayload(
                gatewayState: self.gatewayStatus == .error ? "error" : "offline",
                eyebrow: "Welcome to OpenClaw",
                title: "Pair this iPad to unlock the workspace",
                subtitle: "Connect a gateway to keep the live canvas in view while chat, voice, and settings stay beside it.",
                gatewayLabel: gatewayLabel,
                activeAgentName: "Main",
                activeAgentBadge: "OC",
                activeAgentCaption: "Connect to load your agents",
                agentCount: agents.count,
                agents: Array(agents.prefix(4)),
                footer: "Once connected, the sidebar becomes your gateway switcher and control surface.")
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

    private func homeCanvasAgents(activeAgentID: String) -> [IPadHomeCanvasAgentCard] {
        let defaultAgentID = self.resolveDefaultAgentID()
        let cards = self.appModel.gatewayAgents.map { agent -> IPadHomeCanvasAgentCard in
            let isActive = !activeAgentID.isEmpty && agent.id == activeAgentID
            let isDefault = !defaultAgentID.isEmpty && agent.id == defaultAgentID
            return IPadHomeCanvasAgentCard(
                id: agent.id,
                name: self.homeCanvasName(for: agent),
                badge: self.homeCanvasBadge(for: agent),
                caption: isActive ? "Active on this iPad" : (isDefault ? "Default agent" : "Ready"),
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
           let normalizedEmoji = self.normalized(emoji)
        {
            return normalizedEmoji
        }
        let words = self.homeCanvasName(for: agent)
            .split(whereSeparator: { $0.isWhitespace || $0 == "-" || $0 == "_" })
            .prefix(2)
        let initials = words.compactMap { $0.first }.map(String.init).joined()
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
}

private struct IPadChatPanel: View {
    let gateway: GatewayNodeSession
    let sessionKey: String
    let userAccent: Color?
    let isConnected: Bool

    var body: some View {
        if self.isConnected {
            IPadChatContent(
                gateway: self.gateway,
                sessionKey: self.sessionKey,
                userAccent: self.userAccent)
        } else {
            ContentUnavailableView(
                "Chat Needs a Gateway",
                systemImage: "text.bubble",
                description: Text("Connect this iPad to a gateway to start chatting."))
        }
    }
}

private struct IPadChatContent: View {
    @State private var viewModel: OpenClawChatViewModel
    private let userAccent: Color?

    init(gateway: GatewayNodeSession, sessionKey: String, userAccent: Color? = nil) {
        let transport = IOSGatewayChatTransport(gateway: gateway)
        self._viewModel = State(
            initialValue: OpenClawChatViewModel(
                sessionKey: sessionKey,
                transport: transport))
        self.userAccent = userAccent
    }

    var body: some View {
        OpenClawChatView(
            viewModel: self.viewModel,
            showsSessionSwitcher: true,
            userAccent: self.userAccent)
    }
}

private struct IPadHomeCanvasPayload: Codable {
    var gatewayState: String
    var eyebrow: String
    var title: String
    var subtitle: String
    var gatewayLabel: String
    var activeAgentName: String?
    var activeAgentBadge: String
    var activeAgentCaption: String
    var agentCount: Int
    var agents: [IPadHomeCanvasAgentCard]
    var footer: String
}

private struct IPadHomeCanvasAgentCard: Codable {
    var id: String
    var name: String
    var badge: String
    var caption: String
    var isActive: Bool
}
