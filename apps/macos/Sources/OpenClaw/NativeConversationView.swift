import AppKit
import Observation
import OpenClawChatUI
import OpenClawKit
import SwiftUI
import WebKit

@MainActor
@Observable
final class NativeConversationController {
    let owner: OpenClawWebConversation
    private let viewModel: OpenClawChatViewModel
    private var initialDraft: OpenClawWebConversation.InitialDraft?
    private var loadedDraft: OpenClawWebConversation.InitialDraft?
    private var loadedContext: NativeConversationContext?
    private var unboundInitialDraft: (sessionKey: String, text: String)?
    private let target: DashboardGatewayTarget
    private let connection: GatewayConnection
    private var ownershipID = UUID()
    private var ownedScopes: Set<OpenClawChatSendOwnership.Scope> = []
    @ObservationIgnored private var navigating = false
    @ObservationIgnored private let webRoutes = OpenClawWebConversation.RouteReconciliation()
    private var isClosed = false
    private var didFallBack = false
    private var isRetiringDocument = false
    private let outbox: (any OpenClawChatCommandOutbox)?
    private(set) var bridge: NativeConversationBridge?
    private(set) var error: String?
    private var startTask: Task<Void, Never>?
    private var outboxTask: Task<Void, Never>?
    private var nativeOwnershipTask: Task<Void, Never>?
    private var navigationGeneration: UInt64 = 0
    var onTitleChanged: ((String) -> Void)?
    private var visible = false
    private var active = false

    init(
        owner: OpenClawWebConversation,
        viewModel: OpenClawChatViewModel,
        target: DashboardGatewayTarget,
        connection: GatewayConnection,
        outbox: (any OpenClawChatCommandOutbox)?)
    {
        self.owner = owner
        self.viewModel = viewModel
        self.initialDraft = viewModel.webConversationContext.flatMap { context in
            viewModel.input.isEmpty ? nil : .init(context: context, text: viewModel.input)
        }
        self.unboundInitialDraft = !viewModel.input.isEmpty && viewModel.webConversationContext == nil
            ? (viewModel.sessionKey, viewModel.input) : nil
        self.target = target
        self.connection = connection
        self.outbox = outbox
        owner.navigate = { [weak self] context, source in
            // Metadata may resolve the opening agent, but a later selection cannot
            // supply ownership for an earlier unbound draft.
            self?.unboundInitialDraft = nil
            self?.navigate(context, source: source)
        }
    }

    func start() {
        guard !self.isClosed, !self.isRetiringDocument, self.startTask == nil else { return }
        self.startTask = Task { @MainActor [weak self] in
            guard let self else { return }
            self.viewModel.load()
            await self.viewModel.refreshAgents()
            guard !Task.isCancelled else { return }
            if let draft = self.unboundInitialDraft, draft.sessionKey == self.viewModel.sessionKey,
               let context = self.viewModel.webConversationContext
            {
                self.initialDraft = .init(context: context, text: draft.text)
                self.unboundInitialDraft = nil
            }
            let pendingNativeWork = await self.viewModel.hasPendingNativeConversationWork() ||
                (self.unboundInitialDraft != nil && self.viewModel.hasDraftToSend)
            let reserved = pendingNativeWork ? false : await self.reserveCurrentSession()
            guard !Task.isCancelled else { return }
            if !reserved {
                self.initialDraft = nil
                self.unboundInitialDraft = nil
                self.viewModel.setWebConversationMode(.native)
                self.observeOutboxDrain()
                return
            }
            if let bridge = self.bridge {
                guard let route = self.routeURL(baseURL: bridge.document.currentURL) else { return }
                bridge.load(route)
                return
            }
            do {
                let handler = NativeConversationMessageHandler()
                let document = try await DashboardManager.shared
                    .conversationDocument(for: self.target) { controller, url in
                        controller.addScriptMessageHandler(
                            handler,
                            contentWorld: .page,
                            name: NativeConversationContract.handlerName)
                        controller.addUserScript(WKUserScript(
                            source: ControlUIDocumentHost.scopedDashboardScript(
                                NativeConversationContract.hostScript,
                                url: url),
                            injectionTime: .atDocumentStart,
                            forMainFrameOnly: true))
                    }
                guard !Task.isCancelled else { return }
                let bridge = NativeConversationBridge(document: document)
                handler.owner = bridge
                self.bridge = bridge
                self.installCallbacks(on: bridge)
                guard let route = self.routeURL(baseURL: document.currentURL) else {
                    self.fallBackToNative()
                    return
                }
                bridge.load(route)
            } catch {
                guard !Task.isCancelled else { return }
                self.viewModel.errorText = error.localizedDescription
                self.fallBackToNative(error: error.localizedDescription)
            }
        }
    }

