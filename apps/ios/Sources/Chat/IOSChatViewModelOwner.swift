import Foundation
import Observation
import OpenClawChatUI
import OpenClawKit
import OpenClawProtocol

/// The view model owns its callback; the relay observes the adopted target
/// without retaining the view or closing a view-model reference cycle.
@MainActor
final class IOSChatSessionTargetRelay {
    weak var viewModel: OpenClawChatViewModel?
    let onChange: @MainActor (OpenClawChatViewModel) -> Void

    init(onChange: @escaping @MainActor (OpenClawChatViewModel) -> Void) {
        self.onChange = onChange
    }

    func sessionChanged() {
        guard let viewModel else { return }
        self.onChange(viewModel)
    }
}

@MainActor
@Observable
final class IOSChatViewModelOwner {
    private(set) var viewModel: OpenClawChatViewModel?
    private(set) var transport: IOSGatewayChatTransport?
    private(set) var ownerID = ""
    private(set) var presentationAgentID = "main"
    private(set) var presentationAgentName = "Main"
    private(set) var presentationAgentBadge = "M"
    private(set) var hasVerifiedOfflineRoutingIdentity = false
    private(set) var transportAgentID = ""
    private var routingContract = ""
    private var wasConnected = false
    @ObservationIgnored private var controlUIInputs: GatewayConnectConfig.ControlUIInputs?

    @ObservationIgnored private weak var nativeActions: NativeActionRouter?
    private var presentationID: UUID?
    #if DEBUG
    @ObservationIgnored private var ordinarySyncAttempt: UInt64 = 0
    #endif

    struct TaskIdentity: Equatable {
        let route: String
        let sessionKey: String
        let routingContract: String?
        let isConnected: Bool
        let isRecording: Bool
        let isAttachmentOwnerPinned: Bool
        let hasProtectedComposer: Bool
        let newChatRequestID: Int
        let authority: GatewayConnectConfig.ControlUIInputs?
        let nativeBinding: ObjectIdentifier?
        let presentationID: UUID?
        let chatRegistrationID: UUID?
        let presentationAuthority: NativeActionRouter.PresentationAuthority?
    }

    func taskIdentity(
        appModel: NodeAppModel,
        nativeBinding: IOSNativeActionBinding?,
        presentationID: UUID?,
        chatRegistrationID: UUID? = nil,
        presentationAuthority: NativeActionRouter.PresentationAuthority? = nil) -> TaskIdentity
    {
        TaskIdentity(
            route: appModel.chatViewModelIdentityID,
            sessionKey: appModel.chatSessionKey,
            routingContract: appModel.chatSessionRoutingContract,
            isConnected: appModel.isOperatorGatewayConnected,
            isRecording: appModel.voiceNoteRecorder.ownsPendingChatAttachment,
            isAttachmentOwnerPinned: self.viewModel?.isAttachmentOwnerPinned == true,
            hasProtectedComposer: self.hasProtectedComposer(appModel: appModel),
            newChatRequestID: appModel.newChatRequestID,
            authority: appModel.activeGatewayConnectConfig?.controlUIInputs,
            nativeBinding: nativeBinding.map(ObjectIdentifier.init),
            presentationID: presentationID,
            chatRegistrationID: chatRegistrationID,
            presentationAuthority: presentationAuthority)
    }

    struct Presentation {
        let binding: IOSNativeActionBinding?
        let router: NativeActionRouter?
        let id: UUID?
    }

    @MainActor
    struct NewChatOrigin {
        let ownerID: String
        let agentID: String?
        let inputs: GatewayConnectConfig.ControlUIInputs?
        let accountGeneration: UInt64?
        let binding: IOSNativeActionBinding?
        let rootID: UUID?
        weak var router: NativeActionRouter?
        let hadRouter: Bool
        let authority: NativeActionRouter.PresentationAuthority?

