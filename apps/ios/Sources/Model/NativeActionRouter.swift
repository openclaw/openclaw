import Foundation
import Observation
import OpenClawChatUI
import OpenClawKit

@MainActor
@Observable
final class NativeActionRouter: OpenClawNativeActionHost {
    /// The current single scene acknowledges presentation here. Scene ownership
    /// can replace this callback without changing the intent or submission owner.
    struct RunPresentation: Identifiable, Equatable {
        let id = UUID()
        let inspection: OpenClawNativeRunInspection
    }

    enum RetirementDisposition: Sendable {
        case departure
        case chatModal
        case chatSessionTransition
    }

    private enum Preparation {
        case waitingForRoot
        case registeredRoot(id: UUID, navigationRevision: UInt64)
    }

    typealias PresentationHandler = @MainActor (
        OpenClawNativeOpenRequest,
        IOSNativeActionBinding,
        RunPresentation?) throws -> Void
    @ObservationIgnored private var presentation: (
        id: UUID,
        open: PresentationHandler,
        retire: @MainActor (RetirementDisposition) -> Void,
        adopt: @MainActor (IOSNativeActionBinding, IOSNativeActionBinding) -> Void)?
    private var inspectionPresentation: RunPresentation?
    @ObservationIgnored private var presentedInspectionID: UUID?
    private var selectionID = UUID()
    @ObservationIgnored private var navigationRevision: UInt64 = 0
    @ObservationIgnored private let appModel: NodeAppModel
    @ObservationIgnored private let gatewayController: GatewayConnectionController
    @ObservationIgnored private weak var chat: OpenClawChatViewModel?
    @ObservationIgnored private var chatOwnerID: String?
    @ObservationIgnored private var chatAgentID: String?
    @ObservationIgnored private var chatTransport: IOSGatewayChatTransport?
    // Account loss must reach retained callers after the chat unregisters.
    // Presentation departure retires selection, not this captured account lifetime.
    @ObservationIgnored private var accountBinding: IOSNativeActionBinding?
    @ObservationIgnored private var chatPresentationID: UUID?
    private(set) var chatRegistrationID: UUID?
    @ObservationIgnored private var preparation: Preparation?
    @ObservationIgnored private var runContinuation: RunContinuation?
    #if DEBUG
    @ObservationIgnored var testLifetimeObservation: (@MainActor (String) -> Void)?
    #endif

    var presentationRegistrationID: UUID? {
        self.presentation?.id
    }

    init(appModel: NodeAppModel, gatewayController: GatewayConnectionController) {
        self.appModel = appModel
        self.gatewayController = gatewayController
        appModel.chatSelectionDidChange = { [weak self] in
            self?.navigationRevision &+= 1
            self?.retireChatSelection()
        }
    }

    @discardableResult
    func registerPresentation(
        onRetire: @escaping @MainActor (RetirementDisposition) -> Void,
        onSessionAdopted: @escaping @MainActor (IOSNativeActionBinding, IOSNativeActionBinding) -> Void = { _, _ in },
        _ handler: @escaping PresentationHandler) -> UUID
    {
        let id = UUID()
        self.runContinuation = nil
        self.presentation = (id, handler, onRetire, onSessionAdopted)
        // A cold action belongs to the first Root that becomes ready, even if
        // navigation replaces that Root before its suspended preparation resumes.
        if case .waitingForRoot? = self.preparation {
            self.preparation = .registeredRoot(id: id, navigationRevision: self.navigationRevision)
        }
        return id
    }

    func unregisterPresentation(_ id: UUID) {
        guard self.presentation?.id == id else { return }
        // Retire even before a chat registers, while its host cleanup is reachable.
        self.clearRegisteredChat()
        self.presentation = nil
    }

    func registerChat(
        _ chat: OpenClawChatViewModel,
        ownerID: String,
        agentID: String,
        transport: IOSGatewayChatTransport?,
        presentationID: UUID?) -> UUID?
    {
        guard let presentationID, self.presentation?.id == presentationID else { return nil }
        let registrationID = UUID()
        self.chatRegistrationID = registrationID
        self.chat = chat
        self.chatOwnerID = ownerID
        self.chatAgentID = agentID
        self.chatTransport = transport
        self.chatPresentationID = presentationID
        return registrationID
    }

