import Foundation
import OpenClawKit
import Testing
@testable import OpenClawChatUI

private func row(_ id: String) -> OpenClawChatMessage {
    OpenClawChatMessage(
        role: "assistant",
        content: [OpenClawChatMessageContent(type: "text", text: id)],
        timestamp: nil,
        transcriptMessageID: id)
}

private func page(_ ids: [String], older: String?, newer: String?) -> ChatOlderHistory.Page {
    ChatOlderHistory.Page(messages: ids.map(row), olderCursor: older, newerCursor: newer)
}

private func wireRow(_ id: String) -> AnyCodable {
    AnyCodable([
        "role": "assistant",
        "content": [["type": "text", "text": id]],
        "timestamp": 1,
        "__openclaw": ["id": id],
    ])
}

private func texts(_ messages: [OpenClawChatMessage]) -> [String] {
    messages.map { $0.transcriptMessageID ?? "" }
}

/// Each full tip read moves the tip forward one row and returns its new boundary.
private actor TipScript {
    private var reads = 0

    func next(_ key: String) -> OpenClawChatHistoryPayload {
        self.reads += 1
        return OpenClawChatHistoryPayload(
            sessionKey: key,
            sessionId: "sess-\(key)",
            messages: [wireRow("tip-\(self.reads)")],
            thinkingLevel: "off",
            olderCursor: "boundary-\(self.reads)")
    }
}

struct ChatOlderHistoryTests {
    @Test func `history payload decodes page boundaries`() throws {
        let payload = try JSONDecoder().decode(OpenClawChatHistoryPayload.self, from: Data("""
        {"sessionKey":"main","messages":[],"olderCursor":"history-page:o","newerCursor":"history-page:n","windowReset":true}
        """.utf8))
        #expect(payload.olderCursor == "history-page:o")
        #expect(payload.newerCursor == "history-page:n")
        #expect(payload.windowReset == true)
    }

    @Test func `an earlier page meets the tip and keeps meeting it when the tip slides`() {
        let tip = ["t1", "t2", "t3"].map(row)
        var history = ChatOlderHistory().replacingTip(previous: [], next: tip, olderCursor: "tip-older")
        #expect(history.cursor(.older) == "tip-older")
        history.admit(page(["o1", "o2"], older: "o-older", newer: "o-newer"), .older, tip: tip)
        #expect(texts(history.presentation(tail: tip)) == ["o1", "o2", "t1", "t2", "t3"])

        // A full tip read trimmed t1: it joins the newest page instead of leaving a gap.
        let slid = Array(tip.dropFirst()) + [row("t4")]
        history = history.replacingTip(previous: tip, next: slid, olderCursor: "tip-older-2")
        #expect(texts(history.presentation(tail: slid)) == ["o1", "o2", "t1", "t2", "t3", "t4"])
        #expect(history.cursor(.older) == "o-older")
        // A reader snapshot still showing t1 under another row ID shows it once.
        #expect(texts(history.presentation(tail: [row("t1")] + slid)) == ["o1", "o2", "t1", "t2", "t3", "t4"])

        // A tip that no longer reaches the pages cannot be stitched to them.
        history = history.replacingTip(previous: slid, next: [row("t9")], olderCursor: "tip-older-3")
        #expect(history.pages.isEmpty)
        #expect(history.cursor(.older) == "tip-older-3")
    }

    @Test func `the window keeps three pages and rereads the ones it dropped`() {
        let tip = ["t1", "t2"].map(row)
        var history = ChatOlderHistory().replacingTip(previous: [], next: tip, olderCursor: "before-tip")
        for index in 1...4 {
            history.admit(page(["p\(index)"], older: "before-p\(index)", newer: "after-p\(index)"), .older, tip: tip)
        }
        // Reading up past three pages drops the newest one and leaves the tip.
        #expect(history.pages.count == ChatOlderHistory.maxResidentPages)
        #expect(history.isDetached)
        #expect(texts(history.presentation(tail: tip)) == ["p4", "p3", "p2"])
        #expect(history.cursor(.newer) == "after-p2")

        // Reading back down rereads p1 and drops p4, which the oldest page's boundary rereads.
        history.admit(page(["p1"], older: "before-p1", newer: "after-p1"), .newer, tip: tip)
        #expect(texts(history.presentation(tail: tip)) == ["p3", "p2", "p1"])
        #expect(history.cursor(.older) == "before-p3")

        // The page that reaches the tip ends at the seam and reattaches the window.
        history.admit(page(["p0", "t1", "t2"], older: "before-p0", newer: nil), .newer, tip: tip)
        #expect(!history.isDetached)
        #expect(texts(history.presentation(tail: tip)) == ["p2", "p1", "p0", "t1", "t2"])
    }

