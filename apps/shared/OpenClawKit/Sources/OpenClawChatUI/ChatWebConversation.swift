import Foundation
import Observation
import OpenClawKit

/// Only full macOS windows install this owner; Swift chat remains the default for other callers.
@MainActor
@Observable
public final class OpenClawWebConversation {
    public enum Mode { case probing, native, web }
    public enum NavigationSource { case user, synchronization }

    public struct InitialDraft: Sendable {
        public let context: NativeConversationContext
        public let text: String

        public init(context: NativeConversationContext, text: String) {
            self.context = context
            self.text = text
        }

        public func text(for context: NativeConversationContext) -> String? {
            self.context == context ? self.text : nil
        }
    }

    @MainActor
    public final class RouteReconciliation {
        public enum Outcome: Equatable, Sendable {
            case selected(NativeConversationContext)
            case unavailable(NativeConversationContext)
            case stale
        }

        public private(set) var latestContext: NativeConversationContext?
        private var revision: UInt64 = 0

        public init() {}

        public func report(_ context: NativeConversationContext) {
            guard context != self.latestContext else { return }
            self.latestContext = context
            self.revision &+= 1
        }

        public func reset() {
            self.latestContext = nil
            self.revision &+= 1
        }

        public func reconcile(
            isCurrent: () -> Bool,
            reserve: (NativeConversationContext) async -> Bool,
            select: (NativeConversationContext) -> Void) async -> Outcome
        {
            while let context = self.latestContext {
                guard isCurrent() else { return .stale }
                let revision = self.revision
                let reserved = await reserve(context)
                guard isCurrent() else { return .stale }
                // A newer web route supersedes both success and failure of an
                // awaited reservation. Only the latest admitted route is selected.
                guard self.revision == revision else { continue }
                guard reserved else { return .unavailable(context) }
                select(context)
                return .selected(context)
            }
            return .stale
        }
    }

    public var mode = Mode.probing
    public var state: NativeConversationState?
    public var navigate: ((NativeConversationContext, NavigationSource) -> Void)?
    public var sessionFacts: [NativeConversationSessionFacts.Session]?
    public var openSessionActions: ((NativeConversationContext) -> Void)?

    public func sidebarFacts(for context: NativeConversationContext) -> NativeConversationSessionFacts.Session? {
        guard self.mode == .web else { return nil }
        return self.sessionFacts?.first { $0.context == context }
    }

    public func sessionActions(for context: NativeConversationContext) -> (() -> Void)? {
        guard self.mode == .web, let openSessionActions = self.openSessionActions else { return nil }
        return { [weak self] in
            guard let self, self.mode == .web else { return }
            openSessionActions(context)
        }
    }

    public init() {}
    public var ownsConversation: Bool {
        self.mode != .native
    }
}

extension OpenClawChatViewModel {
    public func refresh() {
        self.load()
    }

    public var usesWebConversation: Bool {
        self.webConversation?.ownsConversation == true
    }

    public var webConversationContext: NativeConversationContext? {
        guard let agent = OpenClawChatSessionKey.agentID(from: self.sessionKey) ??
            self.currentSessionTarget.agentID ?? self.selectedAgent?.id ?? self.activeAgentId else { return nil }
        return NativeConversationContext(agentId: agent, sessionKey: self.sessionKey)
    }

    public var hasPendingNativeConversationInput: Bool {
        // Session selection restores the destination draft before the renderer changes.
        self.hasDraftToSend || self.isAttachmentOwnerPinned || self.isSending || self.isSubmittingDraft
    }

    public func hasPendingNativeConversationInput(for context: NativeConversationContext) -> Bool {
        guard !self.hasPendingNativeConversationInput else { return true }
        guard !self.matchesWebConversationContext(context) else { return false }
        // Web-originated routes report their destination before native selection restores its draft.
        let key = self.composerSessionKey(for: context.sessionKey, agentID: context.agentId)
        return self.draftsBySession[key]?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false
    }

    public func hasPendingNativeConversationWork() async -> Bool {
        if self.hasPendingNativeConversationInput { return true }
        guard let outbox else { return false }
        let session = self.currentSessionSnapshot()
        guard let commands = await outbox.loadCommandsIfAvailable() else { return true }
        guard self.isCurrentSession(session) else { return true }
        let scope = OpenClawChatSendOwnership.Scope(
            sessionKey: session.key, agentID: session.deliveryAgentID, routingContract: session.sessionRoutingContract)
        return self.hasPendingNativeConversationInput || commands.contains {
            OpenClawChatSendOwnership.Scope(
                sessionKey: $0.deliverySessionKey, agentID: $0.agentID, routingContract: $0.routingContract) == scope
        }
    }