    func unregisterChat(_ registrationID: UUID?) {
        // Successive visible views may share the root-owned model and presentation.
        // A disappearing view can retire only the registration it acquired.
        guard let registrationID, self.chatRegistrationID == registrationID else { return }
        self.clearRegisteredChat()
    }

    private func clearRegisteredChat() {
        self.navigationRevision &+= 1
        self.chatRegistrationID = nil
        self.chat = nil
        self.chatOwnerID = nil
        self.chatAgentID = nil
        self.chatTransport = nil
        self.chatPresentationID = nil
        self.retireChatSelection()
    }

    struct PresentationAuthority: Equatable {
        fileprivate let rootID: UUID
        fileprivate let selectionID: UUID
    }

    func capturePresentationAuthority(_ id: UUID?) -> PresentationAuthority? {
        guard let id, self.presentation?.id == id else { return nil }
        return PresentationAuthority(rootID: id, selectionID: self.selectionID)
    }

    func isCurrentPresentation(
        _ authority: PresentationAuthority,
        observe: ((String, Bool) -> Void)? = nil) -> Bool
    {
        func recorded(_ name: String, _ value: Bool) -> Bool {
            #if DEBUG
            observe?(name, value)
            #endif
            return value
        }
        return recorded("authorityRoot", self.presentation?.id == authority.rootID) &&
            recorded("authoritySelection", self.selectionID == authority.selectionID)
    }

    func hasRegisteredChat(
        _ chat: OpenClawChatViewModel,
        binding: IOSNativeActionBinding,
        authority: PresentationAuthority) -> Bool
    {
        self.isCurrentPresentation(authority) && self.chatRegistrationID != nil &&
            self.chatPresentationID == authority.rootID && self.matches(chat, session: binding.session) &&
            self.chatTransport?.nativeBinding?.canReuse(binding) == true
    }

    func captureSessionTransitionAuthority(
        _ chat: OpenClawChatViewModel,
        binding: IOSNativeActionBinding,
        presentationID: UUID?) -> @MainActor () -> Bool
    {
        let selectionID = self.selectionID
        let accountAuthority = self.currentAccountAuthority
        return { [weak self, weak chat] in
            guard let self, let chat, let presentationID else { return false }
            return self.presentation?.id == presentationID && self.selectionID == selectionID &&
                self.currentAccountAuthority == accountAuthority &&
                self.chatPresentationID == presentationID && self.matches(chat, session: binding.session) &&
                self.chatTransport?.nativeBinding?.canReuse(binding) == true
        }
    }

    func chatSessionChanged(
        _ chat: OpenClawChatViewModel,
        binding: IOSNativeActionBinding,
        transport: IOSGatewayChatTransport,
        presentationID: UUID?) -> Bool
    {
        // The shared owner already admitted this synchronous adoption. Keep its
        // model, retire parent confirmations, then publish the exact child binding.
        let target = chat.currentSessionTarget
        guard let presentationID, let presentation, presentation.id == presentationID,
              let registrationID = self.chatRegistrationID,
              self.chatPresentationID == presentationID, self.chat === chat,
              self.chatOwnerID == self.appModel.chatViewModelOwnerID,
              self.chatTransport?.nativeBinding?.canReuse(binding) == true,
              let next = transport.nativeBinding,
              binding.scoped(to: target)?.canReuse(next) == true,
              self.appModel.chatSessionKey.utf8.elementsEqual(binding.session.sessionKey.utf8),
              self.appModel.chatDeliveryAgentId?.utf8.elementsEqual(binding.session.agentID.utf8) == true
        else { return false }
        self.appModel.focusChatSession(target)
        // Focus clears Root's old binding, but does not unregister this visible model.
        guard self.presentation?.id == presentationID, self.chatRegistrationID == registrationID,
              self.chat === chat, self.chatOwnerID == self.appModel.chatViewModelOwnerID,
              binding.scoped(to: target)?.canReuse(next) == true,
              self.appModel.chatSessionKey.utf8.elementsEqual(next.session.sessionKey.utf8),
              self.appModel.chatDeliveryAgentId?.utf8.elementsEqual(next.session.agentID.utf8) == true
        else { return false }
        self.chatTransport = transport
        self.chatAgentID = next.session.agentID
        self.accountBinding = next
        presentation.adopt(binding, next)
        return true
    }

    func retireChatSelection(presentationID: UUID?) {
        guard let presentationID, self.presentation?.id == presentationID else { return }
        self.retireChatSelection()
    }