        init?(appModel: NodeAppModel, presentation: Presentation) {
            let authority = presentation.router?.capturePresentationAuthority(presentation.id)
            guard presentation.id == nil || authority != nil,
                  presentation.binding == nil || authority != nil else { return nil }
            self.ownerID = appModel.chatViewModelOwnerID
            self.agentID = appModel.chatDeliveryAgentId
            let inputs = appModel.activeGatewayConnectConfig?.controlUIInputs
            self.inputs = inputs
            self.accountGeneration = inputs == nil ? nil : appModel.operatorAuthorityGeneration
            self.binding = presentation.binding
            self.rootID = presentation.id
            self.router = presentation.router
            self.hadRouter = presentation.router != nil
            self.authority = authority
        }

        func isCurrent(
            appModel: NodeAppModel,
            presentation: Presentation,
            observe: ((String, Bool) -> Void)? = nil) -> Bool
        {
            func recorded(_ name: String, _ value: Bool) -> Bool {
                #if DEBUG
                observe?(name, value)
                #endif
                return value
            }
            // Record operands where they run; a skipped clause is not a false result.
            return recorded("owner", self.ownerID == appModel.chatViewModelOwnerID) &&
                (recorded("agentNil", self.agentID == nil) ||
                    recorded("agent", self.agentID == appModel.chatDeliveryAgentId)) &&
                (recorded("inputsNil", self.inputs == nil) ||
                    recorded("inputs", self.inputs == appModel.activeGatewayConnectConfig?.controlUIInputs)) &&
                (recorded("accountNil", self.accountGeneration == nil) ||
                    recorded("account", self.accountGeneration == appModel.operatorAuthorityGeneration)) &&
                recorded("binding", self.binding === presentation.binding) &&
                recorded("root", self.rootID == presentation.id) &&
                recorded("routerPresence", self.hadRouter == (presentation.router != nil)) &&
                recorded("router", self.router === presentation.router) &&
                (self.authority.map {
                    recorded("authority", presentation.router?.isCurrentPresentation($0, observe: observe) == true)
                } ?? recorded("unregistered", self.rootID == nil))
        }
    }

    @MainActor
    final class NewChatRequest {
        let id: Int
        let origin: NewChatOrigin
        weak var viewModel: OpenClawChatViewModel?
        let scope: TaskIdentity?
        let generation: UInt64?
        let accountGeneration: UInt64?
        let gateway: GatewayNodeSession?
        let binding: IOSNativeActionBinding?

        init(
            id: Int,
            origin: NewChatOrigin,
            viewModel: OpenClawChatViewModel? = nil,
            scope: TaskIdentity? = nil,
            transport: IOSGatewayChatTransport? = nil,
            generation: UInt64? = nil,
            accountGeneration: UInt64? = nil)
        {
            self.id = id
            self.origin = origin
            self.viewModel = viewModel
            self.scope = scope
            self.generation = generation
            self.accountGeneration = accountGeneration
            self.gateway = transport?.gateway
            self.binding = transport?.nativeBinding
        }
    }

    private var newChatRequest: NewChatRequest?

    func requestNewChat(appModel: NodeAppModel, presentation: Presentation) {
        guard let origin = NewChatOrigin(appModel: appModel, presentation: presentation) else { return }
        appModel.requestNewChat()
        // Bind the click before SwiftUI schedules readiness. The same request
        // must never acquire a successor's target or account after an await.
        self.newChatRequest = NewChatRequest(id: appModel.newChatRequestID, origin: origin)
    }

