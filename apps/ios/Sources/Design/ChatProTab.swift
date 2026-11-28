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

    @Environment(NodeAppModel.self) private var appModel
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    @Environment(\.verticalSizeClass) private var verticalSizeClass
    @Environment(GatewayConnectionController.self) private var gatewayController
    @AppStorage(ChatPreferences.wrapCodeLinesKey) private var wrapsCodeLines = false
    @AppStorage(ChatPreferences.followUpModeKey) private var followUpMode = ""
    @AppStorage(ChatPreferences.showAssistantTraceKey)
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
    @State private var compactToolbarInset: CGFloat = 0
    @State private var showsNewSessionOptions = false
    @State private var speech: OpenClawChatSpeechController?
    @State private var isGatewayStatusManuallyExpanded = false
    let headerSidebarAction: OpenClawSidebarHeaderAction?
    /// Set only while no Gateway has ever been saved or connected on this device.
    let startFirstGatewaySetup: (() -> Void)?

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

    private var usesSideToolbar: Bool {
        if #available(iOS 27.1, *) {
            return self.verticalSizeClass == .compact && UIDevice.current.userInterfaceIdiom == .phone
        }
        return false
    }

    private var content: some View {
        self.chatSurface
            .ignoresSafeArea(.container, edges: self.usesSideToolbar ? .top : [])
            // In landscape the keyboard can leave less than the bars' minimum height. Anchor the overflow above it.
            .frame(
                minHeight: self.usesSideToolbar ? 0 : nil,
                maxHeight: self.usesSideToolbar ? .infinity : nil,
                alignment: .bottom)
            // The compact toolbar stays native; reserve its actual inset at the start of the transcript.
            .onGeometryChange(for: CGFloat.self) { geometry in
                self.usesSideToolbar ? max(0, geometry.frame(in: .global).minY) : 0
            } action: { self.compactToolbarInset = $0 }
            .scrollEdgeEffectStyle(.soft, for: .vertical)
            .navigationTitle("")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar(self.usesSideToolbar ? .visible : .hidden, for: .navigationBar)
            .toolbar {
                if #available(iOS 27.1, *), self.usesSideToolbar {
                    self.chatToolbar
                }
            }
            .environment(\.openClawChatUsesFloatingComposer, true)
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
    }

    private var chatHeader: some View {
        GlassEffectContainer(spacing: 8) {
            HStack(alignment: self.isMainChat ? .top : .center, spacing: 8) {
                if let headerSidebarAction {
                    OpenClawSidebarControlButton(action: headerSidebarAction)
                } else if self.isMainChat {
                    Color.clear
                        .frame(
                            width: OpenClawProMetric.compactControlSize,
                            height: OpenClawProMetric.compactControlSize)
                        .accessibilityHidden(true)
                }
                self.headerAgentIdentity
                    .frame(maxWidth: .infinity, alignment: self.isMainChat ? .center : .leading)
                self.chatActionsMenu
            }
            .padding(.horizontal, OpenClawProMetric.pagePadding)
            .padding(.vertical, 4)
        }
    }

    @available(iOS 27.1, *)
    @ToolbarContentBuilder
    private var chatToolbar: some ToolbarContent {
        if let headerSidebarAction {
            OpenClawSidebarToolbarItem(
                action: headerSidebarAction,
                placement: .topBarLeading)
        }
        ToolbarItem(placement: .principal) {
            self.headerAgentIdentity
        }
        .axisBehavior(.horizontalOnly)
        .sharedBackgroundVisibility(.hidden)
        ToolbarItem(placement: .topBarTrailing) {
            self.chatActionsMenu
        }
        .axisBehavior(.verticalPreferred)
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
                showsEmptyStateNotice: false,
                showsTurnRecap: false,
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
                },
                firstConnectionNotice: self.startFirstGatewaySetup.map { start in
                    OpenClawChatFirstConnectionNotice(
                        title: String(localized: "Not connected yet"),
                        message: UIDevice.current.userInterfaceIdiom == .pad
                            ? String(localized: "Connect this iPad to OpenClaw on your computer.")
                            : String(localized: "Connect this iPhone to OpenClaw on your computer."),
                        actionTitle: String(localized: "Connect"),
                        action: start)
                })
                .environment(
                    \.openClawEmbeddedBrowserUnavailableReason,
                    self.appModel.activeGatewayConnectConfig?.ingressAuthorization == nil ? nil :
                        "This widget needs browser access. Use native chat or open Gateway settings.")
                .environment(
                    \.openClawChatDraftIdentity,
                    viewModel.isNewChatDraft ? AnyView(self.newChatIdentity(viewModel: viewModel)) : nil)
                .environment(
                    \.openClawChatFloatingHeader,
                    self.usesSideToolbar
                        ? AnyView(Color.clear.frame(height: self.compactToolbarInset).allowsHitTesting(false))
                        : AnyView(self.chatHeader))
                .environment(\.openClawChatShowsDisconnectNotice, self.startFirstGatewaySetup != nil)
                .environment(
                    \.openClawChatNewSessionOptionsPresented,
                    self.areSessionActionsDisabled ? nil : self.$showsNewSessionOptions)
                // A pending connection disables the transcript and composer, while the sidebar
                // stays usable so the person can get to Gateway settings.
                .environment(\.openClawChatInteractionsDisabled, self.isGatewayTransitionPending)
                .environment(\.openClawChatWrapCodeLines, self.wrapsCodeLines)
                .onChange(of: self.followUpMode, initial: true) { _, mode in
                    viewModel.defaultFollowUpMode = OpenClawChatQueueMode(rawValue: mode)
                }
                .openClawChatComposerPanels(viewModel: viewModel)
                .id(presentationID)
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        } else {
            OpenClawProBackground()
                .safeAreaBar(edge: .top, spacing: 0) {
                    if !self.usesSideToolbar { self.chatHeader }
                }
        }
    }

    fileprivate static let headerAvatarSize: CGFloat = 38

    private func headerIdentityBadge(size: CGFloat = ChatProTab.headerAvatarSize) -> some View {
        let image = self.agentAvatarImage
        let showsInitials = self.viewModel != nil &&
            (self.isAttachmentOwnerPinned || self.appModel.knowsAgentAvatar(for: self.currentAgentID))
        return ChatVoiceAvatar(talkMode: self.appModel.talkMode, avatarSize: size) {
            Group {
                if let image {
                    Image(uiImage: image).resizable().scaledToFill()
                } else if showsInitials {
                    Text(self.agentBadge)
                        .font(OpenClawType.avatar(size: self.agentBadge.count > 2 ? 12 : 16))
                        .foregroundStyle(.white)
                        .minimumScaleFactor(0.6)
                        .lineLimit(1)
                } else {
                    Color.clear
                }
            }
            .frame(width: size, height: size)
            .background {
                if image == nil, showsInitials {
                    Circle().fill(OpenClawBrand.carapaceElevated)
                }
            }
            .clipShape(Circle())
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

    private var isMainChat: Bool {
        self.viewModel?.currentSessionEntry()?.isMain == true ||
            OpenClawChatSessionKey.matchesIncludingDefaultMainAlias(
                self.viewModel?.sessionKey ?? self.appModel.chatSessionKey,
                self.appModel.mainSessionKey)
    }

    @ViewBuilder
    private func newChatIdentity(viewModel: OpenClawChatViewModel) -> some View {
        let agents = self.appModel.displayAgents
        let selectedAgent = agents.first { $0.id == self.currentAgentID }
        VStack(spacing: 10) {
            self.headerIdentityBadge(size: 80)
                .allowsHitTesting(false)
            if agents.count > 1 {
                Menu {
                    Picker(selection: Binding(
                        get: { self.currentAgentID },
                        set: { agentID in
                            guard agentID != self.currentAgentID else { return }
                            viewModel.startNewChatDraft(agentID: agentID)
                        })) {
                            ForEach(agents, id: \.id) { agent in
                                Text(verbatim: AgentIdentityPresentation.displayName(for: agent))
                                    .font(OpenClawType.body)
                                    .tag(agent.id)
                            }
                        } label: {
                            Text("Agent").font(OpenClawType.body)
                        }
                        .pickerStyle(.inline)
                } label: {
                    HStack(spacing: 6) {
                        Text(verbatim: selectedAgent.map(AgentIdentityPresentation.displayName(for:))
                            ?? self.agentDisplayName)
                            .font(OpenClawType.title3SemiBold)
                        Image(systemName: "chevron.down")
                            .font(.system(size: 10, weight: .semibold))
                    }
                    .foregroundStyle(.primary)
                    .frame(minHeight: 44)
                }
                .accessibilityIdentifier("chat-draft-agent-picker")
            } else {
                Text(verbatim: self.agentDisplayName)
                    .font(OpenClawType.title3SemiBold)
                    .allowsHitTesting(false)
            }
        }
        .padding(.horizontal, OpenClawProMetric.pagePadding)
    }

    private var mainChatIdentity: some View {
        let avatarSize: CGFloat = 50
        let dockOverlap: CGFloat = 5
        return Text(verbatim: self.agentDisplayName)
            .font(OpenClawType.subheadSemiBold)
            .lineLimit(1)
            .padding(.horizontal, 12)
            .padding(.vertical, 4)
            .glassEffect(.regular, in: ChatAgentNameCapsule(avatarSize: avatarSize, overlap: dockOverlap))
            .padding(.top, avatarSize + 2 - dockOverlap)
            .overlay(alignment: .top) {
                self.headerIdentityBadge(size: avatarSize)
            }
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(Text(verbatim: self.headerAgentAccessibilityLabel))
            .accessibilityIdentifier("chat-agent-identity")
    }

    @ViewBuilder
    private var headerAgentIdentity: some View {
        if self.viewModel?.isNewChatDraft == true {
            Color.clear.frame(width: 0, height: 0).accessibilityHidden(true)
        } else if self.isMainChat, !self.usesSideToolbar {
            self.mainChatIdentity
        } else {
            self.headerAgentIdentityLabel
                .accessibilityElement(children: .ignore)
                .accessibilityLabel(Text(verbatim: self.headerAgentAccessibilityLabel))
                .accessibilityIdentifier("chat-agent-identity")
        }
    }

    private var headerAgentIdentityLabel: some View {
        HStack(spacing: 4) {
            self.headerIdentityBadge()
            VStack(alignment: .leading, spacing: 0) {
                Text(verbatim: self.headerSessionTitle ?? self.agentDisplayName)
                    .font(OpenClawType.subheadSemiBold)
                    .lineLimit(self.usesSideToolbar || self.headerProjectName != nil ? 1 : 2)
                if let project = self.headerProjectName {
                    Text(verbatim: project)
                        .font(OpenClawType.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
            }
            .multilineTextAlignment(.leading)
        }
        .frame(maxWidth: self.usesSideToolbar ? nil : .infinity, alignment: .leading)
    }

    private var gatewayStatusIsHealthy: Bool {
        Self.gatewayStatusTone(state: self.gatewayDisplayState) == .success
    }

    private var expandedGatewayStatusLabel: some View {
        Text(Self.gatewayStatusTitle(state: self.gatewayDisplayState))
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

    private var headerNonMainSession: OpenClawChatSessionEntry? {
        guard let viewModel, let session = viewModel.currentSessionEntry(),
              session.isMain != true,
              !OpenClawChatSessionKey.matchesIncludingDefaultMainAlias(
                  viewModel.sessionKey,
                  self.appModel.mainSessionKey)
        else { return nil }
        return session
    }

    private var showsExpandedGatewayStatus: Bool {
        Self.gatewayStatusShouldExpand(
            state: self.gatewayDisplayState,
            isManuallyExpanded: self.isGatewayStatusManuallyExpanded)
    }

    /// Use the same title as the sidebar and keep opaque routing keys out of the header.
    private var headerSessionTitle: String? {
        guard let session = headerNonMainSession else { return nil }
        return SessionPresentation.title(session, includesRoutingFallback: false)
    }

    private var gatewayStatusAccessibilityHint: String {
        if !self.gatewayStatusIsHealthy {
            return String(localized: "Opens Settings / Gateway")
        }
        return self.isGatewayStatusManuallyExpanded
            ? String(localized: "Hides the gateway status label")
            : String(localized: "Shows the full gateway status label")
    }

    private var headerProjectName: String? {
        self.headerNonMainSession.flatMap { ChatSessionSidebarModel.projectName(for: $0) }
    }

    private var headerAgentAccessibilityLabel: String {
        let identity = self.voiceAvatarAccessibilityLabel
        guard let title = headerSessionTitle else { return identity }
        return [identity, title, self.headerProjectName].compactMap(\.self).joined(separator: ". ")
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
        ChatActionsMenu(
            viewModel: self.viewModel,
            isMainChat: self.isMainChat,
            isDisabled: self.areSessionActionsDisabled,
            newChat: {
                guard !self.areSessionActionsDisabled else { return }
                self.appModel.requestNewChat()
            })
    }

    private func exportTranscript() {
        guard let viewModel else { return }
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("OpenClawTranscripts", isDirectory: true)
        do {
            let fileURL = try Self.writeTranscript(for: viewModel, in: directory)
            self.transcriptShareItem = TranscriptShareItem(fileURL: fileURL)
        } catch {
            self.showsTranscriptExportError = true
        }
    }

    static func writeTranscript(for viewModel: OpenClawChatViewModel, in directory: URL) throws -> URL {
        let title = viewModel.currentSessionEntry()?.displayName
        let key = viewModel.sessionKey
        let filename = ChatTranscriptExporter.filename(sessionTitle: title, sessionKey: key)
        let markdown = ChatTranscriptExporter.markdown(
            sessionTitle: title,
            sessionKey: key,
            messages: viewModel.messages)
        let fileURL = directory.appendingPathComponent(filename, isDirectory: false)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        try markdown.write(to: fileURL, atomically: true, encoding: .utf8)
        return fileURL
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
        "Gateway: \(Self.gatewayStatusTitle(state: self.gatewayDisplayState))"
    }

    private var gatewayStatusColor: Color {
        switch Self.gatewayStatusTone(state: self.gatewayDisplayState) {
        case .success:
            OpenClawBrand.statusSuccess
        case .warning:
            OpenClawBrand.statusWarning
        case .error:
            OpenClawBrand.statusError
        }
    }

    nonisolated static func gatewayStatusTone(state: GatewayDisplayState) -> GatewayStatusTone {
        switch state {
        case .connected:
            .success
        case .connecting, .error:
            .warning
        case .disconnected:
            .error
        }
    }

    nonisolated static func gatewayStatusShouldExpand(
        state: GatewayDisplayState,
        isManuallyExpanded: Bool) -> Bool
    {
        isManuallyExpanded || self.gatewayStatusTone(state: state) != .success
    }

    nonisolated static func gatewayStatusTitle(state: GatewayDisplayState) -> String {
        switch state {
        case .connected:
            "Connected"
        case .connecting:
            "Connecting"
        case .error:
            "Attention"
        case .disconnected:
            "Offline"
        }
    }

    private var messagePlaceholder: String {
        String(format: String(localized: "Message %@"), self.agentDisplayName)
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
        self.appModel.displayAgents.first { $0.id == self.currentAgentID }
    }

    /// Identity name first (`NodeAppModel.chatAgentName`), then the roster name or id.
    private var currentAgentDisplayName: String {
        self.appModel.chatAgentName
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
}

private struct ChatAgentNameCapsule: Shape {
    let avatarSize: CGFloat
    let overlap: CGFloat

    func path(in rect: CGRect) -> Path {
        // Liquid Glass can render above sibling views. Keep its edge just inside the avatar.
        let avatarBounds = CGRect(
            x: rect.midX - self.avatarSize / 2,
            y: rect.minY + self.overlap - self.avatarSize,
            width: self.avatarSize,
            height: self.avatarSize)
        return Capsule().path(in: rect).subtracting(Path(ellipseIn: avatarBounds.insetBy(dx: 0.5, dy: 0.5)))
    }
}

/// Keep live metering inside the avatar rather than observing it while building the chat surface.
struct ChatVoiceAvatar<Avatar: View>: View {
    let talkMode: TalkModeManager
    private let avatar: Avatar
    private let avatarSize: CGFloat

    init(
        talkMode: TalkModeManager,
        avatarSize: CGFloat = ChatProTab.headerAvatarSize,
        @ViewBuilder avatar: () -> Avatar)
    {
        self.talkMode = talkMode
        self.avatarSize = avatarSize
        self.avatar = avatar()
    }

    var body: TalkAvatarWaveformView<Avatar> {
        TalkAvatarWaveformView(
            phase: self.phase,
            palette: .openClawBrand,
            diameter: self.avatarSize + 4,
            avatarDiameter: self.avatarSize)
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

/// RootTabs rebuilds the chat tab with fresh closures on every sidebar open and close.
/// Compare header controls and first-run action availability, not closure identity.
/// The closures call RootTabs methods that read its live state.
/// The tab's own model, environment, and state reads still invalidate it directly.
extension ChatProTab: @MainActor Equatable {
    static func == (lhs: Self, rhs: Self) -> Bool {
        lhs.headerSidebarAction?.systemName == rhs.headerSidebarAction?.systemName &&
            lhs.headerSidebarAction?.accessibilityIdentifier == rhs.headerSidebarAction?.accessibilityIdentifier &&
            lhs.headerSidebarAction?.drawerPresentation === rhs.headerSidebarAction?.drawerPresentation &&
            lhs.headerSidebarAction?.hasApprovalAttention == rhs.headerSidebarAction?.hasApprovalAttention &&
            (lhs.startFirstGatewaySetup != nil) == (rhs.startFirstGatewaySetup != nil)
    }
}