    @MainActor
    private func model(pages: @escaping @Sendable (String) async throws -> OpenClawChatHistoryPayload)
        -> OpenClawChatViewModel
    {
        let transport = TestChatTransport(historyResponses: [], historyCursorHook: { key, cursor in
            guard let cursor else {
                return OpenClawChatHistoryPayload(
                    sessionKey: key,
                    sessionId: "sess-\(key)",
                    messages: [wireRow("\(key)-tip")],
                    thinkingLevel: "off",
                    olderCursor: "\(key)-older-1")
            }
            return try await pages(cursor)
        })
        return OpenClawChatViewModel(sessionKey: "main", transport: transport)
    }

    @Test @MainActor func `a page read for a replaced session is discarded`() async throws {
        let gate = OutboxTestGate()
        let model = self.model { cursor in
            await gate.wait()
            return OpenClawChatHistoryPayload(
                sessionKey: "main", sessionId: "sess-main", messages: [wireRow("stale-page")],
                thinkingLevel: "off", olderCursor: "\(cursor)-next", newerCursor: "after")
        }
        defer { model.detachTransport() }
        #expect(await model.refreshHistoryAfterRun().applied)
        model.loadHistoryPage(.older)
        let read = try #require(model.historyPageTask)
        await gate.waitUntilStarted()
        model.switchSession(to: "other")
        await gate.release()
        await read.value
        #expect(model.olderHistory.pages.isEmpty)
        #expect(model.historyPageLoading == nil)
    }

    @Test @MainActor func `a page read for a moved tip boundary is discarded without blocking the next read`() async throws {
        let gate = OutboxTestGate()
        let tips = TipScript()
        let transport = TestChatTransport(historyResponses: [], historyCursorHook: { key, cursor in
            guard let cursor else { return await tips.next(key) }
            if cursor == "boundary-1" { await gate.wait() }
            return OpenClawChatHistoryPayload(
                sessionKey: key, sessionId: "sess-\(key)", messages: [wireRow("page-\(cursor)")],
                thinkingLevel: "off", olderCursor: nil, newerCursor: "after")
        })
        let model = OpenClawChatViewModel(sessionKey: "main", transport: transport)
        defer { model.detachTransport() }
        #expect(await model.refreshHistoryAfterRun().applied)
        model.loadHistoryPage(.older)
        let stale = try #require(model.historyPageTask)
        await gate.waitUntilStarted()
        #expect(await model.refreshHistoryAfterRun().applied)
        #expect(model.olderHistory.cursor(.older) == "boundary-2")
        await gate.release()
        await stale.value
        #expect(model.olderHistory.pages.isEmpty)
        #expect(model.historyPageLoading == nil)

        model.loadHistoryPage(.older)
        await model.historyPageTask?.value
        #expect(texts(model.olderHistory.presentation(tail: model.messages)).first == "page-boundary-2")
    }

    @Test @MainActor func `a reset window ends the pages instead of reporting no older history`() async throws {
        let model = self.model { cursor in
            cursor == "main-older-1"
                ? OpenClawChatHistoryPayload(
                    sessionKey: "main", sessionId: "sess-main", messages: [wireRow("page-1")],
                    thinkingLevel: "off", olderCursor: "main-older-2", newerCursor: "after-1")
                : OpenClawChatHistoryPayload(
                    sessionKey: "main", sessionId: nil, messages: [], thinkingLevel: "off", windowReset: true)
        }
        defer { model.detachTransport() }
        #expect(await model.refreshHistoryAfterRun().applied)
        model.loadHistoryPage(.older)
        await model.historyPageTask?.value
        #expect(texts(model.olderHistory.presentation(tail: model.messages)) == ["page-1", "main-tip"])

        model.loadHistoryPage(.older)
        await model.historyPageTask?.value
        #expect(model.olderHistory.pages.isEmpty)
        #expect(model.olderHistory.cursor(.older) == nil)
        #expect(texts(model.messages) == ["main-tip"])
    }
}