    @discardableResult
    func userNavigationDidChange(
        presentationID: UUID?,
        disposition: RetirementDisposition = .departure) -> Bool
    {
        guard let presentationID, presentation?.id == presentationID else { return false }
        // User navigation can supersede preparation while Chat is already hidden,
        // when neither view departure nor a model target change records the choice.
        self.navigationRevision &+= 1
        self.retireChatSelection(disposition)
        return true
    }

    private func retireChatSelection(_ disposition: RetirementDisposition = .departure) {
        // Record departure synchronously: returning to the same target must not
        // revive a confirmation or an inspection waiting for visible appearance.
        self.selectionID = UUID()
        self.runContinuation = nil
        self.inspectionPresentation = nil
        self.presentedInspectionID = nil
        self.presentation?.retire(disposition)
    }

    func acknowledgeInspection(_ receipt: RunPresentation, presentationID: UUID?) {
        guard let presentationID, self.presentation?.id == presentationID,
              self.inspectionPresentation?.id == receipt.id else { return }
        self.presentedInspectionID = receipt.id
    }

    func isInspectionPresented(_ receipt: RunPresentation) -> Bool {
        self.inspectionPresentation?.id == receipt.id && self.presentedInspectionID == receipt.id
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
        message: String) async throws -> (send: OpenClawNativePreparedSend, presentationContinuationID: UUID)
    {
        let presented = try await self.present(.session(session))
        let continuationID = try self.captureRunContinuation(presented)
        let lease: OpenClawChatTransportRouteLease
        switch await presented.transport.acquireOutboxRouteLease(ifCurrentRoute: presented.binding.route) {
        case let .available(value): lease = value
        case let .unavailable(reason, _):
            throw OpenClawNativeActionError(reason ?? "The selected Gateway is disconnected. Nothing was queued.")
        }
        let binding = presented.binding
        let authority = presented.accountAuthority
        let rootID = presented.presentationID
        let selectionID = presented.selectionID
        let send = try await presented.gateway.prepareSubmission(
            viewModel: presented.chat,
            session: session,
            message: message,
            lease: lease,
            accountIsCurrent: { await binding.isCurrent() },
            presentationIsCurrent: { [weak self, weak chat = presented.chat] in
                guard let self, let chat else { return false }
                return self.isCurrent(
                    chat: chat,
                    binding: binding,
                    accountAuthority: authority,
                    presentationID: rootID,
                    selectionID: selectionID)
            })
        return (send, continuationID)
    }

    func inspect(_ run: OpenClawNativeRunRef) async throws
        -> (inspection: OpenClawNativeRunInspection, presentationContinuationID: UUID)
    {
        let presented = try await self.present(.inspect(run))
        guard await presented.binding.isCurrent(), self.isCurrent(presented),
              let result = self.inspectionPresentation?.inspection, result.run == run else { throw CancellationError() }
        return try (result, self.captureRunContinuation(presented))
    }

    func openRun(_ run: OpenClawNativeRunRef, continuing id: UUID) async throws -> OpenClawNativeRunOpenOutcome {
        try Task.checkCancellation()
        guard let continuation = self.runContinuation, continuation.id == id,
              continuation.binding.session == run.session else { return .skipped }
        do {
            _ = try await self.present(.inspect(run), continuing: continuation)
            return .opened
        } catch is RunContinuationRetired {
            try Task.checkCancellation()
            return .skipped
        }
    }

    private struct RunContinuation {
        let id = UUID()
        let rootID: UUID
        let navigationRevision: UInt64
        let selectionID: UUID
        let accountAuthority: AccountAuthority
        let binding: IOSNativeActionBinding
    }

    private struct RunContinuationRetired: Error {}

    private func captureRunContinuation(_ presented: PresentedChat) throws -> UUID {
        try Task.checkCancellation()
        guard self.isCurrent(presented) else { throw CancellationError() }
        // Capture before confirmation or ACK suspension. A returned intent carries
        // only this ephemeral origin reference; its durable run ID is not authority.
        if let previous = self.runContinuation,
           previous.rootID == presented.presentationID, previous.navigationRevision == self.navigationRevision,
           previous.selectionID == presented.selectionID, previous.accountAuthority == presented.accountAuthority,
           previous.binding.canReuse(presented.binding)
        {
            return previous.id
        }
        let continuation = RunContinuation(
            rootID: presented.presentationID,
            navigationRevision: self.navigationRevision,
            selectionID: presented.selectionID,
            accountAuthority: presented.accountAuthority,
            binding: presented.binding)
        self.runContinuation = continuation
        return continuation.id
    }

