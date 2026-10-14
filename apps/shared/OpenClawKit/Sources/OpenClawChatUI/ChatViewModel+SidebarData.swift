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
        self.updateSidebarQuery()
    }

    public func updateSidebarQuery(
        search: String? = nil,
        status: OpenClawChatSidebarStatus? = nil,
        agentScope: OpenClawChatSidebarAgentScope? = nil,
        showAutomation: Bool? = nil,
        showSystem: Bool? = nil)
    {
        guard let owner = self.sidebarData, !self.isTransportDetached,
              let transport = self.defaultTransport as? any OpenClawChatSidebarTransport else { return }
        let scope = agentScope ?? (owner.isQueryEnabled ? owner.agentScope : .selected)
        let agentID = scope == .all ? nil : self.selectedAgentID ?? self.currentSessionSnapshot().deliveryAgentID
        guard scope == .all || agentID != nil else { return }
        var query = owner.query
        query.agentID = agentID
        if let search { query.search = search.trimmingCharacters(in: .whitespacesAndNewlines) }
        if let status { query.status = status }
        if let showAutomation { query.excludeCron = !showAutomation }
        if let showSystem { query.excludeSystem = !showSystem }
        if !owner.isQueryEnabled {
            owner.configureQueries(transport: transport, query: query)
        } else if !owner.setQuery(query) { return }
        self.refreshSidebarData(debounce: search != nil)
    }

    func refreshSidebarData(debounce: Bool = false, coalescing: Bool = false) {
        guard !self.isTransportDetached, self.healthOK, self.sidebarData?.isQueryEnabled == true else { return }
        self.sidebarData?.scheduleLoad(debounce: debounce, coalescing: coalescing)
    }

    func rosterEntry(key: String, agentID: String?) -> OpenClawChatSessionEntry? {
        if let sidebarData { return sidebarData.row(key: key, agentID: agentID) }
        let target = OpenClawChatSessionTarget(sessionKey: key, agentID: agentID)
        return self.sessions.first { self.sessionMatchesTarget($0, target: target) }
    }

    func handleSidebarEvent(_ event: OpenClawChatTransportEvent) {
        guard let sidebarData else { return }
        switch event {
        case .routeChanged:
            sidebarData.invalidate(clear: true)
            self.refreshSidebarData()
        case .reconnected, .seqGap:
            // ui/src/components/session-data-controller-events.ts:147 retains rows across reconnects.
            sidebarData.invalidate()
            self.refreshSidebarData()
        case .health(false): sidebarData.invalidate()
        case .health(true):
            if !self.healthOK, sidebarData.isQueryEnabled { sidebarData.scheduleLoad() }
        case let .sessionObserver(digest): sidebarData.applyObserver(digest)
        case let .sessionsChanged(change):
            // Retire the affected row without cancelling unrelated roster reads or pending edits.
            if ["delete", "reset", "new"].contains(change.reason), let key = change.sessionKey,
               let row = sidebarData.row(key: key, agentID: change.agentId)
            { sidebarData.remove(row) }
            // Read ACKs skip only their explicit reload; mutation events still refresh membership.
            // ui/src/lib/sessions/session-mutations.ts:381.
            if self.usesWebConversation { self.refreshSessions(limit: Self.sessionListFetchLimit) }
            self.refreshSidebarData(coalescing: true)
        default: break
        }
    }

    func applySidebarReadReceipt(
        _ receipt: OpenClawChatSessionPatchReceipt?, target: OpenClawChatSessionEntry?, scopeRevision: Int?) -> Bool
    {
        guard let sidebarData, sidebarData.scopeRevision == scopeRevision, let receipt, let target,
              receipt.matches(target) else { return false }
        sidebarData.confirmFields(receipt, target: target, fields: [.unread])
        if let row = sidebarData.row(key: target.key, agentID: target.agentId), let unread = row.unread {
            self.unreadPatchGuard.confirmReceipt(key: self.sessionMutationIdentity(
                for: row.key, listedKey: row.key, agentID: row.agentId), unread: unread)
        }
        return true
    }
}
