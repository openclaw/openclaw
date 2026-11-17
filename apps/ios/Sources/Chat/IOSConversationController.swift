import CryptoKit
import Foundation
import Observation
import OpenClawChatUI
import OpenClawKit
import WebKit

/// Only the iPad owner installs this adapter; native chat remains the offline,
/// pending-draft and capture owner. WebKit owns the online transcript/composer.
@MainActor
@Observable
final class IOSConversationController {
    let owner: OpenClawWebConversation
    private(set) var config: GatewayConnectConfig
    let dataStore: WKWebsiteDataStore
    private(set) var bridge: IOSConversationBridge?
    private(set) var documentURL: URL?
    private(set) var nativeRequested = false
    var dashboardRoute: NativeConversationDashboardRoute?
    @ObservationIgnored private weak var viewModel: OpenClawChatViewModel?
    @ObservationIgnored private weak var appModel: NodeAppModel?
    @ObservationIgnored private let store: OpenClawChatSQLiteTranscriptCache
    @ObservationIgnored private let ownership: OpenClawChatSendOwnership
    @ObservationIgnored private var claimOwner = UUID()
    @ObservationIgnored private var scopes: Set<OpenClawChatSendOwnership.Scope> = []
    @ObservationIgnored private var transition: Task<Void, Never>?
    @ObservationIgnored private var outboxChanges: Task<Void, Never>?
    @ObservationIgnored private var ownershipChanges: Task<Void, Never>?
    @ObservationIgnored private var visible = false
    @ObservationIgnored private var active = false
    @ObservationIgnored private var revision = UUID()
    @ObservationIgnored private var closed = false
    @ObservationIgnored private var failed = false
    @ObservationIgnored private var retiring = false
    @ObservationIgnored private var observing = false
    @ObservationIgnored private var nativeTarget: NativeConversationContext?
    @ObservationIgnored private let routes = OpenClawWebConversation.RouteReconciliation()
    @ObservationIgnored var pendingInputCheck: (@MainActor (NativeConversationContext) async -> Bool)?

    init(
        owner: OpenClawWebConversation,
        viewModel: OpenClawChatViewModel,
        appModel: NodeAppModel,
        config: GatewayConnectConfig,
        store: OpenClawChatSQLiteTranscriptCache,
        ownership: OpenClawChatSendOwnership)
    {
        self.owner = owner
        self.viewModel = viewModel
        self.appModel = appModel
        self.config = config
        self.store = store
        self.ownership = ownership
        self.dataStore = WKWebsiteDataStore(forIdentifier: Self.storageID(gatewayID: store.gatewayID))
        owner.mode = .native
        self.nativeTarget = viewModel.webConversationContext
        owner.navigate = { [weak self] context, _ in
            self?.nativeTarget = context
            self?.routes.reset()
            self?.reconcile()
        }
        self.ownershipChanges = Task { [weak self] in
            for await _ in ownership.changes() {
                guard !Task.isCancelled else { return }
                self?.reconcile()
            }
        }
        self.outboxChanges = Task { [weak self] in
            for await _ in store.changes() {
                guard !Task.isCancelled else { return }
                self?.reconcile()
            }
        }
    }

    func updateControlUIMetadata(from config: GatewayConnectConfig) {
        guard !self.closed, self.config.controlUIInputs == config.controlUIInputs,
              self.config.controlUiBasePath != config.controlUiBasePath else { return }
        // Hello learns routing metadata without changing the native/authentication owner.
        // Retire any old executable document before admitting the newly mounted one.
        self.config.controlUiBasePath = config.controlUiBasePath
        self.failed = false
        self.useNative()
    }

    static func storageID(gatewayID: String) -> UUID {
        let bytes = Array(SHA256.hash(data: Data(("openclaw.ipad.conversation:" + gatewayID).utf8)).prefix(16))
        return UUID(uuid: (
            bytes[0],
            bytes[1],
            bytes[2],
            bytes[3],
            bytes[4],
            bytes[5],
            bytes[6],
            bytes[7],
            bytes[8],
            bytes[9],
            bytes[10],
            bytes[11],
            bytes[12],
            bytes[13],
            bytes[14],
            bytes[15]))
    }

    static func removeStorage(gatewayID: String) async {
        let store = WKWebsiteDataStore(forIdentifier: Self.storageID(gatewayID: gatewayID))
        await store.removeData(ofTypes: WKWebsiteDataStore.allWebsiteDataTypes(), modifiedSince: .distantPast)
    }

    private var current: Bool {
        guard let appModel else { return false }
        return !self.closed && appModel.chatPresentation.conversation === self &&
            appModel.activeGatewayConnectConfig?.controlUIInputs == self.config.controlUIInputs
    }

