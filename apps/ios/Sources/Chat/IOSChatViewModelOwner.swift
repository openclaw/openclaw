import Foundation
import Observation
import OpenClawChatUI
import OpenClawProtocol

@MainActor
@Observable
final class IOSChatViewModelOwner {
    private(set) var viewModel: OpenClawChatViewModel?
    private(set) var presentationID = UUID()
    private(set) var ownerID = ""
    private(set) var presentationAgentID = "main"
    private(set) var presentationAgentName = "Main"
    private(set) var presentationAgentBadge = "M"
    private(set) var hasVerifiedOfflineRoutingIdentity = false
    private var transportAgentID = ""
    private var routingContract = ""
    private var wasConnected = false
    @ObservationIgnored private var hydratedComposerModel: (@MainActor () -> OpenClawChatViewModel?)?
    @ObservationIgnored private var controlUIInputs: GatewayConnectConfig.ControlUIInputs?
    @ObservationIgnored private var isObservingPendingSend = false

    private var hasPendingSend: Bool {
        guard let viewModel else { return false }
        return viewModel.isSubmittingDraft || viewModel.pendingRunCount > 0
    }

    func sync(appModel: NodeAppModel) {
        self.viewModel?.attachmentOwnerActivityChanged()
        let ownerID = appModel.chatViewModelOwnerID
        let agentID = Self.transportAgentID(appModel.chatDeliveryAgentId)
        let routingContract = appModel.chatSessionRoutingContract ?? ""
        let connected = appModel.isOperatorGatewayConnected
        let controlUIInputs = appModel.activeGatewayConnectConfig?.controlUIInputs
        let personalOwnerChanged = appModel.activeGatewayConnectConfig?.personalTailscaleAuthentication == true &&
            !self.ownerID.isEmpty && self.ownerID != ownerID
        let authorityChanged = personalOwnerChanged || (self.controlUIInputs != nil && controlUIInputs != nil &&
            self.controlUIInputs != controlUIInputs)
        let reconnected = connected && !self.wasConnected
        self.wasConnected = connected
        if authorityChanged { self.viewModel?.retireQuestionAuthority() }
        if personalOwnerChanged { self.viewModel?.detachTransport() }
        if let viewModel, !viewModel.isQuestionAuthorityRetired, !authorityChanged,
           self.ownerID == ownerID, self.transportAgentID == agentID
        {
            if self.routingContract != routingContract {
                self.routingContract = routingContract
                viewModel.syncSessionRoutingContract(appModel.chatSessionRoutingContract)
            }
            viewModel.syncSession(to: appModel.chatSessionKey)
            if !viewModel.isAttachmentOwnerPinned {
                self.capturePresentationIdentity(appModel: appModel)
            }
            if let controlUIInputs { self.controlUIInputs = controlUIInputs }
            if reconnected { viewModel.refresh() }
            return
        }
        // Recording, staging, and delivery retain their captured route until the owner releases it.
        guard self.viewModel?.isAttachmentOwnerPinned != true else { return }
        let isDefaultAgentHydration = self.viewModel?.isQuestionAuthorityRetired == false &&
            self.ownerID == ownerID && self.controlUIInputs == controlUIInputs &&
            self.transportAgentID.isEmpty && !agentID.isEmpty &&
            self.viewModel?.sessionKey == appModel.chatSessionKey
        // Preserve the accepted turn and optimistic row until its captured run settles.
        if isDefaultAgentHydration, self.hasPendingSend,
           Self.transportAgentID(appModel.selectedAgentId).isEmpty,
           self.routingContract.isEmpty || self.routingContract == routingContract
        {
            self.observePendingSend(appModel: appModel)
            return
        }
        // Resolving the default agent replaces its transport without changing the draft's owner.
        let draft = isDefaultAgentHydration ? self.viewModel?.input : nil
        // Initial route hydration changes transport, but the same draft keeps its native editor.
        if draft == nil { self.presentationID = UUID() }
        self.viewModel?.detachTransport()
        self.ownerID = ownerID
        self.transportAgentID = agentID
        self.routingContract = routingContract
        self.controlUIInputs = controlUIInputs
        self.capturePresentationIdentity(appModel: appModel)
        let offlineStore = appModel.makeChatOfflineStore()
        let voiceNoteRecorder = appModel.voiceNoteRecorder
        let agentName = self.presentationAgentName
        let agentBadge = self.presentationAgentBadge
        let viewModel = OpenClawChatViewModel(
            sessionKey: appModel.chatSessionKey,
            transport: appModel.makeChatTransport(outboxGatewayID: offlineStore?.gatewayID),
            activeAgentId: appModel.chatDeliveryAgentId,
            sessionRoutingContract: appModel.chatSessionRoutingContract,
            attachmentOwnerIsActive: { [weak voiceNoteRecorder] in
                voiceNoteRecorder?.ownsPendingChatAttachment == true
            },
            transcriptCache: offlineStore,
            outbox: offlineStore,
            onSessionChanged: { [weak appModel] sessionKey in
                appModel?.focusChatSession(sessionKey)
            },
            onToolActivity: { id, name, isActive, toolSessionKey in
                if isActive {
                    LiveActivityManager.shared.showTool(
                        id: id,
                        name: name,
                        agentName: agentName,
                        agentBadge: agentBadge,
                        sessionKey: toolSessionKey)
                } else {
                    LiveActivityManager.shared.endTool(id: id, sessionKey: toolSessionKey)
                }
            },
            diagnosticsLog: { message in GatewayDiagnostics.log(message) })
        self.viewModel = viewModel
        if let draft { viewModel.input = draft }
        self.hydratedComposerModel = draft != nil ? viewModel.composerModelResolver() : nil
        viewModel.load()
    }

