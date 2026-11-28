import AVFAudio
import OpenClawChatUI
import OpenClawKit
import OpenClawProtocol
import SwiftUI

struct ChatProTab: View {
    @Environment(NodeAppModel.self) private var appModel
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    @Environment(\.verticalSizeClass) private var verticalSizeClass
    @Environment(GatewayConnectionController.self) private var gatewayController
    @AppStorage(ChatPreferences.wrapCodeLinesKey) private var wrapsCodeLines = false
    @AppStorage(ChatPreferences.followUpModeKey) private var followUpMode = ""
    @AppStorage(ChatPreferences.showAssistantTraceKey)
    private var showsAssistantTrace = true
    @AppStorage(ChatPreferences.showsReasoningKey) private var showsReasoning: Bool?
    @AppStorage(ChatPreferences.showsToolCallsKey) private var showsToolCalls: Bool?
    @AppStorage(ChatPreferences.keepsCommentaryKey) private var keepsCommentary = true
    private var chatTraceDisplayOptions: OpenClawChatDisplayOptions {
        ChatPreferences.displayOptions(
            reasoning: self.showsReasoning,
            toolCalls: self.showsToolCalls,
            commentary: self.keepsCommentary,
            legacyTrace: self.showsAssistantTrace,
            reasoningVisible: self.viewModel?.currentSessionReasoningVisible == true)
    }

    private var viewModel: OpenClawChatViewModel? {
        self.appModel.chatPresentation.viewModel
    }

    @Environment(\.dismiss) private var dismiss
    @State private var compactToolbarInset: CGFloat = 0
    @State private var infoVisit: ChatInfoVisit?
    @State private var checkoutChanges: (read: ChatInfoCheckoutRead, value: ChatInfoCheckoutChanges)?

    private var checkoutRead: ChatInfoCheckoutRead? {
        guard self.childKey == nil, !self.isMainChat, !self.isGatewayTransitionPending,
              self.appModel.chatPresentation.ownerID == self.appModel.chatViewModelOwnerID,
              let model = self.viewModel, !model.isNewChatDraft, let entry = model.currentSessionEntry(),
              entry.worktree != nil || entry.repository != nil else { return nil }
        let branch = OpenClawChatInfoPullRequests.checkoutBranch(for: model)
        guard branch?.additions == nil, branch?.deletions == nil else { return nil }
        return ChatInfoCheckoutRead(
            target: model.currentSessionTarget,
            gatewayID: self.appModel.chatTranscriptCacheGatewayID,
            presentationID: self.appModel.chatPresentation.presentationID,
            branch: entry.worktree?.branch ?? entry.repository?["branch"]?.value as? String)
    }