    private func observeEligibility() {
        guard !self.observing, !self.closed, let viewModel, let appModel else { return }
        self.observing = true
        withObservationTracking {
            _ = viewModel.hasPendingNativeConversationInput
            _ = viewModel.pendingRunCount
            _ = appModel.isOperatorGatewayConnected
            _ = appModel.talkMode.isEnabled
            _ = appModel.chatDictationPhase
            _ = appModel.voiceNoteRecorder.ownsPendingChatAttachment
        } onChange: { [weak self] in
            Task { @MainActor in
                self?.observing = false
                self?.reconcile()
            }
        }
    }

    func reconcile() {
        self.observeEligibility()
        guard !self.closed, !self.retiring, let viewModel, let appModel else { return }
        guard self.current else { self.useNative()
            return
        }
        guard appModel.isOperatorGatewayConnected, !self.nativeRequested,
              !appModel.talkMode.isEnabled, appModel.chatDictationPhase == .idle,
              !appModel.voiceNoteRecorder.ownsPendingChatAttachment
        else {
            self.useNative()
            return
        }
        guard !self.failed else { return }
        // Web route admission awaits native draft storage. Eligibility notifications
        // must not turn that read into an unavailable destination by rotating its revision.
        if self.bridge != nil, self.nativeTarget == nil {
            self.reconcileWebRoute()
            return
        }
        self.revision = UUID()
        let revision = self.revision
        self.transition?.cancel()
        self.transition = Task { [weak self] in
            guard let self, let context = viewModel.webConversationContext else { return }
            let reserved = await self.reserve(context)
            guard self.current, self.revision == revision else { return }
            guard reserved else { self.useNative()
                return
            }
            if let bridge = self.bridge {
                if bridge.ready, self.nativeTarget != nil {
                    let document = bridge.documentID
                    let result = await bridge.request(.navigate(context))
                    guard self.current, self.revision == revision, self.bridge === bridge,
                          bridge.documentID == document else { return }
                    guard result else {
                        self.failed = true
                        self.useNative()
                        return
                    }
                    if let state = bridge.state, self.sameConversation(state.context, context) {
                        self.nativeTarget = nil
                        self.routes.report(context)
                        self.reconcileWebRoute()
                    }
                }
                return
            }
            guard let baseURL = AuthenticatedControlUI.pageURL(config: self.config, path: "/", queryItems: []),
                  let url = NativeConversationRoute.documentURL(
                      sessionKey: context.sessionKey, agentID: context.agentId, draft: nil, baseURL: baseURL)
            else { self.useNative()
                return
            }
            viewModel.setWebConversationMode(.probing)
            let bridge = IOSConversationBridge(url: url, gatewayURL: baseURL)
            bridge.isCurrent = { [weak self] in self?.current == true && self?.retiring == false }
            bridge.onFailure = { [weak self] in self?.failed = true
                self?.useNative()
            }
            bridge.onReady = { [weak self, weak bridge] in
                guard let self, self.current, self.bridge === bridge else { return }
                viewModel.setWebConversationMode(.web)
                self.present(visible: self.visible, active: self.active)
                self.reconcile()
            }
            bridge.onState = { [weak self] state in
                guard let self, self.nativeTarget.map({ self.sameConversation($0, state.context) }) != false
                else { return }
                self.nativeTarget = nil
                self.routes.report(state.context)
                self.reconcileWebRoute()
            }
            bridge.onFacts = { [weak self] facts in self?.owner.sessionFacts = facts.sessions }
            bridge.onRoute = { [weak self] context in
                guard let self, self.nativeTarget.map({ self.sameConversation($0, context) }) != false
                else { return }
                self.nativeTarget = nil
                self.routes.report(context)
                self.reconcileWebRoute()
            }
            bridge.onDashboard = { [weak self] route in
                guard let self, self.current else { return false }
                guard IOSConversationView.dashboardURL(route, config: self.config) != nil else { return false }
                self.dashboardRoute = route
                return true
            }
            self.nativeTarget = context
            self.documentURL = url
            self.bridge = bridge
        }
    }

    private func sameConversation(_ lhs: NativeConversationContext, _ rhs: NativeConversationContext) -> Bool {
        let routing = self.appModel?.chatSessionRoutingContract
        return OpenClawChatSendOwnership.Scope(
            sessionKey: lhs.sessionKey, agentID: lhs.agentId, routingContract: routing) ==
            OpenClawChatSendOwnership.Scope(
                sessionKey: rhs.sessionKey, agentID: rhs.agentId, routingContract: routing)
    }