    private func installCallbacks(on bridge: NativeConversationBridge) {
        bridge.onReady = { [weak self, weak bridge] in
            guard let self, let bridge, self.bridge === bridge else { return }
            if let draft = self.loadedDraft {
                if self.viewModel.matchesWebConversationContext(draft.context), self.viewModel.input == draft.text {
                    self.viewModel.input = ""
                }
                self.initialDraft = nil
                self.loadedDraft = nil
            }
            self.navigating = false
            self.viewModel.setWebConversationMode(.web)
            if bridge.capabilities.contains("session-actions-v1") {
                let documentID = bridge.currentDocumentId
                self.owner.openSessionActions = { [weak self, weak bridge] context in
                    guard let self, let bridge, self.bridge === bridge,
                          bridge.currentDocumentId == documentID, self.owner.mode == .web else { return }
                    bridge.document.webView.window?.makeKeyAndOrderFront(nil)
                    NSApp.activate(ignoringOtherApps: true)
                    self.present(visible: true, active: true)
                    self.navigate(context, source: .user, openSessionActions: true)
                }
            }
            self.present(visible: self.visible, active: self.active)
            if let context = self.viewModel.webConversationContext, context != self.loadedContext {
                self.navigate(context, source: .synchronization)
            }
        }
        bridge.onState = { [weak self, weak bridge] state in
            guard let self, let bridge, self.bridge === bridge else { return }
            self.webRoutes.report(state.context)
            self.scheduleWebReconciliation(bridge)
        }
        bridge.onSessionFacts = { [weak self, weak bridge] facts in
            guard let self, let bridge, self.bridge === bridge else { return }
            self.owner.sessionFacts = facts.sessions
        }
        bridge.onRouteChanged = { [weak self, weak bridge] change in
            guard let self, let bridge, self.bridge === bridge else { return }
            self.webRoutes.report(.init(agentId: change.agentId, sessionKey: change.sessionKey))
            self.scheduleWebReconciliation(bridge)
        }
        bridge.onOpenDashboard = { [weak self] route in self?.openDashboard(route) ?? false }
        bridge.onDocumentRetired = { [weak self] in
            self?.webRoutes.reset()
            self?.owner.state = nil
            self?.owner.sessionFacts = nil
            self?.owner.openSessionActions = nil
        }
        bridge.onUnavailable = { [weak self] availability in
            guard let self else { return }
            if case let .failed(message) = availability {
                self.fallBackToNative(error: message)
            } else {
                self.fallBackToNative()
            }
        }
    }

    private func observeOutboxDrain() {
        guard !self.isClosed else { return }
        self.outboxTask?.cancel()
        self.nativeOwnershipTask?.cancel()
        if let outbox {
            self.outboxTask = Task { [weak self] in
                for await _ in outbox.changes() {
                    guard !Task.isCancelled, let self else { return }
                    await self.reconsiderNativeOwner()
                }
            }
        }
        let changes = self.connection.chatSendOwnership.changes()
        self.nativeOwnershipTask = Task { [weak self] in
            for await _ in changes {
                guard !Task.isCancelled, let self else { return }
                await self.reconsiderNativeOwner()
            }
        }
        Task { await self.reconsiderNativeOwner() }
    }