    private func observePendingSend(appModel: NodeAppModel) {
        guard !self.isObservingPendingSend else { return }
        self.isObservingPendingSend = true
        // A fast send can settle between SwiftUI updates, so the owner observes its release directly.
        withObservationTracking {
            _ = self.hasPendingSend
        } onChange: { [weak self, weak appModel] in
            Task { @MainActor in
                guard let self else { return }
                self.isObservingPendingSend = false
                guard let appModel else { return }
                self.sync(appModel: appModel)
            }
        }
    }

    func composerModelResolver() -> @MainActor () -> OpenClawChatViewModel? {
        guard let viewModel else { return { nil } }
        let presentationID = self.presentationID
        let modelID = ObjectIdentifier(viewModel)
        let capturedModel = viewModel.composerModelResolver()
        return { [weak self] in
            guard let self, self.presentationID == presentationID else { return nil }
            if self.viewModel.map(ObjectIdentifier.init) == modelID { return capturedModel() }
            // A keystroke can arrive after hydration replaces the model but before SwiftUI updates its binding.
            return self.hydratedComposerModel?()
        }
    }

    func isCurrent(appModel: NodeAppModel) -> Bool {
        self.ownerID == appModel.chatViewModelOwnerID &&
            self.controlUIInputs == appModel.activeGatewayConnectConfig?.controlUIInputs
    }

    private func capturePresentationIdentity(appModel: NodeAppModel) {
        let agentID = appModel.chatAgentId.trimmingCharacters(in: .whitespacesAndNewlines)
        self.presentationAgentID = agentID.isEmpty ? "main" : agentID
        let agent = appModel.gatewayAgents.first { $0.id == self.presentationAgentID }
        let name = agent?.name?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        self.presentationAgentName = name.isEmpty ? appModel.chatAgentName : name
        self.presentationAgentBadge = AgentIdentityPresentation.badge(
            avatarText: agent?.identity?["emoji"]?.value as? String,
            displayName: self.presentationAgentName)
        self.hasVerifiedOfflineRoutingIdentity = appModel.hasVerifiedChatOfflineRoutingIdentity
    }

    nonisolated static func transportAgentID(_ value: String?) -> String {
        value?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() ?? ""
    }
}