    func reserve(_ context: NativeConversationContext) async -> Bool {
        guard let viewModel, self.current, !self.retiring, !Task.isCancelled,
              !viewModel.hasPendingNativeConversationInput,
              !viewModel.isSending, viewModel.pendingRunCount == 0 else { return false }
        let scope = OpenClawChatSendOwnership.Scope(
            sessionKey: context.sessionKey,
            agentID: context.agentId,
            routingContract: self.appModel?.chatSessionRoutingContract)
        if self.scopes.contains(scope) { return true }
        let revision = self.revision
        let claimOwner = self.claimOwner
        let pendingInputCheck = self.pendingInputCheck ?? { await viewModel.hasPendingNativeConversationInput(for: $0) }
        let pendingBeforeReservation = await pendingInputCheck(context)
        guard self.current, !self.retiring, self.revision == revision, self.claimOwner == claimOwner,
              !Task.isCancelled, !pendingBeforeReservation, !viewModel.hasPendingNativeConversationInput,
              !viewModel.isSending, viewModel.pendingRunCount == 0 else { return false }
        let reservation = UUID()
        guard await self.store.reserveWebConversation(scope: scope, owner: reservation, ownership: self.ownership)
        else { return false }
        defer { self.ownership.endWeb(scope, owner: reservation) }
        guard self.current, !self.retiring, self.revision == revision, self.claimOwner == claimOwner,
              !Task.isCancelled, !viewModel.hasPendingNativeConversationInput,
              !viewModel.isSending, viewModel.pendingRunCount == 0 else { return false }
        let pendingBeforeTransfer = await pendingInputCheck(context)
        // Retirement can release the old claims and rotate their owner during the draft read.
        guard self.current, !self.retiring, self.revision == revision, self.claimOwner == claimOwner,
              !Task.isCancelled, !pendingBeforeTransfer, !viewModel.hasPendingNativeConversationInput,
              !viewModel.isSending, viewModel.pendingRunCount == 0,
              self.ownership.beginWeb(scope, owner: claimOwner) else { return false }
        self.scopes.insert(scope)
        return true
    }

    private func reconcileWebRoute() {
        guard let bridge, !self.retiring, self.nativeTarget == nil else { return }
        Task { [weak self, weak bridge] in
            guard let self, let bridge else { return }
            let document = bridge.documentID
            let outcome = await self.routes.reconcile(
                isCurrent: { self.current && !self.retiring && self.nativeTarget == nil &&
                    self.bridge === bridge && bridge.documentID == document
                },
                reserve: { await self.reserve($0) },
                select: { [weak self] context in
                    guard let self else { return }
                    self.viewModel?.acceptWebRoute(context)
                    if let state = bridge.state, self.sameConversation(state.context, context) {
                        self.viewModel?.acceptWebConversation(state)
                    }
                })
            if case let .unavailable(context) = outcome {
                guard self.current, !self.retiring, self.nativeTarget == nil, self.bridge === bridge,
                      bridge.documentID == document, self.routes.latestContext == context else { return }
                self.viewModel?.acceptWebRoute(context)
                // The destination may still be hydrating its native draft/outbox. Keep
                // its fallback stable instead of reopening WebKit between async reads.
                self.nativeRequested = true
                self.useNative()
            }
        }
    }

    func present(visible: Bool, active: Bool) {
        self.visible = visible
        self.active = active
        guard let bridge, bridge.ready else { return }
        Task { _ = await bridge.request(.presentation(.init(visible: visible, active: active))) }
    }

    func requestNativeControls() {
        self.nativeRequested = true
        self.useNative()
    }

    func resumeWeb() {
        self.nativeRequested = false
        self.failed = false
        self.reconcile()
    }

    private func useNative() {
        guard !self.retiring else { return }
        self.revision = UUID()
        self.transition?.cancel()
        self.routes.reset()
        self.nativeTarget = nil
        guard let bridge else {
            self.releaseClaims()
            self.viewModel?.setWebConversationMode(.native)
            return
        }
        self.retiring = true
        // Keep the view/delegate alive until about:blank commits before native can send.
        bridge.close { [self] in
            self.releaseClaims()
            self.bridge = nil
            self.documentURL = nil
            self.retiring = false
            self.owner.state = nil
            self.owner.sessionFacts = nil
            self.viewModel?.setWebConversationMode(.native)
            self.reconcile()
        }
    }

    private func releaseClaims() {
        for scope in self.scopes {
            self.ownership.endWeb(scope, owner: self.claimOwner)
        }
        self.scopes.removeAll()
        self.claimOwner = UUID()
    }

    func close() {
        self.closed = true
        self.outboxChanges?.cancel()
        self.ownershipChanges?.cancel()
        self.useNative()
    }
}
