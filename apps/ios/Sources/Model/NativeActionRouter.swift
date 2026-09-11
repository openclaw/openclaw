import Foundation
import Observation
import OpenClawChatUI
import OpenClawKit

@MainActor
@Observable
final class NativeActionRouter: OpenClawNativeActionHost {
    // The current single scene acknowledges presentation here. Scene ownership
    // can replace this callback without changing the intent or submission owner.
    typealias PresentationHandler = @MainActor (OpenClawNativeOpenRequest, IOSNativeActionBinding) throws -> Void
    @ObservationIgnored private var presentation: (id: UUID, open: PresentationHandler)?
    private(set) var inspection: OpenClawNativeRunInspection?
    @ObservationIgnored private var presentedInspection: OpenClawNativeRunRef?
    @ObservationIgnored private let appModel: NodeAppModel
    @ObservationIgnored private let gatewayController: GatewayConnectionController
    @ObservationIgnored private weak var chat: OpenClawChatViewModel?
    @ObservationIgnored private var chatOwnerID: String?
    @ObservationIgnored private var chatAgentID: String?
    @ObservationIgnored private var chatTransport: IOSGatewayChatTransport?
    @ObservationIgnored private var chatPresentationID: UUID?
    @ObservationIgnored private var preparing = false

    init(appModel: NodeAppModel, gatewayController: GatewayConnectionController) {
        self.appModel = appModel
        self.gatewayController = gatewayController
    }

    @discardableResult
    func registerPresentation(_ handler: @escaping PresentationHandler) -> UUID {
        let id = UUID()
        self.presentation = (id, handler)
        return id
    }

    func unregisterPresentation(_ id: UUID) {
        guard self.presentation?.id == id else { return }
        self.presentation = nil
        self.unregisterChat(self.chat, presentationID: id)
    }

    func registerChat(
        _ chat: OpenClawChatViewModel,
        ownerID: String,
        agentID: String,
        transport: IOSGatewayChatTransport?,
        presentationID: UUID?)
    {
        guard let presentationID, self.presentation?.id == presentationID else { return }
        self.chat = chat
        self.chatOwnerID = ownerID
        self.chatAgentID = agentID
        self.chatTransport = transport
        self.chatPresentationID = presentationID
    }

    func unregisterChat(_ chat: OpenClawChatViewModel?, presentationID: UUID?) {
        guard self.chat === chat, self.chatPresentationID == presentationID else { return }
        self.chat = nil
        self.chatOwnerID = nil
        self.chatAgentID = nil
        self.chatTransport = nil
        self.chatPresentationID = nil
    }

    func chatSessionChanged(_ sessionKey: String, binding: IOSNativeActionBinding, presentationID: UUID?) {
        // Adoption already changed the model's key. Validate its presentation owner,
        // not isCurrent(PresentedChat)'s old-session equality and loading state.
        guard let presentationID, self.presentation?.id == presentationID,
              self.chatPresentationID == presentationID, self.chat != nil,
              self.chatTransport?.nativeBinding?.matches(binding) == true
        else { return }
        self.appModel.focusChatSession(sessionKey)
    }

    func acknowledgeInspection(_ run: OpenClawNativeRunRef, presentationID: UUID?) {
        guard let presentationID, self.presentation?.id == presentationID,
              self.inspection?.run == run else { return }
        self.presentedInspection = run
    }

    func sessions(matching query: String?) async throws -> [OpenClawNativeSessionChoice] {
        let captured = try await self.captureCurrentGateway()
        return try await captured.gateway.sessions(matching: query)
    }

    func runs(matching query: String?) async throws -> [OpenClawNativeRunRef] {
        let captured = try await self.captureCurrentGateway()
        return try await captured.gateway.runs(matching: query)
    }