    @State private var showsNewSessionOptions = false
    @State private var speech: OpenClawChatSpeechController?
    var childKey: String?
    var childName: String?
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
            .background {
                if self.childKey != nil {
                    ChatNativeEdgeBack(
                        usesFloatingHeader: !self.usesSideToolbar,
                        isBlocked: self.isAttachmentOwnerPinned)
                }
            }
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
            .navigationBarBackButtonHidden(
                self.childKey != nil && self.usesSideToolbar && self.isAttachmentOwnerPinned)
            .toolbar(self.usesSideToolbar ? .visible : .hidden, for: .navigationBar)
            .toolbar {
                if #available(iOS 27.1, *), self.usesSideToolbar {
                    self.chatToolbar
                }
            }
            .environment(\.openClawChatUsesFloatingComposer, true)
            .navigationDestination(item: self.$infoVisit) { visit in
                ChatInfoPage(visit: visit, writesDisabled: self.areSessionActionsDisabled)
            }
            .task(id: self.checkoutRead) {
                self.checkoutChanges = nil
                guard let read = self.checkoutRead, let changes = await read.changes(in: self.appModel),
                      !Task.isCancelled else { return }
                self.checkoutChanges = (read, changes)
            }
            .onChange(of: self.viewModel?.currentSessionTarget) { _, target in
                if let visit = self.infoVisit, target != visit.target { self.infoVisit = nil }
            }
            .onChange(of: self.appModel.chatPresentation.presentationID) { _, _ in
                if let visit = self.infoVisit, self.viewModel !== visit.model { self.infoVisit = nil }
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
    }

    private var chatHeader: some View {
        GlassEffectContainer(spacing: 8) {
            HStack(alignment: self.isMainChat ? .top : .center, spacing: 8) {
                if self.childKey != nil {
                    OpenClawRoundNavigationButton(action: self.dismiss.callAsFunction) {
                        Image(systemName: "chevron.backward")
                            .font(.system(size: 18, weight: .semibold))
                            .foregroundStyle(.primary)
                    }
                    .accessibilityLabel("Back")
                    .disabled(self.isAttachmentOwnerPinned)
                } else if let headerSidebarAction {
                    OpenClawSidebarControlButton(action: headerSidebarAction, glass: .regular.interactive())
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
                placement: .topBarLeading,
                glass: .regular.interactive())
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
                        : AnyView(self.chatHeader.toastTopBar()))
                .environment(
                    \.openClawChatComposerAccessory,
                    viewModel.isNewChatDraft ? nil : AnyView(
                        ChatSessionApproval(
                            sessionKey: viewModel.sessionKey,
                            agentID: self.appModel.chatAgentId,
                            agentName: self.agentDisplayName)
                            .id(viewModel.sessionKey)))
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
                .modifier(ChatConnectionStrip(strip: viewModel.statusStrip, input: self.connectionStripInput))
                .id(presentationID)
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        } else {
            OpenClawProBackground()
                .safeAreaBar(edge: .top, spacing: 0) {
                    if !self.usesSideToolbar { self.chatHeader.toastTopBar() }
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
        if let childKey, let childName {
            self.sessionHeaderText(title: childName, subtitle: self.viewModel?.subagentChatStatus(for: childKey))
        } else if self.viewModel?.isNewChatDraft == true {
            Color.clear.frame(width: 0, height: 0).accessibilityHidden(true)
        } else {
            Button {
                guard let viewModel, self.childKey == nil else { return }
                // Media and Automations load inside the page; opening never waits on the Gateway.
                self.infoVisit = ChatInfoVisit(
                    model: viewModel,
                    kind: self.isMainChat ? .mainProfile : .chat,
                    agentName: self.agentDisplayName,
                    badge: self.agentBadge,
                    avatar: self.agentAvatarImage,
                    gatewayID: self.appModel.chatTranscriptCacheGatewayID,
                    agentID: self.currentAgentID,
                    uncommittedChanges: self.checkoutChanges.flatMap { $0.read == self.checkoutRead ? $0.value : nil })
            } label: {
                if self.isMainChat, !self.usesSideToolbar {
                    self.mainChatIdentity
                } else {
                    self.headerAgentIdentityLabel
                }
            }
            .buttonStyle(.plain)
            .disabled(self.viewModel == nil || self.childKey != nil || self.isGatewayTransitionPending ||
                self.isAttachmentOwnerPinned && self.appModel.chatPresentation.ownerID != self.appModel
                .chatViewModelOwnerID)
            .accessibilityLabel(Text(verbatim: self.headerAgentAccessibilityLabel))
            .accessibilityIdentifier("chat-agent-identity")
        }
    }

    private var headerAgentIdentityLabel: some View {
        HStack(spacing: 4) {
            self.headerIdentityBadge()
            self.sessionHeaderText(
                title: self.headerSessionTitle ?? self.agentDisplayName,
                subtitle: self.headerProjectName)
        }
        .frame(maxWidth: self.usesSideToolbar ? nil : .infinity, alignment: .leading)
    }

    private func sessionHeaderText(title: String, subtitle: String?) -> some View {
        let name = Text(verbatim: title).font(OpenClawType.subheadSemiBold)
        return ZStack(alignment: .leading) {
            if self.childKey != nil, !self.usesSideToolbar {
                // At large text sizes the two-line name can be taller than either glass control.
                name.lineLimit(2, reservesSpace: true).hidden().accessibilityHidden(true)
            }
            VStack(alignment: self.usesSideToolbar && self.childKey != nil ? .center : .leading, spacing: 0) {
                name.lineLimit(self.usesSideToolbar || subtitle != nil ? 1 : 2)
                    .accessibilityIdentifier("chat-header-title")
                if let subtitle {
                    Text(verbatim: subtitle)
                        .font(OpenClawType.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .accessibilityIdentifier("chat-header-subtitle")
                }
            }
        }
        .multilineTextAlignment(.leading)
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

    /// Use the same title as the sidebar and keep opaque routing keys out of the header.
    private var headerSessionTitle: String? {
        guard let session = headerNonMainSession else { return nil }
        return SessionPresentation.title(session, includesRoutingFallback: false)
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
        // Talk on: the same phrase the composer's Talk row shows, never the owner's raw status.
        let state = self.appModel.talkMode.isEnabled
            ? Self.talkControl(appModel: self.appModel).statusPhrase
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
            phase: appModel.talkMode.chatPhase,
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
            // The words heard so far, while the person speaks; empty in every other phase.
            partialTranscript: appModel.talkMode.isListening ? appModel.talkMode.lastTranscript : "",
            inputDevices: self.talkInputDevices,
            selectedInputDeviceID: self.selectedTalkInputDeviceID(appModel: appModel),
            selectInputDevice: { deviceID in
                appModel.talkMode.selectInputDevice(deviceID)
            },
            cameraFacing: appModel.preferredCameraFacing == .front ? .front : .back,
            flipCamera: {
                appModel.flipPreferredCameraFacing()
            },
            openSettings: {
                if let url = URL(string: UIApplication.openSettingsURLString) {
                    UIApplication.shared.open(url)
                }
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
              talkInputDevices.contains(where: { $0.id == preferredID })
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
            hasInfoPage: self.childKey == nil && self.viewModel?.isNewChatDraft == false,
            isDisabled: self.areSessionActionsDisabled,
            newChat: {
                guard !self.areSessionActionsDisabled else { return }
                self.appModel.requestNewChat()
            })
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

    /// The strip above the composer says why it can't send, so the field keeps its usual prompt.
    private var messagePlaceholder: String {
        if self.childKey != nil { return String(localized: "Message subagent") }
        return String(format: String(localized: "Message %@"), self.agentDisplayName)
    }

    private var connectionStripInput: ChatConnectionStatus.Input {
        ChatConnectionStatus.Input(
            state: self.gatewayDisplayState,
            problem: self.appModel.lastGatewayProblem,
            approvalFailedUnreachable: self.appModel.pendingExecApprovalFailedUnreachable,
            isFirstSetup: self.startFirstGatewaySetup != nil,
            isTalkActive: self.appModel.talkMode.isEnabled)
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

/// UIKit normally gates its interactive pop on a visible navigation bar. The floating header
/// replaces that bar, not the navigation stack or its edge-driven transition.
private struct ChatNativeEdgeBack: UIViewControllerRepresentable {
    let usesFloatingHeader: Bool
    let isBlocked: Bool

    func makeUIViewController(context _: Context) -> Controller {
        Controller()
    }

    func updateUIViewController(_ controller: Controller, context _: Context) {
        controller.update(usesFloatingHeader: self.usesFloatingHeader, isBlocked: self.isBlocked)
    }

    static func dismantleUIViewController(_ controller: Controller, coordinator _: ()) {
        controller.restore()
    }

    final class Controller: UIViewController {
        private weak var edge: UIGestureRecognizer?
        private weak var contentPop: UIGestureRecognizer?
        private weak var previousDelegate: UIGestureRecognizerDelegate?
        private var wasEnabled = false
        private var wasContentPopEnabled = false
        private var usesFloatingHeader = false
        private var isBlocked = false

        override func viewDidAppear(_ animated: Bool) {
            super.viewDidAppear(animated)
            guard self.edge == nil, let navigationController, navigationController.viewControllers.count > 1,
                  let edge = navigationController.interactivePopGestureRecognizer else { return }
            self.edge = edge
            self.previousDelegate = edge.delegate
            self.wasEnabled = edge.isEnabled
            self.contentPop = navigationController.interactiveContentPopGestureRecognizer
            self.wasContentPopEnabled = self.contentPop?.isEnabled == true
            self.applyGestureState()
        }

        func update(usesFloatingHeader: Bool, isBlocked: Bool) {
            guard self.usesFloatingHeader != usesFloatingHeader || self.isBlocked != isBlocked else { return }
            self.usesFloatingHeader = usesFloatingHeader
            self.isBlocked = isBlocked
            self.applyGestureState()
        }

        private func applyGestureState() {
            // A pop must not remove the route while the chat owner refuses to switch sessions.
            self.edge?.delegate = self.usesFloatingHeader ? nil : self.previousDelegate
            self.edge?.isEnabled = !self.isBlocked && (self.usesFloatingHeader || self.wasEnabled)
            self.contentPop?.isEnabled = !self.isBlocked && self.wasContentPopEnabled
        }

        override func viewDidDisappear(_ animated: Bool) {
            super.viewDidDisappear(animated)
            self.restore()
        }

        func restore() {
            guard let edge else { return }
            edge.delegate = self.previousDelegate
            edge.isEnabled = self.wasEnabled
            self.contentPop?.isEnabled = self.wasContentPopEnabled
            self.contentPop = nil
            self.edge = nil
        }
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

/// RootTabs rebuilds the chat tab with fresh closures on every sidebar open and close.
/// Compare header controls and first-run action availability, not closure identity.
/// The closures call RootTabs methods that read its live state.
/// The tab's own model, environment, and state reads still invalidate it directly.
extension ChatProTab: @MainActor Equatable {
    static func == (lhs: Self, rhs: Self) -> Bool {
        lhs.childKey == rhs.childKey && lhs.childName == rhs.childName &&
            lhs.headerSidebarAction?.systemName == rhs.headerSidebarAction?.systemName &&
            lhs.headerSidebarAction?.accessibilityIdentifier == rhs.headerSidebarAction?.accessibilityIdentifier &&
            lhs.headerSidebarAction?.drawerPresentation === rhs.headerSidebarAction?.drawerPresentation &&
            lhs.headerSidebarAction?.hasApprovalAttention == rhs.headerSidebarAction?.hasApprovalAttention &&
            (lhs.startFirstGatewaySetup != nil) == (rhs.startFirstGatewaySetup != nil)
    }
}