    func currentNewChatRequest(appModel: NodeAppModel, presentation: Presentation) -> NewChatRequest? {
        guard let request = self.newChatRequest, let viewModel = request.viewModel, let scope = request.scope,
              request.id == appModel.newChatRequestID, request.origin.isCurrent(
                  appModel: appModel,
                  presentation: presentation),
              self.viewModel === viewModel, !viewModel.isQuestionAuthorityRetired,
              request.generation == appModel.gatewayConnectGeneration,
              request.accountGeneration == appModel.operatorAuthorityGeneration,
              self.transport?.gateway === request.gateway, self.transport?.nativeBinding === request.binding,
              self.matchesBinding(request.binding),
              scope == self.taskIdentity(
                  appModel: appModel,
                  nativeBinding: presentation.binding,
                  presentationID: presentation.id)
        else { return nil }
        // Consuming the counter and setting isCreatingSession do not retire this
        // identity. Registration wakes readiness but cannot cancel admitted work.
        return request
    }

    func synchronizePresentation(
        appModel: NodeAppModel,
        currentPresentation: @MainActor () -> Presentation) async
    {
        let presentation = currentPresentation()
        #if DEBUG
        if presentation.binding == nil { self.ordinarySyncAttempt &+= 1 }
        let ordinarySyncAttempt = self.ordinarySyncAttempt
        func observeOrdinarySync(_ event: String) {
            guard presentation.binding == nil else { return }
            presentation.router?.testLifetimeObservation?("ordinary-sync-\(event) attempt=\(ordinarySyncAttempt)")
        }
        observeOrdinarySync("entered")
        #endif
        guard let origin = NewChatOrigin(appModel: appModel, presentation: presentation) else {
            #if DEBUG
            observeOrdinarySync("origin-refused")
            #endif
            return
        }
        let pending = self.newChatRequest
        let inputs = appModel.activeGatewayConnectConfig?.controlUIInputs
        let generation = appModel.gatewayConnectGeneration
        let accountGeneration = appModel.operatorAuthorityGeneration
        if presentation.binding == nil {
            await appModel.restoreChatSessionRoutingIdentityIfNeeded()
        }
        // Restore may resolve cached routing, but cannot renew user/account
        // authority. A first connection invalidates this attempt, not its intent.
        guard !Task.isCancelled else {
            #if DEBUG
            observeOrdinarySync("restore-cancelled")
            #endif
            return
        }
        #if DEBUG
        var originFacts: [String] = []
        var rejectedOriginClause: String?
        let observeOrigin: ((String, Bool) -> Void)? = presentation.binding == nil ? { name, value in
            originFacts.append("\(name)=\(value)")
            let hasAuthorityFailure = rejectedOriginClause == "authorityRoot" ||
                rejectedOriginClause == "authoritySelection"
            if !value, name != "authority" || !hasAuthorityFailure { rejectedOriginClause = name }
        } : nil
        #else
        let observeOrigin: ((String, Bool) -> Void)? = nil
        #endif
        guard origin.isCurrent(
            appModel: appModel, presentation: currentPresentation(), observe: observeOrigin)
        else {
            #if DEBUG
            observeOrdinarySync(
                "restore-origin-changed rejected=\(rejectedOriginClause ?? "unobserved") " +
                    "facts={\(originFacts.joined(separator: " "))}")
            #endif
            return
        }
        guard inputs == appModel.activeGatewayConnectConfig?.controlUIInputs else {
            #if DEBUG
            observeOrdinarySync("restore-inputs-changed")
            #endif
            return
        }
        guard generation == appModel.gatewayConnectGeneration else {
            #if DEBUG
            observeOrdinarySync("restore-gateway-generation-changed")
            #endif
            return
        }
        guard accountGeneration == appModel.operatorAuthorityGeneration else {
            #if DEBUG
            observeOrdinarySync("restore-account-generation-changed")
            #endif
            return
        }
        self.sync(
            appModel: appModel,
            nativeBinding: presentation.binding,
            nativeActions: presentation.router,
            presentationID: presentation.id)
        #if DEBUG
        observeOrdinarySync("return modelPresent=\(self.viewModel != nil)")
        #endif
        guard let pending, pending.scope == nil, self.newChatRequest === pending,
              pending.id == appModel.newChatRequestID,
              pending.origin.isCurrent(appModel: appModel, presentation: currentPresentation()),
              let viewModel else { return }
        let scope = self.taskIdentity(
            appModel: appModel,
            nativeBinding: presentation.binding,
            presentationID: presentation.id)
        guard let context = await self.readyNewChatPresentation(appModel: appModel, presentation: presentation),
              !Task.isCancelled, context.viewModel === viewModel, self.viewModel === viewModel,
              self.newChatRequest === pending,
              generation == appModel.gatewayConnectGeneration,
              accountGeneration == appModel.operatorAuthorityGeneration,
              origin.isCurrent(appModel: appModel, presentation: currentPresentation()),
              pending.origin.isCurrent(appModel: appModel, presentation: currentPresentation()),
              scope == self.taskIdentity(
                  appModel: appModel,
                  nativeBinding: currentPresentation().binding,
                  presentationID: currentPresentation().id)
        else { return }
        // Compare-and-publish once. Obsolete attempts never clear a newer slot;
        // registration renewals never replace an already prepared request.
        self.newChatRequest = NewChatRequest(
            id: pending.id,
            origin: pending.origin,
            viewModel: viewModel,
            scope: scope,
            transport: context.transport,
            generation: generation,
            accountGeneration: accountGeneration)
    }