    func open(_ request: OpenClawNativeOpenRequest) async -> OpenClawNativeOpenOutcome {
        do {
            let presented = try await self.present(request)
            switch request {
            case let .compose(_, draft):
                if let draft {
                    guard !self.appModel.isChatDictationPending, !self.appModel.isChatDictationActive else {
                        throw OpenClawNativeActionError(
                            "Finish or cancel dictation before composing another message.")
                    }
                    let chat = presented.chat
                    guard chat.input.isEmpty, chat.replyTarget == nil,
                          !chat.hasDraftToSend, !chat.isAttachmentOwnerPinned
                    else {
                        throw OpenClawNativeActionError(
                            "Keep or send the current draft before composing another message.")
                    }
                    chat.input = draft
                }
            case .liveVoice:
                let chat = presented.chat
                let scopes = await presented.binding.gateway.currentOperatorScopes(
                    ifCurrentRoute: presented.binding.route)
                guard await presented.binding.isCurrent(), self.isCurrent(presented),
                      scopes?.isDisjoint(with: ["operator.admin", "operator.write", "operator.talk"]) == false
                else {
                    throw OpenClawNativeActionError(
                        "Open voice in the selected chat and finish its permission setup first.")
                }
                guard !chat.isAttachmentOwnerPinned else {
                    throw OpenClawNativeActionError("Finish the current attachment before starting live voice.")
                }
                try await self.appModel.startNativeTalk(
                    nativeBinding: presented.binding,
                    presentationIsCurrent: { [weak self] in self?.isCurrent(presented) == true })
                guard self.isCurrent(presented) else { throw CancellationError() }
            case .session, .inspect:
                break
            }
            return .opened
        } catch is CancellationError {
            return .cancelled
        } catch {
            return .unavailable(reason: error.localizedDescription)
        }
    }

    func prepareSend(
        to session: OpenClawNativeSessionRef,
        message: String) async throws -> OpenClawNativePreparedSend
    {
        let presented = try await self.present(.session(session))
        let lease: OpenClawChatTransportRouteLease
        switch await presented.transport.acquireOutboxRouteLease(ifCurrentRoute: presented.binding.route) {
        case let .available(value): lease = value
        case let .unavailable(reason, _):
            throw OpenClawNativeActionError(reason ?? "The selected Gateway is disconnected. Nothing was queued.")
        }
        return try await presented.gateway.prepareSubmission(
            viewModel: presented.chat,
            session: session,
            message: message,
            lease: lease,
            presentationIsCurrent: { [weak self] in self?.isCurrent(presented) == true })
    }

    func inspect(_ run: OpenClawNativeRunRef) async throws -> OpenClawNativeRunInspection {
        let presented = try await self.present(.inspect(run))
        guard await presented.binding.isCurrent(), self.isCurrent(presented),
              let result = self.inspection, result.run == run else { throw CancellationError() }
        return result
    }

    private struct CapturedGateway {
        let gateway: OpenClawChatNativeActionGateway
        let route: GatewayNodeSessionRoute
    }

    private struct PresentedChat {
        let gateway: OpenClawChatNativeActionGateway
        let binding: IOSNativeActionBinding
        let chat: OpenClawChatViewModel
        let transport: IOSGatewayChatTransport
        let presentationID: UUID
    }

    private func captureCurrentGateway() async throws -> CapturedGateway {
        guard !self.appModel.isScreenshotFixtureModeEnabled, !self.appModel.isAppleReviewDemoModeEnabled,
              let gatewayID = self.appModel.activeGatewayConnectConfig?.effectiveStableID,
              let route = await self.appModel.operatorSession.currentRoute(ifGatewayID: gatewayID)
        else {
            throw OpenClawNativeActionError("Open OpenClaw and connect the selected Gateway, then try again.")
        }
        let operatorSession = self.appModel.operatorSession
        let name = GatewaySettingsStore.loadGatewayRegistry().entries.first {
            $0.stableID.utf8.elementsEqual(gatewayID.utf8)
        }?.name ?? gatewayID
        let gateway = OpenClawChatNativeActionGateway(
            gatewayID: gatewayID,
            gatewayName: name,
            supportsProfileBinding: {
                await operatorSession.supportsServerCapability(.profileBinding, ifCurrentRoute: route) == true
            },
            request: { request, expectedProfileId in
                try await operatorSession.request(
                    request,
                    ifCurrentRoute: route,
                    distinguishPreDispatchRouteChange: true,
                    expectedProfileId: expectedProfileId)
            },
            isCurrent: { await operatorSession.currentRoute(ifGatewayID: gatewayID) == route })
        return CapturedGateway(gateway: gateway, route: route)
    }

