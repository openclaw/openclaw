import AVFAudio
import OpenClawChatUI
import OpenClawKit
import OpenClawProtocol
import SwiftUI

struct ChatProTab: View {
    enum GatewayStatusTone: Equatable {
        case success
        case warning
        case error
    }

    private struct TranscriptShareItem: Identifiable {
        let id = UUID()
        let fileURL: URL
    }

    private enum PendingChatAction {
        case exportTranscript
        case gatewaySettings
        case newSessionOptions
    }

    @Environment(NodeAppModel.self) private var appModel
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    @Environment(GatewayConnectionController.self) private var gatewayController
    @AppStorage("openclaw.webchat.showAssistantTrace")
    private var showsAssistantTrace = true
    private var chatTraceDisplayOptions: OpenClawChatDisplayOptions {
        guard self.showsAssistantTrace else { return [] }
        return self.viewModel?.currentSessionReasoningVisible == true ? .assistantTrace : .toolActivity
    }

    private var viewModel: OpenClawChatViewModel? {
        self.appModel.chatPresentation.viewModel
    }

    @State private var transcriptShareItem: TranscriptShareItem?
    @State private var showsTranscriptExportError = false
    @State private var showsNewSessionOptions = false
    @State private var showsChatActions = false
    @State private var pendingChatAction: PendingChatAction?
    @State private var speech: OpenClawChatSpeechController?
    @State private var isGatewayStatusManuallyExpanded = false
    let headerSidebarAction: OpenClawSidebarHeaderAction?
    let openSettings: () -> Void

    var body: some View {
        self.content
            .task {
                if self.speech == nil {
                    let gateway = self.appModel.operatorSession
                    self.speech = OpenClawChatSpeechController { text in
                        try await ChatMessageSpeechClient.synthesize(text: text, gateway: gateway)
                    }
                }
            }
    }

    private var isGatewayTransitionPending: Bool {
        self.appModel.isGatewayPickerRequestInFlight ||
            self.gatewayController.hasPendingConnectionHandoff ||
            // Route commitment precedes SwiftUI applying the new presentation.
            // A deliberately pinned attachment owner keeps its existing controls
            // so the user can remove/finish it rather than becoming stuck.
            (!self.isAttachmentOwnerPinned && self.appModel.chatPresentation.ownerID != self.appModel
                .chatViewModelOwnerID)
    }

    /// Session actions write through the chat owner, so they wait out a gateway handoff
    /// even though the toolbar that offers them stays enabled.
    private var areSessionActionsDisabled: Bool {
        self.viewModel == nil || !self.gatewayConnected || self.isAttachmentOwnerPinned ||
            self.isGatewayTransitionPending
    }

