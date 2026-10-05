import Foundation

extension OpenClawChatViewModel {
    func currentSessionSnapshot() -> SessionSnapshot {
        SessionSnapshot(
            key: self.sessionKey,
            generation: self.sessionGeneration,
            agentID: self.activeAgentId,
            deliveryAgentID: self.explicitSessionAgentID ??
                OpenClawChatSessionKey.agentID(from: self.sessionKey) ?? self.activeAgentId,
            sessionRoutingContract: self.sessionRoutingContract)
    }

    func resetEarlierHistory() {
        self.earlierHistoryGeneration &+= 1
        self.earlierHistorySessionID = nil
        self.earlierHistoryNextOffset = nil
        self.earlierHistoryTotalMessages = nil
        self.hasEarlierHistory = false
        self.isLoadingEarlierHistory = false
        self.hasLoadedEarlierHistory = false
    }

    /// A live tail is not a complete transcript. Retain only its already loaded
    /// canonical predecessors; the new tail still owns edits and removals.
    func retainedEarlierHistoryPrefix(
        _ payload: OpenClawChatHistoryPayload,
        incoming: [OpenClawChatMessage]) -> [OpenClawChatMessage]
    {
        let previousTotal = self.earlierHistoryTotalMessages
        let incomingKeys = Set(incoming.compactMap(Self.messageIdentityKey))
        let firstOverlap = self.messages.firstIndex { message in
            Self.messageIdentityKey(for: message).map(incomingKeys.contains) == true
        }
        var prefix: [OpenClawChatMessage] = []
        var appended: Int?
        if self.hasLoadedEarlierHistory, let sessionID = payload.sessionId,
           sessionID == self.earlierHistorySessionID, payload.windowReset != true,
           let total = payload.totalMessages, let previousTotal, total >= previousTotal,
           let firstOverlap
        {
            prefix = Array(self.messages.prefix(firstOverlap))
            appended = total - previousTotal
        }
        let retainsPrefix = appended != nil
        let previousOffset = self.earlierHistoryNextOffset
        let wasExhausted = self.hasLoadedEarlierHistory && !self.hasEarlierHistory
        self.earlierHistoryGeneration &+= 1
        self.isLoadingEarlierHistory = false
        self.hasLoadedEarlierHistory = retainsPrefix
        self.earlierHistorySessionID = payload.sessionId
        self.earlierHistoryTotalMessages = payload.totalMessages
        if let appended {
            self.earlierHistoryNextOffset = previousOffset.map { $0 + appended }
            self.hasEarlierHistory = !wasExhausted && self.earlierHistoryNextOffset != nil
        } else {
            self.earlierHistoryNextOffset = payload.nextOffset
            self.hasEarlierHistory = payload.hasMore == true && payload.nextOffset != nil &&
                payload.totalMessages != nil
        }
        return prefix
    }

    /// Returns true only when this session consumed an older page. The reader
    /// owns its visible anchor and must not restore it after a stale result.
    @discardableResult
    public func loadEarlierHistory() async -> Bool {
        guard self.hasEarlierHistory, !self.isLoadingEarlierHistory, !self.isTransportDetached,
              !self.isSwitchingSessionBranch,
              var offset = self.earlierHistoryNextOffset,
              var total = self.earlierHistoryTotalMessages,
              let sessionID = self.sessionId else { return false }
        let session = self.currentSessionSnapshot()
        let generation = self.earlierHistoryGeneration
        let transport = self.transport
        self.isLoadingEarlierHistory = true
        defer {
            if self.isCurrentSession(session), self.earlierHistoryGeneration == generation {
                self.isLoadingEarlierHistory = false
            }
        }
        do {
            // An append can move numeric offsets after request admission. Rebase
            // once from the server's actual total, never accept the shifted slice.
            for attempt in 0..<2 {
                let payload = try await transport.requestHistoryPage(sessionKey: session.key, offset: offset)
                guard self.isCurrentSession(session), self.earlierHistoryGeneration == generation,
                      !self.isSwitchingSessionBranch, payload.sessionId == sessionID, payload.windowReset != true,
                      payload.offset == offset, let responseTotal = payload.totalMessages,
                      responseTotal >= total else { return false }
                if responseTotal != total {
                    guard attempt == 0 else { return false }
                    offset += responseTotal - total
                    total = responseTotal
                    continue
                }
                let older = Self.decodeMessages(payload.messages ?? [], activity: payload.activity)
                if payload.hasMore == true {
                    guard let next = payload.nextOffset, next > offset else { return false }
                }
                let previous = self.messages
                let merged = Self.reconcileMessageIDs(previous: previous, incoming: older + previous)
                self.replaceMessages(Self.dedupeMessages(merged))
                self.earlierHistoryTotalMessages = responseTotal
                self.earlierHistoryNextOffset = payload.nextOffset
                self.hasEarlierHistory = payload.hasMore == true && payload.nextOffset != nil
                self.hasLoadedEarlierHistory = true
                return true
            }
        } catch {
            guard self.isCurrentSession(session), self.earlierHistoryGeneration == generation else { return false }
            if !(error is CancellationError) { self.errorText = error.localizedDescription }
        }
        return false
    }
}