    private func present(
        _ request: OpenClawNativeOpenRequest) async throws -> PresentedChat
    {
        let session = request.session
        guard !self.preparing else {
            throw OpenClawNativeActionError("Another native action is opening a chat. Try again when it finishes.")
        }
        self.preparing = true
        defer { self.preparing = false }
        let clock = ContinuousClock()
        let deadline = clock.now.advanced(by: .seconds(10))
        while self.presentation == nil, clock.now < deadline {
            try await Task.sleep(for: .milliseconds(50))
        }
        guard self.presentation != nil else {
            throw OpenClawNativeActionError("Open OpenClaw before running this action.")
        }
        try self.requirePreservedDraft(session)
        if self.appModel.activeGatewayConnectConfig?.effectiveStableID.utf8
            .elementsEqual(session.owner.gatewayID.utf8) != true
        {
            switch await self.gatewayController.switchToGateway(stableID: session.owner.gatewayID) {
            case .accepted: break
            case let .failed(reason): throw OpenClawNativeActionError(reason)
            case .superseded: throw CancellationError()
            }
        }
        let generation = self.appModel.gatewayConnectGeneration
        while !self.appModel.isOperatorGatewayConnected, clock.now < deadline {
            guard generation == self.appModel.gatewayConnectGeneration else { throw CancellationError() }
            try await Task.sleep(for: .milliseconds(50))
        }
        guard generation == self.appModel.gatewayConnectGeneration else { throw CancellationError() }
        let captured = try await self.captureCurrentGateway()
        let run: OpenClawNativeRunRef? = if case let .inspect(run) = request {
            run
        } else { nil }
        let history = try await captured.gateway.history(session: session, runID: run?.runID)
        let binding = try await IOSNativeActionBinding.capture(
            session: session, gateway: self.appModel.operatorSession, route: captured.route)
        guard await binding.isCurrent(), generation == self.appModel.gatewayConnectGeneration else {
            throw CancellationError()
        }
        try self.requirePreservedDraft(session, binding: binding)
        if let run {
            self.inspection = try OpenClawChatNativeRunInspection.reduce(history, run: run)
            self.presentedInspection = nil
        }
        // RootTabs may disappear or be replaced while Gateway reads suspend.
        guard let presentation = self.presentation else {
            throw OpenClawNativeActionError("Open OpenClaw before running this action.")
        }
        try presentation.open(request, binding)
        let presentationDeadline = clock.now.advanced(by: .seconds(10))
        while clock.now < presentationDeadline {
            guard await binding.isCurrent(), generation == self.appModel.gatewayConnectGeneration,
                  self.presentation?.id == presentation.id else { throw CancellationError() }
            if let chat, let transport = self.chatTransport,
               transport.nativeBinding?.matches(binding) == true
            {
                let presented = PresentedChat(
                    gateway: captured.gateway,
                    binding: binding,
                    chat: chat,
                    transport: transport,
                    presentationID: presentation.id)
                if self.isCurrent(presented), run == nil || self.presentedInspection == run {
                    return presented
                }
                if let reason = chat.errorText {
                    throw OpenClawNativeActionError(reason)
                }
            }
            try await Task.sleep(for: .milliseconds(50))
        }
        throw OpenClawNativeActionError("The selected chat is not ready. Open it and try again.")
    }

    private func requirePreservedDraft(
        _ session: OpenClawNativeSessionRef,
        binding: IOSNativeActionBinding? = nil) throws
    {
        let bindingMatches = binding.map { self.chatTransport?.nativeBinding?.matches($0) == true } ?? true
        let captureIsActive = self.appModel.isTalkCaptureActive ||
            self.appModel.isChatDictationPending || self.appModel.isChatDictationActive
        if let chat, let binding, let previous = self.chatTransport?.nativeBinding,
           self.matches(chat, session: session),
           previous.canReopen(binding, preserving: chat, captureIsActive: captureIsActive)
        {
            return
        }
        if let chat, !self.matches(chat, session: session) || !bindingMatches,
           !chat.input.isEmpty || !chat.canPreserveIdleTextDraft || captureIsActive
        {
            throw OpenClawNativeActionError("Keep or send the current draft before opening a different session.")
        }
    }

    private func isCurrent(_ presented: PresentedChat) -> Bool {
        self.presentation?.id == presented.presentationID &&
            self.chatPresentationID == presented.presentationID &&
            self.matches(presented.chat, session: presented.binding.session) &&
            self.chatTransport?.nativeBinding?.matches(presented.binding) == true &&
            !presented.chat.isLoading && presented.chat.healthOK && presented.chat.errorText == nil
    }

    private func matches(_ chat: OpenClawChatViewModel, session: OpenClawNativeSessionRef) -> Bool {
        self.chat === chat &&
            self.chatOwnerID == self.appModel.chatViewModelOwnerID &&
            self.appModel.chatTranscriptCacheGatewayID?.utf8.elementsEqual(session.owner.gatewayID.utf8) == true &&
            self.chatAgentID?.utf8.elementsEqual(session.agentID.utf8) == true &&
            self.appModel.chatDeliveryAgentId?.utf8.elementsEqual(session.agentID.utf8) == true &&
            self.appModel.chatSessionKey.utf8.elementsEqual(session.sessionKey.utf8) &&
            chat.sessionKey.utf8.elementsEqual(session.sessionKey.utf8)
    }
}