    public func setWebConversationMode(_ mode: OpenClawWebConversation.Mode) {
        guard !self.isTransportDetached, let webConversation, webConversation.mode != mode else { return }
        self.advanceSessionGeneration()
        self.bootstrapTask?.cancel()
        self.cancelHistoryInvalidationRefresh()
        self.clearSessionOwnedState()
        webConversation.mode = mode
        if mode != .native {
            let transport = self.transport
            Task { await transport.releaseActiveSessionSubscription() }
        }
        self.load()
    }

    public func matchesWebConversationContext(_ context: NativeConversationContext) -> Bool {
        guard let current = self.webConversationContext else { return false }
        return OpenClawChatSendOwnership.Scope(
            sessionKey: context.sessionKey, agentID: context.agentId, routingContract: self.sessionRoutingContract) ==
            OpenClawChatSendOwnership.Scope(
                sessionKey: current.sessionKey, agentID: current.agentId, routingContract: self.sessionRoutingContract)
    }

    public func acceptWebConversation(_ state: NativeConversationState) {
        guard self.usesWebConversation else { return }
        self.acceptWebRoute(state.context)
        self.webConversation?.state = state
    }

    public func acceptWebRoute(_ context: NativeConversationContext) {
        guard self.usesWebConversation else { return }
        self.isApplyingWebSession = true
        self.switchSession(to: context.sessionKey, agentID: context.agentId)
        self.isApplyingWebSession = false
    }

    func handleWebConversationEvent(_ evt: OpenClawChatTransportEvent) {
        switch evt {
        case let .health(ok):
            self.applyTransportHealth(ok, refreshSessionsOnReconnect: false)
            if ok { self.loadWebConversationChrome()
                self.refreshAgentsIfRequested()
            }
        case .routeChanged, .reconnected, .seqGap:
            self.invalidateSessionMetadataReadiness()
            self.invalidateOutboxBranchReconciliation()
            self.invalidateModelChoices()
            self.loadWebConversationChrome()
            self.refreshAgentsIfRequested()
        case .chatMetadataChanged, .modelSelectionChanged:
            self.invalidateModelChoices()
            self.loadWebConversationChrome()
            self.refreshAgentsIfRequested()
        case let .sessionsChanged(change):
            self.applySessionChangeProjection(change, ownedSwarmActivityNote: false)
            if change.reason == "groups" { self.sessionGroupsRevision += 1 }
        case .questionRequested, .questionResolved:
            self.handleQuestionEvent(evt)
        case let .sessionObserver(digest):
            self.sessions = ChatSessionSidebarModel.applying(
                observerDigest: digest,
                to: self.sessions,
                activeAgentId: self.currentSessionSnapshot().deliveryAgentID)
        default: break
        }
    }

    func loadWebConversationChrome() {
        guard !self.isTransportDetached else { return }
        self.bootstrapTask?.cancel()
        let session = self.currentSessionSnapshot()
        self.isLoading = false
        self.bootstrapTask = Task { [weak self] in
            guard let self else { return }
            await self.fetchSessions(limit: Self.sessionListFetchLimit, sessionSnapshot: session)
            guard self.isCurrentSession(session), self.usesWebConversation else { return }
            await self.refreshQuestions()
        }
    }

    func syncActiveSessionSubscription(startingWith sessionKey: String) async {
        guard sessionKey == self.sessionKey, !self.usesWebConversation else { return }
        var target = self.currentSessionSnapshot()
        var transport = self.transport
        while true {
            // Subscribe requests are gateway side effects. If a stale request finishes
            // after a newer switch, immediately reassert the latest visible session.
            try? await transport.setActiveSessionKey(target.key)
            if self.usesWebConversation || self.isTransportDetached {
                await transport.releaseActiveSessionSubscription()
                return
            }
            let current = self.currentSessionSnapshot()
            guard current.key != target.key || current.deliveryAgentID != target.deliveryAgentID else { return }
            target = current
            transport = self.transport
        }
    }
}