    private func requireRunContinuation(_ continuation: RunContinuation) throws {
        try Task.checkCancellation()
        guard self.runContinuation?.id == continuation.id,
              self.presentation?.id == continuation.rootID, self.navigationRevision == continuation.navigationRevision,
              self.selectionID == continuation.selectionID,
              self.currentAccountAuthority == continuation.accountAuthority,
              self.chatPresentationID == continuation.rootID, let chat,
              self.matches(chat, session: continuation.binding.session),
              self.chatTransport?.nativeBinding?.canReuse(continuation.binding) == true
        else { throw RunContinuationRetired() }
    }

    private struct CapturedGateway {
        let gateway: OpenClawChatNativeActionGateway
        let route: GatewayNodeSessionRoute
        let retirementReservation: IOSNativeActionBinding.RetirementReservation?
        let bindingGateway: @Sendable (IOSNativeActionBinding) -> OpenClawChatNativeActionGateway
    }

    private struct AccountAuthority: Equatable {
        let generation: UInt64
        let inputs: GatewayConnectConfig.ControlUIInputs?
    }

    private var currentAccountAuthority: AccountAuthority {
        AccountAuthority(
            generation: self.appModel.operatorAuthorityGeneration,
            inputs: self.appModel.activeGatewayConnectConfig?.controlUIInputs)
    }

    private struct PresentedChat {
        let gateway: OpenClawChatNativeActionGateway
        let binding: IOSNativeActionBinding
        let chat: OpenClawChatViewModel
        let transport: IOSGatewayChatTransport
        let presentationID: UUID
        let selectionID: UUID
        let accountAuthority: AccountAuthority
    }

    private func captureCurrentGateway() async throws -> CapturedGateway {
        guard !self.appModel.isScreenshotFixtureModeEnabled, !self.appModel.isAppleReviewDemoModeEnabled,
              let gatewayID = self.appModel.activeGatewayConnectConfig?.effectiveStableID,
              let route = await self.appModel.operatorSession.currentRoute(ifGatewayID: gatewayID)
        else {
            throw OpenClawNativeActionError("Open OpenClaw and connect the selected Gateway, then try again.")
        }
        return self.captureGateway(gatewayID: gatewayID, route: route)
    }

    private func captureGateway(gatewayID: String, route: GatewayNodeSessionRoute) -> CapturedGateway {
        let previousBinding = self.accountBinding
        let retirementReservation = previousBinding?.reserveRetirement()
        let operatorSession = self.appModel.operatorSession
        let observedBinding = previousBinding.flatMap {
            $0.gateway === operatorSession && $0.route == route &&
                $0.session.owner.gatewayID.utf8.elementsEqual(gatewayID.utf8) ? $0 : nil
        }
        let name = GatewaySettingsStore.loadGatewayRegistry().entries.first {
            $0.stableID.utf8.elementsEqual(gatewayID.utf8)
        }?.name ?? gatewayID
        let makeGateway: @Sendable (IOSNativeActionBinding?) -> OpenClawChatNativeActionGateway = { binding in
            OpenClawChatNativeActionGateway(
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
                isCurrent: { await operatorSession.currentRoute(ifGatewayID: gatewayID) == route },
                onProfileObservation: { binding?.observe($0) })
        }
        // Verification observes the old capture; later confirmation observes the
        // newly admitted binding. Neither facade looks up a successor after an await.
        return CapturedGateway(
            gateway: makeGateway(observedBinding),
            route: route,
            retirementReservation: retirementReservation,
            bindingGateway: { makeGateway($0) })
    }

    #if DEBUG
    private struct PresentationDiagnostic {
        var stage = "origin"
        var generation: UInt64?
        var account: AccountAuthority?
        var selection: UUID?
        var bindingRead: Bool?
        var admissionFacts: String?
        var completed = false

        mutating func record(
            _ stage: String,
            generation: UInt64? = nil,
            account: AccountAuthority? = nil,
            selection: UUID? = nil,
            bindingRead: Bool? = nil)
        {
            self.stage = stage
            if let generation { self.generation = generation }
            if let account { self.account = account }
            if let selection { self.selection = selection }
            if let bindingRead { self.bindingRead = bindingRead }
        }