    private var content: some View {
        self.chatSurface
            // Protect the chat owner during a handoff, but keep the toolbar outside this
            // scope. Automatic reconnects keep the handoff pending while they retry an
            // unreachable gateway, and the toolbar is the way to reach Gateway settings.
                .disabled(self.isGatewayTransitionPending)
                // The shared canvas supplies color for the native blur. Automatic
                // edge effects harden to black when the host inserts an opaque fill.
                .scrollEdgeEffectStyle(.soft, for: .vertical)
                .navigationTitle("")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    if #available(iOS 27.1, *) {
                        // Custom controls must explicitly support the system's side bar.
                        self.chatToolbar.axisBehavior(.verticalPreferred)
                    } else {
                        self.chatToolbar
                    }
                }
                .sheet(item: self.$transcriptShareItem) { item in
                    OpenClawChatFileShareSheet(fileURL: item.fileURL)
                }
                .sheet(isPresented: self.$showsNewSessionOptions) {
                    if let viewModel {
                        ScrollView {
                            ChatNewSessionOptionsPopover(viewModel: viewModel) {
                                self.showsNewSessionOptions = false
                            }
                        }
                        .disabled(self.isGatewayTransitionPending)
                        .presentationDetents(self.dynamicTypeSize.isAccessibilitySize ? [.large] : [.medium, .large])
                        .presentationDragIndicator(.visible)
                    }
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

    @ToolbarContentBuilder
    private var chatToolbar: some ToolbarContent {
        if let headerSidebarAction {
            OpenClawSidebarToolbarItem(action: headerSidebarAction, placement: .topBarLeading)
        }
        ToolbarItem(placement: .topBarLeading) {
            self.headerAgentIdentity
        }
        .sharedBackgroundVisibility(.hidden)
        ToolbarItem(placement: .topBarTrailing) {
            self.chatActionsMenu
        }
        .sharedBackgroundVisibility(.hidden)
    }

    @ViewBuilder
    private var chatSurface: some View {
        if let viewModel {
            let owner = self.appModel.chatPresentation
            let presentationID = owner.presentationID
            OpenClawChatView(
                viewModel: viewModel,
                resolveComposerModel: owner.composerModelResolver(),
                drawsBackground: true,
                showsSessionSwitcher: false,
                userAccent: self.chatUserAccent,
                displayOptions: self.chatTraceDisplayOptions,
                assistantName: self.agentDisplayName,
                assistantAvatarText: self.agentBadge,
                assistantAvatarTint: OpenClawBrand.accent,
                // Narrow layouts drop the avatar column, as the web chat does at phone widths.
                showsAssistantAvatars: self.horizontalSizeClass != .compact,
                composerChrome: .clean,
                isComposerEnabled: self.gatewayConnected || self.canQueueOffline,
                isAttachmentInputEnabled: self.gatewayConnected || self.canQueueOffline,
                messagePlaceholder: self.messagePlaceholder,
                emptyAssistantIntro: String(localized: "What would you like to work on?"),
                emptyAssistantPrompts: Self.emptyAssistantPrompts,
                talkControl: Self.shouldExposeCaptureControl(
                    isAttachmentOwnerPinned: viewModel.isAttachmentOwnerPinned,
                    isCaptureInFlight: self.appModel.talkMode.isEnabled)
                    ? Self.talkControl(appModel: self.appModel)
                    : nil,
                dictationControl: Self.shouldExposeCaptureControl(
                    isAttachmentOwnerPinned: viewModel.isAttachmentOwnerPinned,
                    isCaptureInFlight: self.appModel.isChatDictationPending || self.appModel.isChatDictationActive)
                    ? Self.dictationControl(appModel: self.appModel)
                    : nil,
                voiceNoteControl: self.voiceNoteControl,
                speech: self.speech,
                mediaPlaybackAllowed: {
                    !self.appModel.talkMode.isEnabled &&
                        !self.appModel.talkMode.hasActivePushToTalkSession &&
                        !self.appModel.voiceNoteRecorder.ownsPendingChatAttachment
                })
                // iMessage-style grey bubbles for agent replies in the clean chrome.
                .environment(\.openClawAssistantBubblesInCleanChrome, true)
                .environment(
                    \.openClawEmbeddedBrowserUnavailableReason,
                    self.appModel.activeGatewayConnectConfig?.ingressAuthorization == nil ? nil :
                        "This widget needs browser access. Use native chat or open Gateway settings.")
                .id(presentationID)
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        } else {
            ContentUnavailableView(
                "Preparing Chat",
                systemImage: "bubble.left.and.bubble.right",
                description: Text("The session attaches once the gateway is ready.")
                    .font(OpenClawType.body))
        }
    }

    /// Voice activity owns the contour while gateway state stays a compact,
    /// stable dot on the avatar instead of competing with it in the toolbar.
    private var headerIdentityBadge: some View {
        ChatVoiceAvatar(talkMode: self.appModel.talkMode) {
            Group {
                if let image = self.agentAvatarImage {
                    Image(uiImage: image).resizable().scaledToFill()
                } else {
                    Text(self.agentBadge)
                        .font(OpenClawType.avatar(size: self.agentBadge.count > 2 ? 12 : 16))
                        .foregroundStyle(.white)
                        .minimumScaleFactor(0.6)
                        .lineLimit(1)
                }
            }
            .frame(width: 28, height: 28)
            .background(Circle().fill(OpenClawBrand.carapaceElevated))
            .clipShape(Circle())
        }
        .overlay(alignment: .topTrailing) {
            self.gatewayAvatarStatusDot
        }
        .accessibilityElement(children: .ignore)
        .openClawToolbarGlyphScale()
    }

    private var gatewayAvatarStatusDot: some View {
        ZStack {
            Circle()
                .fill(Color(uiColor: .systemBackground))
            Circle()
                .fill(self.gatewayStatusColor)
                .padding(2)
        }
        .frame(width: 13, height: 13)
        .accessibilityHidden(true)
    }

    @ViewBuilder
    private var headerAgentIdentity: some View {
        if #available(iOS 27.1, *) {
            self.headerAgentIdentityButton.modifier(ChatToolbarStatusPopover(
                isExpanded: self.$isGatewayStatusManuallyExpanded,
                status: self.expandedGatewayStatusLabel))
        } else {
            self.headerAgentIdentityButton
        }
    }

    private var headerAgentIdentityButton: some View {
        Button(action: self.handleHeaderAgentIdentityTap) {
            self.headerAgentIdentityLabel
        }
        .openClawToolbarHitTarget(preservesIntrinsicWidth: true)
        .contentShape(Rectangle())
        .buttonStyle(.plain)
        .accessibilityLabel(Text(verbatim: self.headerAgentAccessibilityLabel))
        .accessibilityValue(self.showsExpandedGatewayStatus ? "Expanded" : "Collapsed")
        .accessibilityHint(self.gatewayStatusAccessibilityHint)
        .accessibilityIdentifier("chat-agent-identity")
        .animation(.snappy(duration: 0.24), value: self.showsExpandedGatewayStatus)
    }

    private var headerAgentIdentityLabel: some View {
        Label {
            VStack(alignment: .leading, spacing: 2) {
                if self.showsExpandedGatewayStatus {
                    self.expandedGatewayStatusLabel
                        .transition(.opacity.combined(with: .move(edge: .leading)))
                } else {
                    Text(self.agentDisplayName)
                        .font(OpenClawType.headline)
                        .lineLimit(1)
                        .transition(.opacity)
                }
                if let session = self.coloredHeaderSession {
                    self.headerSessionTitle(session)
                }
            }
        } icon: {
            self.headerIdentityBadge
        }
    }

    private var coloredHeaderSession: OpenClawChatSessionEntry? {
        guard let session = viewModel?.currentSessionEntry(),
              OpenClawSessionColor(name: session.color) != nil
        else { return nil }
        return session
    }

    private func headerSessionTitle(_ session: OpenClawChatSessionEntry) -> some View {
        HStack(spacing: 5) {
            OpenClawSessionColorDot(color: session.color)
            Text(verbatim: CommandCenterTab.sessionTitle(session))
                .font(OpenClawType.captionMedium)
                .lineLimit(1)
        }
    }

    private var gatewayStatusIsHealthy: Bool {
        Self.gatewayStatusTone(
            state: self.gatewayDisplayState,
            isGatewayUsable: self.gatewayConnected) == .success
    }

    private var headerAgentAccessibilityLabel: String {
        let identity = "\(voiceAvatarAccessibilityLabel). \(gatewayAccessibilityLabel)"
        guard let session = coloredHeaderSession else { return identity }
        return "\(identity). \(CommandCenterTab.sessionTitle(session))"
    }

    private func handleHeaderAgentIdentityTap() {
        if self.gatewayStatusIsHealthy {
            withAnimation(.snappy(duration: 0.24)) {
                self.isGatewayStatusManuallyExpanded.toggle()
            }
        } else {
            self.openSettings()
        }
    }

    private var expandedGatewayStatusLabel: some View {
        Text(Self.gatewayStatusTitle(state: self.gatewayDisplayState, isGatewayUsable: self.gatewayConnected))
            .font(OpenClawType.subheadMedium)
            .foregroundStyle(.primary)
            .lineLimit(1)
            .fixedSize(horizontal: true, vertical: false)
            .padding(.horizontal, 9)
            .padding(.vertical, 5)
            .background(self.gatewayStatusColor.opacity(0.12), in: Capsule())
            .overlay {
                Capsule()
                    .stroke(self.gatewayStatusColor.opacity(0.28), lineWidth: 1)
            }
    }

    private var showsExpandedGatewayStatus: Bool {
        Self.gatewayStatusShouldExpand(
            state: self.gatewayDisplayState,
            isGatewayUsable: self.gatewayConnected,
            isManuallyExpanded: self.isGatewayStatusManuallyExpanded)
    }

    private var gatewayStatusAccessibilityHint: String {
        if !self.gatewayStatusIsHealthy {
            return String(localized: "Opens Settings / Gateway")
        }
        return self.isGatewayStatusManuallyExpanded
            ? String(localized: "Hides the gateway status label")
            : String(localized: "Shows the full gateway status label")
    }

    private var voiceAvatarAccessibilityLabel: String {
        let state = self.appModel.talkMode.isEnabled
            ? self.appModel.talkMode.statusText
            : String(localized: "Voice off")
        return "\(self.agentDisplayName), \(state)"
    }

    static func talkControl(appModel: NodeAppModel) -> OpenClawChatTalkControl {
        OpenClawChatTalkControl(
            isEnabled: appModel.talkMode.isEnabled,
            isListening: appModel.talkMode.isListening,
            isSpeaking: appModel.talkMode.isSpeaking,
            isGatewayConnected: appModel.talkMode.isGatewayConnected,
            statusText: appModel.talkMode.statusText,
            providerLabel: appModel.talkMode.gatewayTalkProviderLabel,
            levelProvider: {
                if appModel.talkMode.isSpeaking {
                    return appModel.talkMode.playbackLevel ?? 0
                }
                if appModel.talkMode.isListening {
                    return appModel.talkMode.micLevel
                }
                return 0
            },
            isMicrophoneMuted: appModel.talkMode.isMicrophoneMuted,
            toggleMicrophone: {
                Task {
                    await appModel.talkMode.setMicrophoneMuted(!appModel.talkMode.isMicrophoneMuted)
                }
            },
            inputDevices: self.talkInputDevices,
            selectedInputDeviceID: self.selectedTalkInputDeviceID(appModel: appModel),
            selectInputDevice: { deviceID in
                appModel.talkMode.selectInputDevice(deviceID)
            },
            cameraFacing: appModel.preferredCameraFacing == .front ? .front : .back,
            flipCamera: {
                appModel.flipPreferredCameraFacing()
            },
            toggle: { sessionKey in
                appModel.focusChatSession(sessionKey)
                appModel.setTalkEnabled(!appModel.talkMode.isEnabled)
            })
    }

    private static var talkInputDevices: [OpenClawChatAudioInputDevice] {
        (AVAudioSession.sharedInstance().availableInputs ?? []).map { input in
            OpenClawChatAudioInputDevice(id: input.uid, name: input.portName)
        }
    }

    private static func selectedTalkInputDeviceID(appModel: NodeAppModel) -> String? {
        guard let preferredID = appModel.talkMode.preferredInputDeviceID,
              self.talkInputDevices.contains(where: { $0.id == preferredID })
        else { return nil }
        return preferredID
    }

    static func dictationControl(appModel: NodeAppModel) -> OpenClawChatDictationControl {
        OpenClawChatDictationControl(
            phase: appModel.chatDictationPhase,
            isAvailable: !appModel.isTalkCaptureActive || appModel.chatDictationPhase != .idle,
            partialTranscript: appModel.chatDictationPartialTranscript,
            level: 0,
            levelProvider: { appModel.chatDictationLevel },
            start: {
                try await appModel.transcribeChatDraft()
            },
            finish: {
                appModel.finishChatDictation()
            },
            cancel: {
                appModel.cancelChatDictation()
            })
    }

    private var voiceNoteControl: OpenClawChatVoiceNoteControl {
        OpenClawChatVoiceNoteControl(
            recorder: self.appModel.voiceNoteRecorder,
            isTalkActive: self.appModel.isTalkCaptureActive)
    }

    private var chatActionsMenu: some View {
        Button {
            self.showsChatActions.toggle()
        } label: {
            Label {
                Text("Chat actions")
                    .font(OpenClawType.body)
            } icon: {
                Image(systemName: "ellipsis.circle")
                    .font(.system(size: 22))
                    .openClawToolbarGlyphScale()
            }
            .foregroundStyle(OpenClawBrand.accent)
        }
        .openClawToolbarHitTarget()
        .contentShape(Rectangle())
        .buttonStyle(.plain)
        .accessibilityLabel("Chat actions")
        .popover(isPresented: self.$showsChatActions) {
            self.chatActionsPopover
                .onDisappear {
                    self.performPendingChatAction()
                }
                .presentationCompactAdaptation(.popover)
        }
    }

    private var chatActionsPopover: some View {
        ScrollView {
            VStack(spacing: 0) {
                if self.activeAgent?.workspacegit == true {
                    self.chatActionButton(
                        title: String(localized: "New chat in worktree"),
                        systemImage: "arrow.triangle.branch",
                        disabled: self.areSessionActionsDisabled)
                    {
                        Task { await self.viewModel?.startNewSession(worktree: true) }
                    }
                }

                self.chatActionButton(
                    title: String(localized: "New session options…"),
                    systemImage: "slider.horizontal.3",
                    disabled: self.areSessionActionsDisabled)
                {
                    self.pendingChatAction = .newSessionOptions
                }
                if let viewModel {
                    ChatModelControlsMenuItems(
                        viewModel: viewModel,
                        agentModelReference: self.activeAgentModelReference)
                    {
                        self.showsChatActions = false
                    }
                    .disabled(self.isGatewayTransitionPending)
                }

                Button {
                    self.showsAssistantTrace.toggle()
                } label: {
                    ChatActionSystemRow(
                        title: String(localized: "Show reasoning & tool activity"),
                        systemImage: "brain.head.profile",
                        isSelected: self.showsAssistantTrace)
                }
                .buttonStyle(.plain)
                .accessibilityAddTraits(self.showsAssistantTrace ? .isSelected : [])
                .accessibilityIdentifier("chat-show-reasoning-toggle")

                self.chatActionButton(
                    title: String(localized: "Export transcript"),
                    systemImage: "square.and.arrow.up",
                    disabled: self.viewModel == nil)
                {
                    self.pendingChatAction = .exportTranscript
                }

                self.chatActionButton(title: String(localized: "Gateway settings"), systemImage: "network") {
                    self.pendingChatAction = .gatewaySettings
                }
                .accessibilityIdentifier("chat-gateway-settings")
            }
            .padding(.vertical, 8)
        }
        .frame(width: 286, height: 560)
        .accessibilityIdentifier("chat-actions-popover")
    }

    private func chatActionButton(
        title: String,
        systemImage: String,
        disabled: Bool = false,
        action: @escaping @MainActor () -> Void) -> some View
    {
        Button {
            action()
            self.showsChatActions = false
        } label: {
            ChatActionSystemRow(title: title, systemImage: systemImage)
        }
        .buttonStyle(.plain)
        .disabled(disabled)
    }

    private func performPendingChatAction() {
        guard let pendingChatAction else { return }
        self.pendingChatAction = nil
        switch pendingChatAction {
        case .exportTranscript:
            self.exportTranscript()
        case .gatewaySettings:
            self.openSettings()
        case .newSessionOptions:
            self.showsNewSessionOptions = true
        }
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

    /// Chat follows the operator session; buildChat reports connected only when it can serve chat.
    private var gatewayConnected: Bool {
        self.gatewayDisplayState == .connected
    }

    private var gatewayDisplayState: GatewayDisplayState {
        Self.presentationGatewayState(
            current: GatewayStatusBuilder.buildChat(appModel: self.appModel),
            isAttachmentOwnerPinned: self.isAttachmentOwnerPinned,
            capturedOwnerID: self.appModel.chatPresentation.ownerID,
            currentOwnerID: self.appModel.chatViewModelOwnerID)
    }

    nonisolated static func presentationGatewayState(
        current: GatewayDisplayState,
        isAttachmentOwnerPinned: Bool,
        capturedOwnerID: String,
        currentOwnerID: String) -> GatewayDisplayState
    {
        if isAttachmentOwnerPinned, capturedOwnerID != currentOwnerID {
            return .disconnected
        }
        return current
    }

    /// Attachment pinning blocks new capture, but starting or active capture must keep its stop control.
    nonisolated static func shouldExposeCaptureControl(
        isAttachmentOwnerPinned: Bool,
        isCaptureInFlight: Bool) -> Bool
    {
        !isAttachmentOwnerPinned || isCaptureInFlight
    }

    private var gatewayAccessibilityLabel: String {
        "Gateway: \(Self.gatewayStatusTitle(state: self.gatewayDisplayState, isGatewayUsable: self.gatewayConnected))"
    }

    private var gatewayStatusColor: Color {
        switch Self.gatewayStatusTone(
            state: self.gatewayDisplayState,
            isGatewayUsable: self.gatewayConnected)
        {
        case .success:
            OpenClawBrand.statusSuccess
        case .warning:
            OpenClawBrand.statusWarning
        case .error:
            OpenClawBrand.statusError
        }
    }

    nonisolated static func gatewayStatusTone(
        state: GatewayDisplayState,
        isGatewayUsable: Bool) -> GatewayStatusTone
    {
        switch state {
        case .connected:
            isGatewayUsable ? .success : .warning
        case .connecting, .error:
            .warning
        case .disconnected:
            .error
        }
    }

    nonisolated static func gatewayStatusShouldExpand(
        state: GatewayDisplayState,
        isGatewayUsable: Bool,
        isManuallyExpanded: Bool) -> Bool
    {
        isManuallyExpanded || self.gatewayStatusTone(
            state: state,
            isGatewayUsable: isGatewayUsable) != .success
    }

    nonisolated static func gatewayStatusTitle(state: GatewayDisplayState, isGatewayUsable: Bool) -> String {
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
        if self.gatewayConnected {
            return String(
                format: String(localized: "Message %@..."),
                self.agentDisplayName)
        }
        if self.canQueueOffline {
            return String(
                format: String(localized: "Message %@; sends when connected"),
                self.agentDisplayName)
        }
        return String(localized: "Connect to a gateway")
    }

    private var canQueueOffline: Bool {
        self.viewModel?.supportsOfflineTextOutbox == true &&
            (self.isAttachmentOwnerPinned
                ? self.appModel.chatPresentation.hasVerifiedOfflineRoutingIdentity
                : self.appModel.hasVerifiedChatOfflineRoutingIdentity)
    }

    private var chatUserAccent: Color {
        ColorHexSupport.color(fromHex: self.appModel.gatewayAccentColorHex) ?? OpenClawBrand.accent
    }

    private var isAttachmentOwnerPinned: Bool {
        self.viewModel?.isAttachmentOwnerPinned == true
    }

    private var currentAgentID: String {
        self.appModel.chatAgentId.trimmedNonEmpty ?? "main"
    }

    private var currentActiveAgent: AgentSummary? {
        self.appModel.gatewayAgents.first { $0.id == self.currentAgentID }
    }

    private var activeAgentID: String {
        self.isAttachmentOwnerPinned ? self.appModel.chatPresentation.presentationAgentID : self.currentAgentID
    }

    private var activeAgent: AgentSummary? {
        self.appModel.gatewayAgents.first { $0.id == self.activeAgentID }
    }

    private var activeAgentModelReference: String? {
        guard let activeAgent else { return nil }
        let modelID = RootSidebar.agentModelLabel(activeAgent)
        let providerID = activeAgent.model?["provider"]?.value as? String
        return ChatModelMenuPresentation.qualifiedModelReference(modelID: modelID, providerID: providerID)
    }

    private var currentAgentDisplayName: String {
        self.currentActiveAgent?.name?.trimmedNonEmpty ?? self.appModel.chatAgentName
    }

    private var agentDisplayName: String {
        self.isAttachmentOwnerPinned ? self.appModel.chatPresentation.presentationAgentName : self
            .currentAgentDisplayName
    }

    private var currentAgentBadge: String {
        AgentIdentityPresentation.badge(
            avatarText: self.currentActiveAgent?.identity?["emoji"]?.value as? String,
            displayName: self.currentAgentDisplayName)
    }

    private var agentBadge: String {
        self.isAttachmentOwnerPinned ? self.appModel.chatPresentation.presentationAgentBadge : self.currentAgentBadge
    }

    private var agentAvatarImage: UIImage? {
        self.isAttachmentOwnerPinned
            ? self.appModel.chatPresentation.presentationAgentAvatar
            : self.appModel.agentAvatarImage(for: self.currentActiveAgent?.id ?? self.appModel.chatAgentId)
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
}

/// Keep live metering inside the avatar rather than observing it while building the chat surface.
struct ChatVoiceAvatar<Avatar: View>: View {
    let talkMode: TalkModeManager
    private let avatar: Avatar

    init(talkMode: TalkModeManager, @ViewBuilder avatar: () -> Avatar) {
        self.talkMode = talkMode
        self.avatar = avatar()
    }

    var body: TalkAvatarWaveformView<Avatar> {
        TalkAvatarWaveformView(
            phase: self.phase,
            palette: .openClawBrand,
            diameter: 38,
            avatarDiameter: 28)
        {
            self.avatar
        }
    }

    private var phase: TalkWaveformPhase {
        guard self.talkMode.isEnabled else { return .idle }
        if self.talkMode.isSpeaking {
            return .speaking(level: self.talkMode.playbackLevel)
        }
        if self.talkMode.isListening {
            return .listening(
                level: self.talkMode.micLevel,
                speechActive: self.talkMode.isUserSpeechDetected)
        }
        return .idle
    }
}

@available(iOS 27.1, *)
private struct ChatToolbarStatusPopover<Status: View>: ViewModifier {
    @Environment(\.toolbarVerticalEdge) private var verticalEdge
    @Binding var isExpanded: Bool
    let status: Status

    func body(content: Content) -> some View {
        content.popover(isPresented: self.isPresented) {
            self.status
                .padding(16)
                .accessibilityIdentifier("chat-gateway-status-details")
                .presentationCompactAdaptation(.popover)
        }
    }

    private var isPresented: Binding<Bool> {
        Binding(
            get: { self.verticalEdge != nil && self.isExpanded },
            set: { self.isExpanded = $0 })
    }
}