    private func reconsiderNativeOwner() async {
        guard !self.didFallBack else { return }
        let pending = await self.viewModel.hasPendingNativeConversationWork()
        guard !pending, !Task.isCancelled, !self.isClosed, self.owner.mode == .native else { return }
        guard await self.reserveCurrentSession(), !Task.isCancelled,
              !self.isClosed, self.owner.mode == .native else { return }
        self.viewModel.setWebConversationMode(.probing)
        self.outboxTask?.cancel()
        self.nativeOwnershipTask?.cancel()
        if let bridge = self.bridge, bridge.currentDocumentId != nil,
           let context = self.viewModel.webConversationContext
        {
            self.navigate(context, source: .synchronization)
        } else {
            self.startTask = nil
            self.start()
        }
    }

    func nativeDraftChanged() {
        guard self.owner.mode == .native, !self.didFallBack else { return }
        Task { await self.reconsiderNativeOwner() }
    }

    private func routeURL(baseURL: URL) -> URL? {
        guard let context = self.viewModel.webConversationContext,
              let path = WebChatRoute.dashboardPath(
                  sessionKey: context.sessionKey,
                  agentID: context.agentId)
        else { return nil }
        self.loadedContext = context
        self.loadedDraft = self.initialDraft.flatMap { $0.text(for: context) == nil ? nil : $0 }
        return DashboardRouteMap.dashboardURL(
            byAppendingSameAppPath: path,
            search: WebChatRoute.dashboardSearch(draft: self.loadedDraft?.text),
            to: baseURL)
    }

    private func navigate(
        _ context: NativeConversationContext,
        source: OpenClawWebConversation.NavigationSource,
        openSessionActions: Bool = false)
    {
        guard !self.isClosed, !self.didFallBack else { return }
        self.webRoutes.reset()
        self.navigationGeneration &+= 1
        self.navigating = true
        let generation = self.navigationGeneration
        let documentID = self.bridge?.currentDocumentId
        // Selection originates in an NSTableView delegate. Defer all presentation
        // and responder work until that callback has returned.
        Task { @MainActor [weak self] in
            guard let self, !self.isClosed, !self.isRetiringDocument,
                  generation == self.navigationGeneration else { return }
            if openSessionActions, self.bridge?.currentDocumentId != documentID { return }
            if self.bridge == nil {
                self.startTask?.cancel()
                self.startTask = nil
                self.viewModel.setWebConversationMode(.probing)
                self.start()
                return
            }
            self.error = nil
            await self.transition(
                to: context, source: source, generation: generation, openSessionActions: openSessionActions)
        }
    }

    private func scheduleWebReconciliation(_ bridge: NativeConversationBridge) {
        let documentID = bridge.currentDocumentId
        Task { @MainActor [weak self, weak bridge] in
            guard let self, let bridge, let documentID, !self.isClosed, !self.navigating,
                  self.owner.ownsConversation, self.webRoutes.latestContext != nil,
                  self.bridge === bridge, bridge.currentDocumentId == documentID else { return }
            self.navigationGeneration &+= 1
            self.navigating = true
            let generation = self.navigationGeneration
            let outcome = await self.reconcileWebRoute(bridge, documentID: documentID, generation: generation)
            guard !self.isClosed, self.bridge === bridge, bridge.currentDocumentId == documentID,
                  self.navigationGeneration == generation else { return }
            self.finishWebReconciliation(outcome)
        }
    }

    private func reconcileWebRoute(
        _ bridge: NativeConversationBridge,
        documentID: String,
        generation: UInt64) async -> OpenClawWebConversation.RouteReconciliation.Outcome
    {
        let isCurrent = {
            !self.isClosed && self.owner.ownsConversation && self.bridge === bridge &&
                self.navigationGeneration == generation && bridge.currentDocumentId == documentID &&
                bridge.document.hasCurrentBrowserSession
        }
        return await self.webRoutes.reconcile(
            isCurrent: isCurrent,
            reserve: { context in
                await self.reserveSession(context) {
                    isCurrent() && self.webRoutes.latestContext == context
                }
            },
            select: { context in
                self.viewModel.acceptWebRoute(context)
                if let state = bridge.state, self.viewModel.matchesWebConversationContext(state.context) {
                    self.viewModel.acceptWebConversation(state)
                    self.onTitleChanged?(state.title)
                }
            })
    }

