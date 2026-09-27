import Foundation
import Observation
import OpenClawChatUI
import OpenClawProtocol

@MainActor
@Observable
final class IOSChatViewModelOwner {
    private(set) var viewModel: OpenClawChatViewModel?
    private(set) var ownerID = ""
    private(set) var presentationAgentID = "main"
    private(set) var presentationAgentName = "Main"
    private(set) var presentationAgentBadge = "M"
    private(set) var hasVerifiedOfflineRoutingIdentity = false
    private var transportAgentID = ""
    private var routingContract = ""
    private var wasConnected = false
    @ObservationIgnored private var controlUIInputs: GatewayConnectConfig.ControlUIInputs?

    func sync(appModel: NodeAppModel) {
        self.viewModel?.attachmentOwnerActivityChanged()
        let ownerID = appModel.chatViewModelOwnerID
        let agentID = Self.transportAgentID(appModel.chatDeliveryAgentId)
        let routingContract = appModel.chatSessionRoutingContract ?? ""
        let connected = appModel.isOperatorGatewayConnected
        let controlUIInputs = appModel.activeGatewayConnectConfig?.controlUIInputs
        let authorityChanged = self.controlUIInputs != nil && controlUIInputs != nil &&
            self.controlUIInputs != controlUIInputs
        let reconnected = connected && !self.wasConnected
        self.wasConnected = connected
        if authorityChanged { self.viewModel?.retireQuestionAuthority() }
        if let viewModel, !viewModel.isQuestionAuthorityRetired, !authorityChanged, !Self.requiresViewModelRebuild(
            currentOwnerID: self.ownerID,
            nextOwnerID: ownerID,
            currentTransportAgentID: self.transportAgentID,
            nextTransportAgentID: agentID)
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
        // Resolving the default agent replaces its transport without changing the draft's owner.
        let draft: String? = if let viewModel, !viewModel.isQuestionAuthorityRetired,
                                self.ownerID == ownerID, self.controlUIInputs == controlUIInputs,
                                self.transportAgentID.isEmpty, !agentID.isEmpty,
                                viewModel.sessionKey == appModel.chatSessionKey
        {
            viewModel.input
        } else {
            nil
        }
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
        viewModel.load()
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
        self.presentationAgentBadge = AgentIdentityPresentation.normalizedBadgeEmoji(
            agent?.identity?["emoji"]?.value as? String) ??
            AgentIdentityPresentation.initialsBadge(for: self.presentationAgentName)
        self.hasVerifiedOfflineRoutingIdentity = appModel.hasVerifiedChatOfflineRoutingIdentity
    }

    nonisolated static func transportAgentID(_ value: String?) -> String {
        value?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() ?? ""
    }

    nonisolated static func requiresViewModelRebuild(
        currentOwnerID: String,
        nextOwnerID: String,
        currentTransportAgentID: String,
        nextTransportAgentID: String) -> Bool
    {
        currentOwnerID != nextOwnerID || currentTransportAgentID != nextTransportAgentID
    }
}
