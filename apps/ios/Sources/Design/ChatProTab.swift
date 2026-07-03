import OpenClawChatUI
import OpenClawProtocol
import SwiftUI

struct ChatProTab: View {
    @Environment(NodeAppModel.self) private var appModel
    @State private var viewModel: OpenClawChatViewModel?
    @State private var viewModelTransportModeID = ""
    let headerLeadingAction: OpenClawSidebarHeaderAction?
    let headerTitle: String?
    let headerSubtitle: String?
    let showsAgentBadge: Bool
    let ownsNavigationStack: Bool
    let openSettings: (() -> Void)?

    init(
        headerLeadingAction: OpenClawSidebarHeaderAction? = nil,
        headerTitle: String? = nil,
        headerSubtitle: String? = nil,
        showsAgentBadge: Bool = true,
        ownsNavigationStack: Bool = true,
        openSettings: (() -> Void)? = nil)
    {
        self.headerLeadingAction = headerLeadingAction
        self.headerTitle = headerTitle
        self.headerSubtitle = headerSubtitle
        self.showsAgentBadge = showsAgentBadge
        self.ownsNavigationStack = ownsNavigationStack
        self.openSettings = openSettings
    }

    var body: some View {
        Group {
            if self.ownsNavigationStack {
                NavigationStack {
                    self.content
                }
            } else if self.headerTitle == nil {
                // Phone tab embeds in the host's NavigationStack; the native bar
                // there renders our title/toolbar, so no custom header.
                self.content
            } else {
                VStack(spacing: 0) {
                    // Embedded (iPad sidebar) chat draws its own header; the phone
                    // tab uses the native navigation bar instead.
                    OpenClawAdaptiveHeaderRow(
                        title: self.headerDisplayTitle,
                        subtitle: nil,
                        titleFont: .headline.weight(.semibold),
                        subtitleFont: .caption,
                        subtitleLineLimit: 1)
                    {
                        if let headerLeadingAction {
                            OpenClawSidebarHeaderLeadingSlot(action: headerLeadingAction)
                        }
                    } accessory: {
                        self.connectionStatusButton
                            .contentShape(Circle())
                    }
                    self.content
                }
            }
        }
        .task {
            self.syncChatViewModel()
        }
        .onChange(of: self.appModel.chatSessionKey) { _, _ in
            self.syncChatViewModel()
        }
        .onChange(of: self.appModel.isAppleReviewDemoModeEnabled) { _, _ in
            self.syncChatViewModel()
            self.viewModel?.refresh()
        }
        .onChange(of: self.appModel.isScreenshotFixtureModeEnabled) { _, _ in
            self.syncChatViewModel()
            self.viewModel?.refresh()
        }
        .onChange(of: self.appModel.isOperatorGatewayConnected) { _, connected in
            guard connected else { return }
            self.syncChatViewModel()
            self.viewModel?.refresh()
        }
    }