    private func finishWebReconciliation(_ outcome: OpenClawWebConversation.RouteReconciliation.Outcome) {
        self.navigating = false
        if case let .unavailable(context) = outcome {
            self.viewModel.acceptWebRoute(context)
            self.fallBackToNative(error: self.error, reconsiderAfterDrain: true)
        }
    }

    private func transition(
        to context: NativeConversationContext,
        source: OpenClawWebConversation.NavigationSource,
        generation: UInt64,
        openSessionActions: Bool) async
    {
        guard let bridge, let documentID = bridge.currentDocumentId else { return }
        let window = bridge.document.webView.window
        let initiatingResponder = window?.firstResponder
        self.navigating = true
        let reserved = await self.reserveSession(context) {
            self.navigationGeneration == generation && bridge.currentDocumentId == documentID
        }
        guard !self.isClosed, generation == self.navigationGeneration,
              self.bridge === bridge, bridge.currentDocumentId == documentID else { return }
        guard reserved else {
            self.navigating = false
            if openSessionActions {
                self.error = String(localized: "Finish pending native work before opening this session's web actions.")
                return
            }
            self.fallBackToNative(reconsiderAfterDrain: true)
            return
        }
        self.viewModel.setWebConversationMode(.web)
        let result = await bridge.request(openSessionActions ? .openSessionActions(context) : .navigate(context))
        guard !self.isClosed, generation == self.navigationGeneration,
              self.bridge === bridge, bridge.currentDocumentId == documentID else { return }
        if !result.ok {
            self.error = openSessionActions
                ? String(localized: "Could not open session actions. Try again or reopen the window.")
                : String(localized: "Could not open this conversation. Select another thread or reopen the window.")
            if self.webRoutes.latestContext == nil, let state = bridge.state ?? self.owner.state {
                self.webRoutes.report(state.context)
            }
        }
        let outcome = await self.reconcileWebRoute(bridge, documentID: documentID, generation: generation)
        guard !self.isClosed, self.navigationGeneration == generation,
              self.bridge === bridge, bridge.currentDocumentId == documentID else { return }
        self.finishWebReconciliation(outcome)
        if result.ok, source == .user, self.owner.mode == .web, !self.navigating, self.visible, self.active,
           self.viewModel.matchesWebConversationContext(context),
           window?.isKeyWindow == true, window?.firstResponder === initiatingResponder
        {
            if openSessionActions {
                window?.makeFirstResponder(bridge.document.webView)
            } else {
                self.focusComposer()
            }
        }
    }

    func focusComposer() {
        guard let bridge, bridge.currentDocumentId != nil, self.owner.mode == .web,
              !self.navigating, self.visible, self.active,
              let window = bridge.document.webView.window, window.isKeyWindow else { return }
        window.makeFirstResponder(bridge.document.webView)
        Task { _ = await bridge.request(.focusComposer) }
    }

    func present(
        visible: Bool,
        active: Bool)
    {
        self.visible = visible
        self.active = active
        guard let bridge, bridge.currentDocumentId != nil else { return }
        Task { _ = await bridge.request(.presentation(.init(
            visible: visible,
            active: active))) }
    }

    private func openDashboard(_ route: NativeConversationDashboardRoute) -> Bool {
        guard let bridge, let documentId = bridge.currentDocumentId,
              let path = ControlUIDocumentHost.appPath(
                  fromDocumentPath: route.path,
                  baseURL: bridge.document.currentURL),
              route.search.map(DashboardRouteMap.isValidSameAppSearch) != false else { return false }
        let generation = bridge.document.generation
        Task { @MainActor [weak self, weak bridge] in
            guard let self, let bridge else { return }
            await DashboardManager.shared.show(
                atPath: path,
                search: route.search,
                target: self.target)
            {
                !self.isClosed && bridge.currentDocumentId == documentId &&
                    bridge.document.generation == generation && bridge.document.hasCurrentBrowserSession
            }
        }
        return true
    }

