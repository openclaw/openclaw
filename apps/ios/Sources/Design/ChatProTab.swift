import OpenClawChatUI
import OpenClawProtocol
import SwiftUI

struct ChatProTab: View {
    private struct TranscriptShareItem: Identifiable {
        let id = UUID()
        let fileURL: URL
    }

    @Environment(NodeAppModel.self) private var appModel
    @State private var viewModel: OpenClawChatViewModel?
    @State private var viewModelTransportModeID = ""
    @State private var transcriptShareItem: TranscriptShareItem?
    @State private var showsTranscriptExportError = false
    // Transport can start unscoped while the UI uses its "main" fallback.
    // Track the real agent separately so gateway metadata always rebuilds it.
    @State private var viewModelTransportAgentID = ""
    @State private var viewModelAgentID = ""
    let headerLeadingAction: OpenClawSidebarHeaderAction?
    let headerTitle: String?
    let showsAgentBadge: Bool
    let ownsNavigationStack: Bool
    let openSettings: (() -> Void)?

    init(
        headerLeadingAction: OpenClawSidebarHeaderAction? = nil,
        headerTitle: String? = nil,
        showsAgentBadge: Bool = true,
        ownsNavigationStack: Bool = true,
        openSettings: (() -> Void)? = nil)
    {
        self.headerLeadingAction = headerLeadingAction
        self.headerTitle = headerTitle
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
            } else {
                // Phone and iPad hosts already provide a NavigationStack. Keep
                // one native bar so embedded Chat never grows duplicate chrome.
                self.content
            }
        }
        .task {
            self.syncChatViewModel()
        }
        .onChange(of: self.appModel.chatSessionKey) { _, _ in
            self.syncChatViewModel()
        }
        .onChange(of: self.appModel.chatViewModelIdentityID) { _, _ in
            self.syncChatViewModel()
        }
        .onChange(of: self.appModel.chatAgentId) { _, _ in
            self.syncChatViewModel()
        }
        .onChange(of: self.appModel.gatewayDefaultAgentId) { _, _ in
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
                    self.chatActionsMenu
                }
                ToolbarItem(placement: .topBarTrailing) {
                    self.connectionStatusButton
                        .accessibilityIdentifier("chat-gateway-status")
                }
            }
            .sheet(item: self.$transcriptShareItem) { item in
                ChatTranscriptShareSheet(fileURL: item.fileURL)
            }
            .alert(
                String(localized: "Unable to Export Transcript"),
                isPresented: self.$showsTranscriptExportError)
            {
                Button(role: .cancel) {} label: {
                    Text("OK")
                        .font(OpenClawType.body)
                }
            } message: {
                Text("OpenClaw could not prepare the Markdown file.")
                    .font(OpenClawType.body)
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
                emptyAssistantIntro: String(localized: "What would you like to work on?"),
                emptyAssistantPrompts: Self.emptyAssistantPrompts,
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
            .font(OpenClawType.avatar(size: self.agentBadge.count > 2 ? 12 : 15))
            .foregroundStyle(.white)
            .minimumScaleFactor(0.6)
            .lineLimit(1)
            .frame(width: 30, height: 30)
            .background(Circle().fill(OpenClawBrand.accent))
            .accessibilityLabel(self.agentDisplayName)
    }

    private func syncChatViewModel() {
        let sessionKey = self.appModel.chatSessionKey
        // Includes the cache gateway identity so switching paired gateways
        // rebuilds the view model even while the transport mode stays the same.
        let transportModeID = self.appModel.chatViewModelIdentityID
        let transportAgentID = Self.transportAgentID(self.appModel.chatAgentId)
        let agentID = self.activeAgentID
        guard let viewModel else {
            self.viewModelTransportModeID = transportModeID
            self.viewModelTransportAgentID = transportAgentID
            self.viewModelAgentID = agentID
            self.viewModel = self.makeChatViewModel(sessionKey: sessionKey, activeAgentId: agentID)
            return
        }
        if self.viewModelTransportModeID != transportModeID ||
            self.viewModelTransportAgentID != transportAgentID ||
            self.viewModelAgentID != agentID
        {
            self.viewModelTransportModeID = transportModeID
            self.viewModelTransportAgentID = transportAgentID
            self.viewModelAgentID = agentID
            self.viewModel = self.makeChatViewModel(sessionKey: sessionKey, activeAgentId: agentID)
            return
        }
        guard viewModel.sessionKey != sessionKey else { return }
        viewModel.syncSession(to: sessionKey)
    }

    private func makeChatViewModel(sessionKey: String, activeAgentId: String? = nil) -> OpenClawChatViewModel {
        // One store instance backs both seams so the transcript cache and the
        // offline outbox share a single SQLite connection.
        let offlineStore = self.appModel.makeChatOfflineStore()
        return OpenClawChatViewModel(
            sessionKey: sessionKey,
            transport: self.appModel.makeChatTransport(),
            activeAgentId: activeAgentId,
            transcriptCache: offlineStore,
            outbox: offlineStore,
            onSessionChanged: { sessionKey in
                self.appModel.focusChatSession(sessionKey)
            },
            diagnosticsLog: { message in
                GatewayDiagnostics.log(message)
            })
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
            .accessibilityLabel(self.gatewayAccessibilityLabel)
            .accessibilityHint("Opens Settings / Gateway")
        } else {
            self.connectionPill
                .accessibilityLabel(self.gatewayAccessibilityLabel)
        }
    }

    private var connectionPill: some View {
        HStack(spacing: 5) {
            ProStatusDot(color: self.gatewayPillColor)
            Text(Self.gatewayPillTitle(state: self.gatewayDisplayState, isGatewayUsable: self.gatewayConnected))
                .font(OpenClawType.subheadMedium)
                .lineLimit(1)
        }
        .foregroundStyle(self.gatewayPillColor)
        // Even breathing room inside the system glass capsule.
        .padding(.horizontal, 6)
    }

    private var chatActionsMenu: some View {
        Menu {
            Button {
                Task { await self.viewModel?.startNewSession() }
            } label: {
                Label {
                    Text("New Chat")
                        .font(OpenClawType.body)
                } icon: {
                    Image(systemName: "plus.bubble")
                }
            }
            .disabled(self.viewModel == nil || !self.gatewayConnected)

            if self.activeAgent?.workspacegit == true {
                Button {
                    Task { await self.viewModel?.startNewSession(worktree: true) }
                } label: {
                    Label {
                        Text("New Chat in Worktree")
                            .font(OpenClawType.body)
                    } icon: {
                        Image(systemName: "arrow.triangle.branch")
                    }
                }
                .disabled(self.viewModel == nil || !self.gatewayConnected)
            }

            Divider()

            Button {
                self.exportTranscript()
            } label: {
                Label {
                    Text("Export Transcript")
                        .font(OpenClawType.body)
                } icon: {
                    Image(systemName: "square.and.arrow.up")
                }
            }
            .disabled(self.viewModel == nil)
        } label: {
            Image(systemName: "ellipsis.circle")
        }
        .accessibilityLabel("Chat actions")
    }

    private func exportTranscript() {
        guard let viewModel else { return }
        let title = viewModel.sessions.first { $0.key == viewModel.sessionKey }?.displayName
        let filename = ChatTranscriptExporter.filename(
            sessionTitle: title,
            sessionKey: viewModel.sessionKey)
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("OpenClawTranscripts", isDirectory: true)
        let fileURL = directory.appendingPathComponent(filename, isDirectory: false)

        do {
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            try viewModel.exportTranscriptMarkdown().write(to: fileURL, atomically: true, encoding: .utf8)
            self.transcriptShareItem = TranscriptShareItem(fileURL: fileURL)
        } catch {
            self.showsTranscriptExportError = true
        }
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
        if let identity = activeAgent?.identity,
           let emoji = identity["emoji"]?.value as? String,
           let normalizedEmoji = Self.normalizedBadgeEmoji(emoji)
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

    nonisolated static func normalizedBadgeEmoji(_ value: String?) -> String? {
        guard let value else { return nil }
        let normalized = value.trimmingCharacters(in: .whitespacesAndNewlines)
        return normalized.isEmpty || normalized == "?" ? nil : normalized
    }

    nonisolated static func transportAgentID(_ value: String?) -> String {
        value?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() ?? ""
    }

    nonisolated static let emptyAssistantPrompts: [OpenClawChatView.StarterPrompt] = [
        OpenClawChatView.StarterPrompt(
            id: "summarize-status",
            title: String(localized: "Check OpenClaw status"),
            prompt: String(localized: "Summarize the current OpenClaw status and tell me what needs attention.")),
        OpenClawChatView.StarterPrompt(
            id: "show-controls",
            title: String(localized: "What can I control here?"),
            prompt: String(localized: "Show me which phone controls and device capabilities are available right now.")),
        OpenClawChatView.StarterPrompt(
            id: "start-voice",
            title: String(localized: "Help me start voice chat"),
            prompt: String(localized: "Help me start a realtime voice session from this phone.")),
    ]

    private func normalized(_ value: String?) -> String? {
        guard let value else { return nil }
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }
}