        @MainActor
        func recordExit(_ router: NativeActionRouter, rootID: UUID, navigationRevision: UInt64) {
            guard !self.completed else { return }
            let generation = self.generation.map {
                String($0 == router.appModel.gatewayConnectGeneration)
            } ?? "unobserved"
            let account = self.account.map { String($0 == router.currentAccountAuthority) } ?? "unobserved"
            let selection = self.selection.map { String($0 == router.selectionID) } ?? "unobserved"
            let bindingRead = self.bindingRead.map { String($0) } ?? "unobserved"
            let admissionFacts = self.admissionFacts.map { " admissionFacts={\($0)}" } ?? ""
            router.testLifetimeObservation?(
                "present-exit stage=\(self.stage) cancelled=\(Task.isCancelled) " +
                    "root=\(router.presentation?.id == rootID) " +
                    "navigation=\(router.navigationRevision == navigationRevision) " +
                    "generation=\(generation) account=\(account) " +
                    "selection=\(selection) bindingRead=\(bindingRead)\(admissionFacts)")
        }
    }
    #endif

    private func present(
        _ request: OpenClawNativeOpenRequest,
        continuing continuation: RunContinuation? = nil) async throws -> PresentedChat
    {
        let session = request.session
        if let continuation { try self.requireRunContinuation(continuation) }
        guard self.preparation == nil else {
            throw OpenClawNativeActionError("Another native action is opening a chat. Try again when it finishes.")
        }
        if let continuation {
            self.preparation = .registeredRoot(
                id: continuation.rootID,
                navigationRevision: continuation.navigationRevision)
        } else {
            self.preparation = self.presentation.map {
                .registeredRoot(id: $0.id, navigationRevision: self.navigationRevision)
            } ?? .waitingForRoot
        }
        defer { self.preparation = nil }
        let clock = ContinuousClock()
        let deadline = clock.now.advanced(by: .seconds(10))
        while case .waitingForRoot? = self.preparation, clock.now < deadline {
            try await Task.sleep(for: .milliseconds(50))
        }
        guard case let .registeredRoot(rootID, navigationRevision)? = self.preparation else {
            throw OpenClawNativeActionError("Open OpenClaw before running this action.")
        }
        #if DEBUG
        var diagnostic = PresentationDiagnostic()
        defer { diagnostic.recordExit(self, rootID: rootID, navigationRevision: navigationRevision) }
        let observeAdmission: ((String) -> Void)? = { diagnostic.admissionFacts = $0 }
        #else
        let observeAdmission: ((String) -> Void)? = nil
        #endif
        /// Connection-owned target projection can retire a binding while switching
        /// Gateways. Explicit navigation and actual host departure cannot be adopted.
        func requireOrigin() throws {
            #if DEBUG
            if Task.isCancelled { diagnostic.stage = "origin-task-cancelled" }
            #endif
            try Task.checkCancellation()
            if let continuation { try self.requireRunContinuation(continuation) }
            guard self.presentation?.id == rootID, self.navigationRevision == navigationRevision else {
                #if DEBUG
                diagnostic.stage = "origin-authority"
                #endif
                throw CancellationError()
            }
        }
        try requireOrigin()
        try self.requirePreservedDraft(session, observe: observeAdmission)
        #if DEBUG
        diagnostic.stage = "prepare-route"
        #endif
        let (generation, requestedRoute) = try await self.prepareRoute(
            session: session,
            continuation: continuation,
            clock: clock,
            deadline: deadline,
            requireOrigin: requireOrigin)
        #if DEBUG
        diagnostic.record("route-returned", generation: generation)
        #endif
        try requireOrigin()
        guard generation == self.appModel.gatewayConnectGeneration else { throw CancellationError() }
        guard !self.appModel.isScreenshotFixtureModeEnabled, !self.appModel.isAppleReviewDemoModeEnabled,
              let requestedRoute
        else { throw OpenClawNativeActionError("Open OpenClaw and connect the selected Gateway, then try again.") }
        // Capture after the authorized Gateway handoff. Equal restored credentials
        // must not revive a request whose account lifetime changed during a read.
        let accountAuthority = self.currentAccountAuthority
        let captured = self.captureGateway(gatewayID: session.owner.gatewayID, route: requestedRoute)
        let run: OpenClawNativeRunRef? = if case let .inspect(run) = request {
            run
        } else { nil }
        #if DEBUG
        diagnostic.record("history", account: accountAuthority)
        #endif
        let history = try await captured.gateway.history(session: session, runID: run?.runID)
        #if DEBUG
        diagnostic.stage = "history-returned"
        #endif
        try requireOrigin()
        guard self.currentAccountAuthority == accountAuthority else { throw CancellationError() }
        #if DEBUG
        diagnostic.stage = "binding-capture-or-continuation"
        #endif
        let binding = try await IOSNativeActionBinding.capture(
            session: session,
            gateway: self.appModel.operatorSession,
            route: captured.route,
            reservation: captured.retirementReservation)
        try requireOrigin()
        let bindingIsCurrent = await binding.isCurrent()
        #if DEBUG
        diagnostic.record("binding-returned", bindingRead: bindingIsCurrent)
        #endif
        try requireOrigin()
        guard bindingIsCurrent, generation == self.appModel.gatewayConnectGeneration,
              self.currentAccountAuthority == accountAuthority
        else { throw CancellationError() }
        // The old Gateway's delayed projection may retire selection during reads.
        // Only the initiating navigation/root authority governs this pre-adoption phase.
        try requireOrigin()
        try self.requirePreservedDraft(session, binding: binding, observe: observeAdmission)
        let receipt = try run.map {
            try RunPresentation(inspection: OpenClawChatNativeRunInspection.reduce(history, run: $0))
        }
        // RootTabs may disappear or be replaced while Gateway reads suspend.
        guard let presentation, presentation.id == rootID else {
            throw OpenClawNativeActionError("Open OpenClaw before running this action.")
        }
        self.accountBinding = binding
        #if DEBUG
        diagnostic.stage = "presentation-open"
        #endif
        try presentation.open(request, binding, receipt)
        // Selection commits inside the handler, after its modal admission guard.
        // Appearance cannot run on the main actor until this handler returns.
        self.inspectionPresentation = receipt
        self.presentedInspectionID = nil
        let selectionID = self.selectionID
        #if DEBUG
        diagnostic.record("presentation-returned", selection: selectionID)
        #endif
        let presentationDeadline = clock.now.advanced(by: .seconds(10))
        while clock.now < presentationDeadline {
            if let continuation { try self.requireRunContinuation(continuation) }
            let bindingIsCurrent = await binding.isCurrent()
            #if DEBUG
            diagnostic.record("readiness-authority", bindingRead: bindingIsCurrent)
            #endif
            if let continuation { try self.requireRunContinuation(continuation) }
            guard bindingIsCurrent, generation == self.appModel.gatewayConnectGeneration,
                  self.currentAccountAuthority == accountAuthority,
                  self.presentation?.id == presentation.id,
                  self.selectionID == selectionID else { throw CancellationError() }
            if let chat, let transport = self.chatTransport,
               transport.nativeBinding?.canReuse(binding) == true
            {
                let presented = PresentedChat(
                    gateway: captured.bindingGateway(binding),
                    binding: binding,
                    chat: chat,
                    transport: transport,
                    presentationID: presentation.id,
                    selectionID: selectionID,
                    accountAuthority: accountAuthority)
                if self.isCurrent(presented), receipt.map(self.isInspectionPresented) ?? true {
                    #if DEBUG
                    diagnostic.completed = true
                    #endif
                    return presented
                }
                if let reason = chat.errorText {
                    throw OpenClawNativeActionError(reason)
                }
            }
            #if DEBUG
            diagnostic.stage = "readiness-wait"
            #endif
            try await Task.sleep(for: .milliseconds(50))
        }
        throw OpenClawNativeActionError("The selected chat is not ready. Open it and try again.")
    }