    private func reserveCurrentSession() async -> Bool {
        guard let context = self.viewModel.webConversationContext else { return false }
        return await self.reserveSession(context) { self.viewModel.webConversationContext == context }
    }

    private func reserveSession(
        _ context: NativeConversationContext,
        isCurrent: () -> Bool) async -> Bool
    {
        let owner = self.ownershipID
        let scope = await self.connection.conversationOwnershipScope(
            sessionKey: context.sessionKey,
            agentID: context.agentId)
        guard !self.isClosed, !self.didFallBack, self.ownershipID == owner,
              isCurrent(), !self.viewModel.hasPendingNativeConversationInput(for: context) else { return false }
        if self.ownedScopes.contains(scope) { return true }
        let ownership = self.connection.chatSendOwnership
        // Each awaiting attempt owns its own claim. A stale completion must not
        // release another attempt's claim for the same conversation.
        let reservation = UUID()
        let accepted: Bool = if let store = self.outbox as? OpenClawChatSQLiteTranscriptCache {
            await store.reserveWebConversation(
                scope: scope,
                owner: reservation,
                ownership: ownership)
        } else {
            ownership.beginWeb(
                scope,
                owner: reservation)
        }
        guard accepted else { return false }
        defer { ownership.endWeb(scope, owner: reservation) }
        guard !self.isClosed, !self.didFallBack, self.ownershipID == owner,
              isCurrent(), !self.viewModel.hasPendingNativeConversationInput(for: context) else { return false }
        // The temporary claim keeps native admission closed across this transfer.
        guard ownership.beginWeb(scope, owner: owner) else { return false }
        self.ownedScopes.insert(scope)
        return true
    }

    private func retireBridge(afterShutdown completion: @escaping @MainActor () -> Void = {}) {
        self.webRoutes.reset()
        let scopes = self.ownedScopes
        self.ownedScopes.removeAll()
        let ownership = self.connection.chatSendOwnership
        let owner = self.ownershipID
        self.ownershipID = UUID()
        self.isRetiringDocument = self.bridge != nil
        let release: @MainActor () -> Void = { [weak self] in
            for scope in scopes {
                ownership.endWeb(scope, owner: owner)
            }
            self?.isRetiringDocument = false
            completion()
        }
        let bridge = self.bridge
        self.bridge = nil
        if let bridge {
            bridge.close(afterShutdown: release)
        } else {
            release()
        }
    }

    private func fallBackToNative(error: String? = nil, reconsiderAfterDrain: Bool = false) {
        self.didFallBack = !reconsiderAfterDrain
        self.navigationGeneration &+= 1
        self.navigating = false
        self.error = error
        self.viewModel.setWebConversationMode(.probing)
        self.retireBridge { [weak self] in
            guard let self, !self.isClosed else { return }
            self.startTask = nil
            self.viewModel.setWebConversationMode(.native)
            if reconsiderAfterDrain { self.observeOutboxDrain() }
        }
    }

    func close() {
        self.isClosed = true
        self.navigationGeneration &+= 1
        self.startTask?.cancel()
        self.outboxTask?.cancel()
        self.nativeOwnershipTask?.cancel()
        self.retireBridge()
    }
}

struct NativeConversationView: View {
    let controller: NativeConversationController

    var body: some View {
        VStack(spacing: 0) {
            if let error = self.controller.error {
                Text(error).foregroundStyle(.secondary).padding()
            }
            ZStack {
                if let bridge = self.controller.bridge {
                    NativeConversationWebView(bridge: bridge)
                        .opacity(bridge.availability == .ready ? 1 : 0)
                }
                if self.controller.bridge?.availability != .ready {
                    ProgressView()
                }
            }
        }
        .task { self.controller.start() }
    }
}

private struct NativeConversationWebView: NSViewRepresentable {
    let bridge: NativeConversationBridge

    func makeCoordinator() -> NativeConversationBridge {
        self.bridge
    }

    func makeNSView(context: Context) -> WKWebView {
        context.coordinator.document.webView
    }

    func updateNSView(_: WKWebView, context _: Context) {}
}
