import Foundation

extension OpenClawChatViewModel {
    /// Reads the next page away from the live tip. A read is admitted only while its session, its
    /// route/cursor generation and the requested boundary are unchanged. `beforeApply` runs right before
    /// the transcript changes, so the reader's place is measured against the old layout.
    func loadHistoryPage(
        _ direction: ChatOlderHistory.Direction,
        beforeApply: @escaping @MainActor @Sendable () -> Void = {})
    {
        guard !self.usesWebConversation, !self.isTransportDetached, self.historyPageLoading == nil,
              let first = self.olderHistory.cursor(direction) else { return }
        let session = self.currentSessionSnapshot()
        let generation = self.historyCursorGeneration
        self.historyPageRequestID &+= 1
        let requestID = self.historyPageRequestID
        self.historyPageLoading = direction
        if self.historyPageFailed { self.historyPageFailed = false }
        self.historyPageTask = Task { [weak self] in
            guard let self else { return }
            var cursor = first
            for _ in 0..<ChatOlderHistory.maxPagesPerAction {
                let payload: OpenClawChatHistoryPayload
                do {
                    payload = try await self.transport.requestHistory(sessionKey: session.key, cursor: cursor)
                } catch {
                    guard self.ownsHistoryPageRead(session, generation, direction, cursor) else {
                        return self.retireHistoryPageRead(requestID)
                    }
                    self.historyPageLoading = nil
                    // Only the earlier-messages control offers a retry; newer pages reread on scroll.
                    self.historyPageFailed = direction == .older && !(error is CancellationError)
                    return
                }
                guard self.ownsHistoryPageRead(session, generation, direction, cursor) else {
                    // A full tip read can move the boundary this page was read for.
                    return self.retireHistoryPageRead(requestID)
                }
                if payload.windowReset == true {
                    // The boundary is unusable, not exhausted; the next full tip read supplies a fresh one.
                    if !self.olderHistory.pages.isEmpty { beforeApply() }
                    self.olderHistory = ChatOlderHistory()
                    break
                }
                let page = ChatOlderHistory.Page(
                    messages: Self.decodeMessages(payload.messages ?? [], activity: payload.activity),
                    olderCursor: payload.olderCursor,
                    newerCursor: payload.newerCursor)
                if !page.messages.isEmpty { beforeApply() }
                self.olderHistory.admit(page, direction, tip: self.messages)
                guard page.messages.isEmpty, let next = self.olderHistory.cursor(direction) else { break }
                cursor = next
            }
            self.historyPageLoading = nil
        }
    }

    /// The reader returned to the live edge: drop resident pages; scrolling up reads them again.
    func releaseHistoryPages() {
        self.historyPageTask?.cancel()
        self.historyPageTask = nil
        if self.historyPageLoading != nil { self.historyPageLoading = nil }
        if self.historyPageFailed { self.historyPageFailed = false }
        if !self.olderHistory.pages.isEmpty { self.olderHistory.releasePages() }
    }

    /// Session, agent, route, branch, rewind, reset and compaction changes end every page boundary.
    func resetHistoryPages() {
        self.releaseHistoryPages()
        if self.olderHistory != ChatOlderHistory() { self.olderHistory = ChatOlderHistory() }
    }

    /// A rejected read clears only its own loading state, never a later read's.
    private func retireHistoryPageRead(_ requestID: UInt64) {
        guard requestID == self.historyPageRequestID, self.historyPageLoading != nil else { return }
        self.historyPageLoading = nil
    }

    private func ownsHistoryPageRead(
        _ session: SessionSnapshot,
        _ generation: UInt64,
        _ direction: ChatOlderHistory.Direction,
        _ cursor: String) -> Bool
    {
        !Task.isCancelled && self.isCurrentSession(session) && generation == self.historyCursorGeneration &&
            self.historyPageLoading == direction && self.olderHistory.cursor(direction) == cursor
    }
}