    private func prepareRoute(
        session: OpenClawNativeSessionRef,
        continuation: RunContinuation?,
        clock: ContinuousClock,
        deadline: ContinuousClock.Instant,
        requireOrigin: @MainActor () throws -> Void) async throws
        -> (generation: UInt64, requestedRoute: GatewayNodeSessionRoute?)
    {
        if self.appModel.activeGatewayConnectConfig?.effectiveStableID.utf8
            .elementsEqual(session.owner.gatewayID.utf8) != true
        {
            if continuation != nil { throw RunContinuationRetired() }
            let outcome = await self.gatewayController.switchToGateway(stableID: session.owner.gatewayID)
            try requireOrigin()
            switch outcome {
            case .accepted: break
            case let .failed(reason): throw OpenClawNativeActionError(reason)
            case .superseded:
                #if DEBUG
                self.testLifetimeObservation?("prepare-route-superseded")
                #endif
                throw CancellationError()
            }
        }
        let generation = self.appModel.gatewayConnectGeneration
        var requestedRoute: GatewayNodeSessionRoute?
        if let continuation {
            let current = await continuation.binding.isCurrent()
            try requireOrigin()
            guard current else { throw RunContinuationRetired() }
            requestedRoute = continuation.binding.route
        }
        while requestedRoute == nil, clock.now < deadline {
            try requireOrigin()
            guard generation == self.appModel.gatewayConnectGeneration else {
                #if DEBUG
                self.testLifetimeObservation?("prepare-route-generation-before-read")
                #endif
                throw CancellationError()
            }
            if self.appModel.isOperatorGatewayConnected,
               self.appModel.activeGatewayConnectConfig?.effectiveStableID.utf8
                   .elementsEqual(session.owner.gatewayID.utf8) == true
            {
                let route = await self.appModel.operatorSession.currentRoute(ifGatewayID: session.owner.gatewayID)
                try requireOrigin()
                guard generation == self.appModel.gatewayConnectGeneration else {
                    #if DEBUG
                    self.testLifetimeObservation?("prepare-route-generation-after-read")
                    #endif
                    throw CancellationError()
                }
                if self.appModel.isOperatorGatewayConnected,
                   self.appModel.activeGatewayConnectConfig?.effectiveStableID.utf8
                       .elementsEqual(session.owner.gatewayID.utf8) == true, let route
                {
                    requestedRoute = route
                    break
                }
            }
            try await Task.sleep(for: .milliseconds(50))
        }
        return (generation, requestedRoute)
    }