    private func readyNewChatPresentation(
        appModel: NodeAppModel,
        presentation: Presentation) async -> VisiblePresentation?
    {
        guard let context = await self.visiblePresentation(
            appModel: appModel,
            nativeBinding: presentation.binding,
            nativeActions: presentation.router,
            presentationID: presentation.id) else { return nil }
        if let binding = context.transport?.nativeBinding {
            guard let authority = context.authority,
                  presentation.router?
                      .hasRegisteredChat(context.viewModel, binding: binding, authority: authority) == true
            else { return nil }
        }
        return context
    }

    @discardableResult
    func performNewChat(
        _ request: NewChatRequest,
        appModel: NodeAppModel,
        currentPresentation: @MainActor () -> Presentation) async -> Bool
    {
        guard self.currentNewChatRequest(appModel: appModel, presentation: currentPresentation()) === request,
              let viewModel = request.viewModel,
              let context = await self.readyNewChatPresentation(
                  appModel: appModel,
                  presentation: currentPresentation()),
              !Task.isCancelled, context.viewModel === viewModel,
              self.currentNewChatRequest(appModel: appModel, presentation: currentPresentation()) === request,
              appModel.consumeNewChatRequest(request.id) else { return false }
        return await viewModel.startNewSession()
    }

    struct VisiblePresentation {
        let viewModel: OpenClawChatViewModel
        let transport: IOSGatewayChatTransport?
        let ownerID: String
        let agentID: String
        let authority: NativeActionRouter.PresentationAuthority?
    }

    /// Reappearing UI may attest a retained native owner without receiving a new
    /// intent binding. Visibility is acquired separately; old selections stay retired.
    func visiblePresentation(
        appModel: NodeAppModel,
        nativeBinding: IOSNativeActionBinding?,
        nativeActions: NativeActionRouter?,
        presentationID: UUID?) async -> VisiblePresentation?
    {
        guard !Task.isCancelled, let viewModel else { return nil }
        let transport = self.transport
        let ownerID = self.ownerID
        let agentID = self.transportAgentID
        var authority: NativeActionRouter.PresentationAuthority?
        if let binding = transport?.nativeBinding {
            guard let nativeActions,
                  let captured = nativeActions.capturePresentationAuthority(presentationID)
            else { return nil }
            func ownerMatches() -> Bool {
                self.viewModel === viewModel && !viewModel.isQuestionAuthorityRetired &&
                    self.ownerID == ownerID && self.transportAgentID == agentID &&
                    self.transport?.nativeBinding === binding && self.transport?.gateway === transport?.gateway &&
                    self.nativeActions === nativeActions && self.presentationID == presentationID &&
                    self.matchesNativeTarget(binding.session, appModel: appModel) &&
                    appModel.chatSessionKey.utf8.elementsEqual(binding.session.sessionKey.utf8) &&
                    appModel.chatDeliveryAgentId?.utf8.elementsEqual(binding.session.agentID.utf8) == true &&
                    binding.canReuse(nativeBinding ?? binding)
            }
            guard ownerMatches(), await binding.isCurrent(), !Task.isCancelled,
                  nativeActions.isCurrentPresentation(captured), ownerMatches()
            else { return nil }
            authority = captured
        } else if nativeBinding != nil {
            return nil
        }
        return VisiblePresentation(
            viewModel: viewModel,
            transport: transport,
            ownerID: ownerID,
            agentID: agentID,
            authority: authority)
    }

