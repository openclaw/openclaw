import Foundation
import OpenClawKit

/// Older history pages, ported from web `ui/src/pages/chat/chat-pane-history.ts:383-567`.
/// The newest page owns the first `olderCursor`; each older page owns the next one.
extension OpenClawChatViewModel {
    private enum OlderHistoryPage {
        case prepended
        /// The page only overlapped loaded rows; its boundary still moved.
        case empty
        case stopped
    }

    /// A reader action may cross this many overlapping pages before yielding (web `chat-pane-history.ts:393`).
    private static let olderHistoryPagesPerLoad = 3

    var canLoadOlderHistory: Bool {
        !self.usesWebConversation && self.historyOlderCursor != nil
    }

    /// Loads rows before the oldest loaded row. Callers for the same boundary share one read.
    /// Returns true when rows were prepended.
    @discardableResult
    func loadOlderHistory() async -> Bool {
        guard self.canLoadOlderHistory, !self.isTransportDetached,
              let cursor = self.historyOlderCursor else { return false }
        if let active = self.olderHistoryLoad {
            // The next boundary starts only after its predecessor publishes.
            return active.cursor == cursor ? await active.task.value : false
        }
        self.lastOlderHistoryLoadID &+= 1
        let id = self.lastOlderHistoryLoadID
        let session = self.currentSessionSnapshot()
        self.isLoadingOlderHistory = true
        self.olderHistoryLoadFailed = false
        let task = Task { [weak self] in
            guard let self else { return false }
            var prepended = false
            for _ in 0..<Self.olderHistoryPagesPerLoad {
                guard let pageCursor = self.historyOlderCursor else { break }
                let page = await self.loadOlderHistoryPage(cursor: pageCursor, session: session)
                if case .empty = page { continue }
                prepended = page == .prepended
                break
            }
            if self.olderHistoryLoad?.id == id {
                self.olderHistoryLoad = nil
                self.isLoadingOlderHistory = false
            }
            return prepended
        }
        self.olderHistoryLoad = (id, cursor, task)
        return await task.value
    }

    private func loadOlderHistoryPage(cursor: String, session: SessionSnapshot) async -> OlderHistoryPage {
        do {
            let payload = try await self.transport.requestHistory(sessionKey: session.key, cursor: cursor)
            guard !Task.isCancelled, self.ownsOlderHistoryBoundary(cursor, session: session) else { return .stopped }
            let next = payload.hasMore == false ? nil : payload.olderCursor
            if next == cursor {
                // Retrying the same boundary cannot make progress (web `chat-pane-history.ts:499-501`).
                chatUILogger.error("older history returned the same boundary")
                self.historyOlderCursor = nil
                return .stopped
            }
            let older = await Self.decodeMessages(payload.messages ?? [], activity: payload.activity)
            guard !Task.isCancelled, self.ownsOlderHistoryBoundary(cursor, session: session) else { return .stopped }
            self.historyOlderCursor = next
            return self.prependOlderHistory(older) ? .prepended : (next == nil ? .stopped : .empty)
        } catch {
            guard !Task.isCancelled, self.ownsOlderHistoryBoundary(cursor, session: session) else { return .stopped }
            chatUILogger.error("older history failed \(error.localizedDescription, privacy: .public)")
            self.olderHistoryLoadFailed = true
            return .stopped
        }
    }

    private func ownsOlderHistoryBoundary(_ cursor: String, session: SessionSnapshot) -> Bool {
        self.isCurrentSession(session) && self.historyOlderCursor == cursor
    }

    /// Prepends rows not already loaded, matched by `__openclaw.id`, else `__openclaw.seq`
    /// (web `lib/chat/history-message-identity.ts:57-127`).
    private func prependOlderHistory(_ older: [OpenClawChatMessage]) -> Bool {
        let loaded = Set(self.messages.compactMap(Self.historySourceIdentity(for:)))
        let unique = older.filter { message in
            Self.historySourceIdentity(for: message).map { !loaded.contains($0) } ?? true
        }
        guard !unique.isEmpty else { return false }
        self.olderHistoryMessageIDs.formUnion(unique.map(\.id))
        self.olderHistoryWillPrepend?()
        self.replaceMessages(unique + self.messages)
        return true
    }

    static func historySourceIdentity(for message: OpenClawChatMessage) -> String? {
        if let id = ChatPayloadDecoding.trimmedNonEmptyString(message.transcriptMessageID) { return "id:\(id)" }
        if let seq = message.sourceMetadata?.seq, seq > 0 { return "seq:\(seq)" }
        return nil
    }

    /// A newest-page refresh does not contain prepended older rows: keep them ahead of it and keep
    /// their boundary while the page still reaches them. Until older rows exist beyond the page,
    /// or once the page has slid past rows nothing can reload, the page owns the boundary.
    func applyOlderHistoryBoundary(
        _ payload: OpenClawChatHistoryPayload,
        page: [OpenClawChatMessage],
        isDelta: Bool,
        replacingCanonicalHistory: Bool,
        to nextMessages: inout [OpenClawChatMessage])
    {
        guard !isDelta else { return }
        if replacingCanonicalHistory { self.resetOlderHistory() }
        let pageIDs = Set(page.map(\.id))
        let pageSources = Set(page.compactMap(Self.historySourceIdentity(for:)))
        let isOnPage = { (message: OpenClawChatMessage) in
            pageIDs.contains(message.id) ||
                Self.historySourceIdentity(for: message).map { pageSources.contains($0) } ?? false
        }
        let retained = self.messages.filter { self.olderHistoryMessageIDs.contains($0.id) && !isOnPage($0) }
        let retainedIDs = Set(retained.map(\.id))
        if let lastKept = self.messages.lastIndex(where: { retainedIDs.contains($0.id) }) {
            // An empty page is incomplete, not evidence of a gap.
            let reachesKeptRows = page.isEmpty || self.messages.firstIndex(where: isOnPage)
                .map { $0 <= lastKept + 1 } ?? false
            if reachesKeptRows {
                self.olderHistoryMessageIDs = retainedIDs
                // Local-row retention may already have placed some of them; older rows lead the transcript.
                nextMessages = retained + nextMessages.filter { !retainedIDs.contains($0.id) }
                return
            }
            // Rows between the kept pages and this page left the newest window and no cursor
            // reaches them; restart paging from this page.
            self.resetOlderHistory()
            nextMessages.removeAll { retainedIDs.contains($0.id) }
        }
        self.olderHistoryMessageIDs = []
        self.historyOlderCursor = payload.hasMore == false ? nil : payload.olderCursor
    }

    func resetOlderHistory() {
        self.olderHistoryLoad?.task.cancel()
        self.olderHistoryLoad = nil
        self.historyOlderCursor = nil
        self.isLoadingOlderHistory = false
        self.olderHistoryLoadFailed = false
        self.olderHistoryMessageIDs = []
    }
}