    private var content: some View {
        self.chatSurface
            .background(Color(uiColor: .systemBackground))
            .navigationTitle(self.headerDisplayTitle)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                if let headerLeadingAction {
                    ToolbarItem(placement: .topBarLeading) {
                        OpenClawSidebarRevealButton(action: headerLeadingAction)
                    }
                }
                if self.showsAgentBadge {
                    ToolbarItem(placement: .topBarLeading) {
                        self.headerIdentityBadge
                    }
                }
                ToolbarItem(placement: .topBarTrailing) {
                    self.connectionStatusButton
                        .accessibilityIdentifier("chat-gateway-status")
                }
            }
    }

    @ViewBuilder
    private var chatSurface: some View {
        if let viewModel {
            OpenClawChatView(
                viewModel: viewModel,
                drawsBackground: false,
                showsSessionSwitcher: false,
                userAccent: self.chatUserAccent,
                assistantName: self.agentDisplayName,
                assistantAvatarText: self.agentBadge,
                assistantAvatarTint: OpenClawBrand.accent,
                showsAssistantAvatars: false,
                composerChrome: .clean,
                isComposerEnabled: self.gatewayConnected,
                messagePlaceholder: self.messagePlaceholder,
                talkControl: self.talkControl)
                // iMessage-style grey bubbles for agent replies in the clean chrome.
                    .environment(\.openClawAssistantBubblesInCleanChrome, true)
                    .id(ObjectIdentifier(viewModel))
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        } else {
            ContentUnavailableView(
                "Preparing Chat",
                systemImage: "bubble.left.and.bubble.right",
                description: Text("The session attaches once the gateway is ready."))
        }
    }

    /// Flat circular avatar for the nav bar — no gradient/shadow, per Apple bar-button sizing.
    private var headerIdentityBadge: some View {
        Text(self.agentBadge)
            .font(.system(size: self.agentBadge.count > 2 ? 12 : 15, weight: .semibold, design: .rounded))
            .foregroundStyle(.white)
            .minimumScaleFactor(0.6)
            .lineLimit(1)
            .frame(width: 30, height: 30)
            .background(Circle().fill(OpenClawBrand.accent))
            .accessibilityLabel(self.agentDisplayName)
    }

    private func syncChatViewModel() {
        let sessionKey = self.appModel.chatSessionKey
        let transportModeID = self.appModel.chatTransportModeID
        guard let viewModel else {
            self.viewModelTransportModeID = transportModeID
            self.viewModel = OpenClawChatViewModel(
                sessionKey: sessionKey,
                transport: self.appModel.makeChatTransport(),
                onSessionChanged: { sessionKey in
                    self.appModel.focusChatSession(sessionKey)
                },
                diagnosticsLog: { message in
                    GatewayDiagnostics.log(message)
                })
            return
        }
        if self.viewModelTransportModeID != transportModeID {
            self.viewModelTransportModeID = transportModeID
            self.viewModel = OpenClawChatViewModel(
                sessionKey: sessionKey,
                transport: self.appModel.makeChatTransport(),
                onSessionChanged: { sessionKey in
                    self.appModel.focusChatSession(sessionKey)
                },
                diagnosticsLog: { message in
                    GatewayDiagnostics.log(message)
                })
            return
        }
        guard viewModel.sessionKey != sessionKey else { return }
        viewModel.syncSession(to: sessionKey)
    }

    private var talkControl: OpenClawChatTalkControl {
        OpenClawChatTalkControl(
            isEnabled: self.appModel.talkMode.isEnabled,
            isListening: self.appModel.talkMode.isListening,
            isSpeaking: self.appModel.talkMode.isSpeaking,
            isGatewayConnected: self.appModel.talkMode.isGatewayConnected,
            statusText: self.appModel.talkMode.statusText,
            providerLabel: self.appModel.talkMode.gatewayTalkProviderLabel,
            toggle: { sessionKey in
                self.appModel.focusChatSession(sessionKey)
                self.appModel.setTalkEnabled(!self.appModel.talkMode.isEnabled)
            })
    }

    private var activeAgentID: String {
        self.normalized(self.appModel.chatAgentId)
            ?? "main"
    }

    @ViewBuilder
    private var connectionStatusButton: some View {
        if let openSettings {
            Button(action: openSettings) {
                self.connectionPill
            }
            .buttonStyle(.plain)
            .accessibilityHint("Opens Settings / Gateway")
        } else {
            self.connectionPill
        }
    }

    private var connectionPill: some View {
        HStack(spacing: 5) {
            ProStatusDot(color: self.gatewayPillColor)
            Text(Self.gatewayPillTitle(state: self.gatewayDisplayState, isGatewayUsable: self.gatewayConnected))
                .font(.subheadline.weight(.medium))
                .lineLimit(1)
        }
        .foregroundStyle(self.gatewayPillColor)
        // Even breathing room inside the system glass capsule.
        .padding(.horizontal, 6)
    }

    private var gatewayConnected: Bool {
        guard self.gatewayDisplayState == .connected else {
            return false
        }
        return self.appModel.isLocalChatFixtureEnabled || self.appModel.isOperatorGatewayConnected
    }

    private var gatewayDisplayState: GatewayDisplayState {
        GatewayStatusBuilder.build(appModel: self.appModel)
    }

    private var gatewayAccessibilityLabel: String {
        "Gateway: \(Self.gatewayPillTitle(state: self.gatewayDisplayState, isGatewayUsable: self.gatewayConnected))"
    }

    private var gatewayPillColor: Color {
        switch self.gatewayDisplayState {
        case .connected:
            self.gatewayConnected ? OpenClawBrand.ok : .secondary
        case .connecting:
            OpenClawBrand.accent
        case .error:
            OpenClawBrand.warn
        case .disconnected:
            .secondary
        }
    }

    nonisolated static func gatewayPillTitle(state: GatewayDisplayState, isGatewayUsable: Bool) -> String {
        switch state {
        case .connected:
            isGatewayUsable ? "Connected" : "Unavailable"
        case .connecting:
            "Connecting"
        case .error:
            "Attention"
        case .disconnected:
            "Offline"
        }
    }

    private var messagePlaceholder: String {
        self.gatewayConnected ? "Message \(self.agentDisplayName)..." : "Connect to a gateway"
    }

    private var headerDisplayTitle: String {
        self.normalized(self.headerTitle)
            ?? Self.defaultHeaderTitle(showsAgentBadge: self.showsAgentBadge, agentDisplayName: self.agentDisplayName)
    }

    nonisolated static func defaultHeaderTitle(showsAgentBadge: Bool, agentDisplayName: String) -> String {
        showsAgentBadge ? agentDisplayName : "Chat"
    }

    private var chatUserAccent: Color {
        OpenClawBrand.accent
    }

    private var activeAgent: AgentSummary? {
        self.appModel.gatewayAgents.first { $0.id == self.activeAgentID }
    }

    private var agentDisplayName: String {
        self.normalized(self.activeAgent?.name) ?? self.appModel.chatAgentName
    }

    private var agentBadge: String {
        if let identity = self.activeAgent?.identity,
           let emoji = identity["emoji"]?.value as? String,
           let normalizedEmoji = self.normalized(emoji)
        {
            return normalizedEmoji
        }
        let words = self.agentDisplayName
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
}
