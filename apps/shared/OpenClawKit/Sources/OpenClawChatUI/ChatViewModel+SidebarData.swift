import Foundation

extension OpenClawChatViewModel {
    public internal(set) var sessions: [OpenClawChatSessionEntry] {
        get {
            self.sidebarData?.conversationRows(agentID: self.currentSessionSnapshot().deliveryAgentID) ?? self
                .legacySessions
        }
        set {
            if let sidebarData {
                sidebarData.replaceConversationRows(newValue, agentID: self.currentSessionSnapshot().deliveryAgentID)
            } else {
                self.legacySessions = newValue
                self.syncContextUsageFraction()
                self.syncActiveSessionRunIDsFromCurrentSession()
            }
        }
    }

    public func enableSidebarData() {
        guard self.sidebarData == nil else { return }
        let owner = OpenClawChatSessionSidebarData()
        owner.replaceConversationRows(self.legacySessions, agentID: self.currentSessionSnapshot().deliveryAgentID)
        self.sidebarData = owner
        self.legacySessions = []
        self.swarmRowIDs = owner.receive(self.legacySwarmSessions, read: owner.beginRead())
        self.legacySwarmSessions = []
        owner.onChange = { [weak self] in
            self?.syncContextUsageFraction()
            self?.syncActiveSessionRunIDsFromCurrentSession()
            self?.updateSwarmProjection()
        }
    }

    func rosterEntry(key: String, agentID: String?) -> OpenClawChatSessionEntry? {
        if let sidebarData { return sidebarData.row(key: key, agentID: agentID) }
        let target = OpenClawChatSessionTarget(sessionKey: key, agentID: agentID)
        return self.sessions.first { self.sessionMatchesTarget($0, target: target) }
    }

    func handleSidebarEvent(_ event: OpenClawChatTransportEvent) {
        guard let sidebarData else { return }
        switch event {
        case .routeChanged: sidebarData.invalidate(clear: true)
        case .seqGap: sidebarData.invalidate()
        case .health(false): sidebarData.invalidate()
        case let .sessionObserver(digest): sidebarData.applyObserver(digest)
        case let .sessionsChanged(change):
            if change.reason == "reset" || change.reason == "new" { sidebarData.invalidate() }
            if change.reason == "delete", let key = change.sessionKey,
               let row = sidebarData.row(key: key, agentID: change.agentId)
            { sidebarData.remove(row) }
            // Read ACKs skip only their explicit reload; mutation events still refresh membership.
            // ui/src/lib/sessions/session-mutations.ts:381.
            if self.usesWebConversation { self.refreshSessions(limit: Self.sessionListFetchLimit) }
        default: break
        }
    }

    func applySidebarReadReceipt(
        _ receipt: OpenClawChatSessionPatchReceipt?, target: OpenClawChatSessionEntry?, scopeRevision: Int?) -> Bool
    {
        guard let sidebarData, sidebarData.scopeRevision == scopeRevision, let receipt, let target,
              receipt.matches(target) else { return false }
        sidebarData.confirmFields(receipt, target: target, field: .unread)
        if let row = sidebarData.row(key: target.key, agentID: target.agentId), let unread = row.unread {
            self.unreadPatchGuard.confirmReceipt(key: self.sessionMutationIdentity(
                for: row.key, listedKey: row.key, agentID: row.agentId), unread: unread)
        }
        return true
    }
}
