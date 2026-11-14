import Foundation

/// Transcript pages read above the live tip with the Gateway's page cursors.
///
/// Live history owns the tip: it replaces and extends its own rows and never reads these pages.
/// This owner keeps the pages contiguous with the tip, bounds how many stay resident, and drops the
/// page farthest from the reader. Pages hold decoded rows only; run, outbox and cache state stay with
/// the tip.
struct ChatOlderHistory: Equatable {
    enum Direction: Equatable {
        case older
        case newer
    }

    struct Page: Equatable {
        var messages: [OpenClawChatMessage]
        /// Reads the history just before this page; nil once the Gateway reports no older rows.
        var olderCursor: String?
        /// Rereads the history just after this page once that page was dropped.
        var newerCursor: String?
    }

    /// Native reads use the Gateway's default 200-row page (`limit ?? 200` in
    /// src/gateway/server-methods/chat-history-handler.ts), capped at 256 KiB by the iOS transport.
    /// Three resident pages keep at most 600 read rows (768 KiB of page payload) beside the tip. Rows the
    /// tip hands over while the reader is away from the live edge stay until they return, as in the tip.
    static let maxResidentPages = 3
    /// One reader action reads at most three consecutive pages that add no rows, as Control UI does
    /// (docs/web/control-ui.md); a longer hidden stretch takes another action.
    static let maxPagesPerAction = 3

    private(set) var pages: [Page] = []
    /// The latest full tip read's boundary before its first row.
    private(set) var tipOlderCursor: String?
    /// The newest resident page no longer meets the tip, so the transcript shows only the pages.
    private(set) var isDetached = false

    func cursor(_ direction: Direction) -> String? {
        switch direction {
        case .older:
            self.pages.isEmpty ? self.tipOlderCursor : self.pages[0].olderCursor
        case .newer:
            self.isDetached ? self.pages.last?.newerCursor : nil
        }
    }

    /// Resident pages, then the tip unless the window has left it.
    func presentation(tail: [OpenClawChatMessage]) -> [OpenClawChatMessage] {
        guard !self.pages.isEmpty else { return tail }
        let rows = self.pages.flatMap(\.messages)
        guard !self.isDetached else { return rows }
        // The tail can still hold rows the pages also have: rows the tip handed to the newest page, or,
        // after a detached window returns, rereads of rows a reader snapshot kept from the tip.
        let tailIDs = Set(tail.map(\.id))
        let tailTranscriptIDs = Set(tail.compactMap(\.transcriptMessageID))
        return rows.filter { row in
            !tailIDs.contains(row.id) && !(row.transcriptMessageID.map { tailTranscriptIDs.contains($0) } ?? false)
        } + tail
    }

    mutating func admit(_ page: Page, _ direction: Direction, tip: [OpenClawChatMessage]) {
        switch direction {
        case .older:
            guard !page.messages.isEmpty else {
                // An empty or hidden stretch moves the boundary without adding a page.
                if self.pages.isEmpty {
                    self.tipOlderCursor = page.olderCursor
                } else {
                    self.pages[0].olderCursor = page.olderCursor
                }
                return
            }
            self.pages.insert(page, at: 0)
            if self.pages.count > Self.maxResidentPages {
                // A reader moving up is farthest from the newest page; the page now last rereads it.
                self.pages.removeLast()
                self.isDetached = true
            }
        case .newer:
            var page = page
            // Pages are decoded apart from the tip, so they meet it by transcript identity, not row ID.
            let tipIDs = Set(tip.compactMap(\.transcriptMessageID))
            if let seam = page.messages.firstIndex(where: { message in
                message.transcriptMessageID.map { tipIDs.contains($0) } ?? false
            }) {
                page.messages.removeSubrange(seam...)
                self.isDetached = false
            } else if page.newerCursor == nil {
                self.isDetached = false
            }
            if !page.messages.isEmpty {
                self.pages.append(page)
            } else if !self.pages.isEmpty {
                self.pages[self.pages.count - 1].newerCursor = page.newerCursor
            }
            if self.pages.count > Self.maxResidentPages {
                // A reader moving down is farthest from the oldest page; the page now first rereads it.
                self.pages.removeFirst()
            }
        }
    }

    /// A full tip read can move the tip's first row. Rows it trimmed join the newest page so the pages
    /// still meet the tip; a tip that no longer reaches them ends the pages.
    func replacingTip(
        previous: [OpenClawChatMessage],
        next: [OpenClawChatMessage],
        olderCursor: String?) -> Self
    {
        var history = self
        history.tipOlderCursor = olderCursor
        guard !self.pages.isEmpty, !self.isDetached,
              let first = next.first?.id, first != previous.first?.id else { return history }
        if let trimmed = previous.firstIndex(where: { $0.id == first }) {
            history.pages[history.pages.count - 1].messages += previous[..<trimmed]
        } else {
            history.pages = []
        }
        return history
    }

    /// The reader returned to the live edge; scrolling up reads the pages again. The tip boundary stays.
    mutating func releasePages() {
        self.pages = []
        self.isDetached = false
    }
}