    func sync(
        appModel: NodeAppModel,
        nativeBinding: IOSNativeActionBinding? = nil,
        nativeActions: NativeActionRouter? = nil,
        presentationID: UUID? = nil)
    {
        let controlUIInputs = appModel.activeGatewayConnectConfig?.controlUIInputs
        let authorityChanged = self.controlUIInputs != nil && controlUIInputs != nil &&
            self.controlUIInputs != controlUIInputs
        // Account retirement is independent of adopting a replacement model.
        // A protected composer must not keep the old account's questions alive.
        if authorityChanged { self.viewModel?.retireQuestionAuthority() }
        if let nativeBinding,
           !self.canPresentNativeSession(nativeBinding.session, appModel: appModel, binding: nativeBinding)
        {
            return
        }
        self.viewModel?.attachmentOwnerActivityChanged()
        let ownerID = appModel.chatViewModelOwnerID
        let agentID = nativeBinding?.session.agentID ?? Self.transportAgentID(appModel.chatDeliveryAgentId)
        let sessionKey = nativeBinding?.session.sessionKey ?? appModel.chatSessionKey
        let selectedRoutingContract = nativeBinding == nil
            ? appModel.chatSessionRoutingContract : nativeBinding?.sessionRoutingContract
        let routingContract = selectedRoutingContract ?? ""
        let bindingMatches = self.matchesBinding(nativeBinding)
        let connected = appModel.isOperatorGatewayConnected
        let reconnected = connected && !self.wasConnected
        self.wasConnected = connected
        if let viewModel, bindingMatches, !viewModel.isQuestionAuthorityRetired, !authorityChanged,
           !Self.requiresViewModelRebuild(
               currentOwnerID: self.ownerID,
               nextOwnerID: ownerID,
               currentTransportAgentID: self.transportAgentID,
               nextTransportAgentID: agentID)
        {
            if self.routingContract != routingContract {
                self.routingContract = routingContract
                viewModel.syncSessionRoutingContract(selectedRoutingContract)
            }
            self.nativeActions = nativeActions
            self.presentationID = presentationID
            viewModel.syncSession(to: sessionKey)
            if !viewModel.isAttachmentOwnerPinned {
                self.capturePresentationIdentity(appModel: appModel, nativeBinding: nativeBinding)
            }
            if let controlUIInputs { self.controlUIInputs = controlUIInputs }
            if reconnected { viewModel.refresh() }
            return
        }
        // Recording, staging, and delivery retain their captured route until the owner releases it.
        guard self.viewModel?.isAttachmentOwnerPinned != true else { return }
        let preservedInput = self.preservedReopenedInput(nativeBinding, appModel: appModel)
        if preservedInput == nil, !bindingMatches, self.hasProtectedComposer(appModel: appModel) { return }
        self.viewModel?.detachTransport()
        self.nativeActions = nativeActions
        self.presentationID = presentationID
        self.ownerID = ownerID
        self.transportAgentID = agentID
        self.routingContract = routingContract
        self.controlUIInputs = controlUIInputs
        self.capturePresentationIdentity(appModel: appModel, nativeBinding: nativeBinding)
        let offlineStore = nativeBinding == nil ? appModel.makeChatOfflineStore() : nil
        let voiceNoteRecorder = appModel.voiceNoteRecorder
        let agentName = self.presentationAgentName
        let agentBadge = self.presentationAgentBadge
        let transport = appModel.makeChatTransport(
            outboxGatewayID: offlineStore?.gatewayID,
            nativeBinding: nativeBinding)
        self.transport = transport as? IOSGatewayChatTransport
        let relay = IOSChatSessionTargetRelay { [weak self, weak appModel] viewModel in
            guard let self, self.viewModel === viewModel else { return }
            if nativeBinding != nil {
                guard let appModel, self.isCurrent(appModel: appModel),
                      let previous = self.transport?.nativeBinding,
                      let transport = self.transport?.scoped(toSessionTarget: viewModel.currentSessionTarget)
                      as? IOSGatewayChatTransport,
                      let next = transport.nativeBinding,
                      self.nativeActions?.chatSessionChanged(
                          viewModel,
                          binding: previous,
                          transport: transport,
                          presentationID: self.presentationID) == true
                else { return }
                self.transport = transport
                self.transportAgentID = next.session.agentID
                self.routingContract = next.sessionRoutingContract ?? ""
                self.capturePresentationIdentity(appModel: appModel, nativeBinding: next)
            } else {
                appModel?.focusChatSession(viewModel.currentSessionTarget)
            }
        }
        let viewModel = OpenClawChatViewModel(
            sessionKey: sessionKey,
            transport: transport,
            activeAgentId: nativeBinding?.session.agentID ?? appModel.chatDeliveryAgentId,
            sessionRoutingContract: selectedRoutingContract,
            attachmentOwnerIsActive: { [weak voiceNoteRecorder] in
                voiceNoteRecorder?.ownsPendingChatAttachment == true
            },
            transcriptCache: offlineStore,
            outbox: offlineStore,
            onSessionChanged: { _ in relay.sessionChanged() },
            captureSessionTransitionAuthority: { [weak self, weak relay] in
                guard let self, let viewModel = relay?.viewModel, self.viewModel === viewModel else {
                    return { false }
                }
                guard nativeBinding != nil else { return { true } }
                guard let binding = self.transport?.nativeBinding,
                      let nativeActions = self.nativeActions else { return { false } }
                // Capture the current logical target once for this operation. A later
                // adoption must not change the authority of an already-running fork.
                return nativeActions.captureSessionTransitionAuthority(
                    viewModel,
                    binding: binding,
                    presentationID: self.presentationID)
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
        relay.viewModel = viewModel
        self.viewModel = viewModel
        if let preservedInput { viewModel.input = preservedInput }
        viewModel.load()
    }

    func isCurrent(appModel: NodeAppModel) -> Bool {
        self.ownerID == appModel.chatViewModelOwnerID &&
            self.controlUIInputs == appModel.activeGatewayConnectConfig?.controlUIInputs
    }

    func hasProtectedComposer(appModel: NodeAppModel) -> Bool {
        appModel.voiceNoteRecorder.ownsPendingChatAttachment ||
            self.viewModel.map {
                !$0.input.isEmpty || $0.replyTarget != nil || $0.hasDraftToSend || $0.isAttachmentOwnerPinned
            } == true
    }

    /// Hidden chat retains its composer here. Native admission and adoption must
    /// agree before the router changes Gateway or session selection.
    func canPresentNativeSession(
        _ session: OpenClawNativeSessionRef,
        appModel: NodeAppModel,
        binding: IOSNativeActionBinding? = nil,
        observe: ((String, Bool) -> Void)? = nil) -> Bool
    {
        func recorded(_ name: String, _ value: Bool) -> Bool {
            #if DEBUG
            observe?(name, value)
            #endif
            return value
        }
        func recordedFalse(_ name: String, _ value: Bool?) -> Bool {
            #if DEBUG
            observe?("\(name)Known", value != nil)
            #endif
            return recorded(name, value == false)
        }
        guard recorded("protected", self.hasProtectedComposer(appModel: appModel)) ||
            recordedFalse("idleBlocked", self.viewModel?.canPreserveIdleTextDraft) ||
            recorded("capture", self.captureIsActive(appModel: appModel))
        else { return true }
        guard recorded("target", self.matchesNativeTarget(session, appModel: appModel)) else { return false }
        // A same-target reopen needs the history/account read before a new binding
        // exists. The second admission checks that verified binding against live state.
        guard let binding else {
            #if DEBUG
            observe?("bindingPresent", false)
            #endif
            return true
        }
        #if DEBUG
        observe?("bindingPresent", true)
        #endif
        return (recorded("bindingMatches", self.matchesBinding(binding)) &&
            recordedFalse("questionCurrent", self.viewModel?.isQuestionAuthorityRetired)) ||
            recorded("preservedInput", self.preservedReopenedInput(binding, appModel: appModel) != nil)
    }

    private func matchesNativeTarget(_ session: OpenClawNativeSessionRef, appModel: NodeAppModel) -> Bool {
        guard let viewModel, let transport, self.isCurrent(appModel: appModel) else { return false }
        let target = viewModel.currentSessionTarget
        return transport.nativeBinding?.session == session && transport.gateway === appModel.operatorSession &&
            appModel.chatTranscriptCacheGatewayID?.utf8.elementsEqual(session.owner.gatewayID.utf8) == true &&
            self.transportAgentID.utf8.elementsEqual(session.agentID.utf8) &&
            target.sessionKey.utf8.elementsEqual(session.sessionKey.utf8) &&
            (OpenClawChatSessionKey.agentID(from: target.sessionKey) ?? target.agentID)?
            .utf8.elementsEqual(session.agentID.utf8) == true
    }

    private func preservedReopenedInput(_ next: IOSNativeActionBinding?, appModel: NodeAppModel) -> String? {
        guard let next, let viewModel, let previous = self.transport?.nativeBinding,
              self.matchesNativeTarget(next.session, appModel: appModel),
              previous.canReopen(next, preserving: viewModel, captureIsActive: self.captureIsActive(appModel: appModel))
        else { return nil }
        // Reopening retains idle text only, never the retired transport or send authority.
        return viewModel.input
    }

    private func captureIsActive(appModel: NodeAppModel) -> Bool {
        appModel.isTalkCaptureActive || appModel.isChatDictationPending || appModel.isChatDictationActive
    }

    private func matchesBinding(_ next: IOSNativeActionBinding?) -> Bool {
        switch (self.transport?.nativeBinding, next) {
        case (nil, nil): true
        case let (current?, next?): current.canReuse(next)
        default: false
        }
    }

    private func capturePresentationIdentity(appModel: NodeAppModel, nativeBinding: IOSNativeActionBinding?) {
        let agentID = nativeBinding?.session.agentID ??
            appModel.chatAgentId.trimmingCharacters(in: .whitespacesAndNewlines)
        self.presentationAgentID = agentID.isEmpty ? "main" : agentID
        let agent = appModel.gatewayAgents.first { $0.id.utf8.elementsEqual(self.presentationAgentID.utf8) }
        let name = agent?.name?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let fallbackName = nativeBinding == nil ? appModel.chatAgentName : self.presentationAgentID
        self.presentationAgentName = name.isEmpty ? fallbackName : name
        self.presentationAgentBadge = AgentIdentityPresentation.normalizedBadgeEmoji(
            agent?.identity?["emoji"]?.value as? String) ??
            AgentIdentityPresentation.initialsBadge(for: self.presentationAgentName)
        self.hasVerifiedOfflineRoutingIdentity = nativeBinding == nil && appModel.hasVerifiedChatOfflineRoutingIdentity
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