    private func requirePreservedDraft(
        _ session: OpenClawNativeSessionRef,
        binding: IOSNativeActionBinding? = nil,
        observe: ((String) -> Void)? = nil) throws
    {
        #if DEBUG
        var facts: [String] = []
        let observePredicate: ((String, Bool) -> Void)? = observe == nil
            ? nil : { facts.append("\($0)=\($1)") }
        #else
        let observePredicate: ((String, Bool) -> Void)? = nil
        #endif
        if !self.appModel.chatPresentation.canPresentNativeSession(
            session, appModel: self.appModel, binding: binding, observe: observePredicate)
        {
            #if DEBUG
            observe?(facts.joined(separator: " "))
            #endif
            throw OpenClawNativeActionError("Keep or send the current draft before opening a different session.")
        }
    }

    private func isCurrent(_ presented: PresentedChat) -> Bool {
        self.isCurrent(
            chat: presented.chat,
            binding: presented.binding,
            accountAuthority: presented.accountAuthority,
            presentationID: presented.presentationID,
            selectionID: presented.selectionID)
    }

    private func isCurrent(
        chat: OpenClawChatViewModel,
        binding: IOSNativeActionBinding,
        accountAuthority: AccountAuthority,
        presentationID: UUID,
        selectionID: UUID) -> Bool
    {
        self.currentAccountAuthority == accountAuthority &&
            self.presentation?.id == presentationID &&
            self.selectionID == selectionID &&
            self.chatPresentationID == presentationID &&
            self.matches(chat, session: binding.session) &&
            self.chatTransport?.nativeBinding?.canReuse(binding) == true &&
            !chat.isLoading && chat.healthOK && chat.errorText == nil
    }

    private func matches(_ chat: OpenClawChatViewModel, session: OpenClawNativeSessionRef) -> Bool {
        self.chat === chat &&
            self.chatOwnerID == self.appModel.chatViewModelOwnerID &&
            self.appModel.chatTranscriptCacheGatewayID?.utf8.elementsEqual(session.owner.gatewayID.utf8) == true &&
            self.chatAgentID?.utf8.elementsEqual(session.agentID.utf8) == true &&
            self.appModel.chatDeliveryAgentId?.utf8.elementsEqual(session.agentID.utf8) == true &&
            self.appModel.chatSessionKey.utf8.elementsEqual(session.sessionKey.utf8) &&
            chat.currentSessionTarget.sessionKey.utf8.elementsEqual(session.sessionKey.utf8) &&
            (OpenClawChatSessionKey.agentID(from: chat.currentSessionTarget.sessionKey)
                ?? chat.currentSessionTarget.agentID)?.utf8.elementsEqual(session.agentID.utf8) == true
    }
}
