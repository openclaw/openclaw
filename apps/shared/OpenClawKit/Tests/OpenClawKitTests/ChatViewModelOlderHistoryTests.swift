import Foundation
import OpenClawKit
import Testing
@testable import OpenClawChatUI

private actor OlderHistoryCursorLog {
    private(set) var cursors: [String] = []
    private var newestReads = 0

    func append(_ cursor: String) {
        self.cursors.append(cursor)
    }

    func nextNewestRead() -> Int {
        defer { self.newestReads += 1 }
        return self.newestReads
    }
}

/// Holds older-page reads in flight until the test releases them.
private actor OlderHistoryGate {
    private var isOpen = false
    private var waiters: [CheckedContinuation<Void, Never>] = []

    func wait() async {
        guard !self.isOpen else { return }
        await withCheckedContinuation { self.waiters.append($0) }
    }

    func open() {
        self.isOpen = true
        self.waiters.forEach { $0.resume() }
        self.waiters = []
    }
}

private func historyRow(_ text: String, id: String? = nil, seq: Int) -> AnyCodable {
    var metadata: [String: Any] = ["seq": seq]
    if let id { metadata["id"] = id }
    return AnyCodable([
        "role": "assistant",
        "content": [["type": "text", "text": text]],
        "timestamp": Double(seq * 1000),
        "__openclaw": metadata,
    ])
}

private func historyPage(
    _ messages: [AnyCodable],
    olderCursor: String? = nil,
    hasMore: Bool? = nil) -> OpenClawChatHistoryPayload
{
    OpenClawChatHistoryPayload(
        sessionKey: "main",
        sessionId: "sess-main",
        messages: messages,
        thinkingLevel: "off",
        olderCursor: olderCursor,
        hasMore: hasMore ?? (olderCursor != nil))
}

struct ChatViewModelOlderHistoryTests {
    /// `newest` answers newest-page reads in order (the last one repeats); `older` answers cursor reads.
    @MainActor
    private func fixture(
        newest: [OpenClawChatHistoryPayload],
        older: [String: OpenClawChatHistoryPayload],
        gate: OlderHistoryGate? = nil) -> (OlderHistoryCursorLog, OpenClawChatViewModel)
    {
        let log = OlderHistoryCursorLog()
        let transport = TestChatTransport(historyResponses: [], historyCursorHook: { _, cursor in
            guard let cursor else {
                let read = await log.nextNewestRead()
                return newest[min(read, newest.count - 1)]
            }
            await log.append(cursor)
            await gate?.wait()
            guard let page = older[cursor] else { throw URLError(.badServerResponse) }
            return page
        })
        return (log, OpenClawChatViewModel(sessionKey: "main", transport: transport))
    }

    @MainActor
    private static func texts(_ model: OpenClawChatViewModel) -> [String] {
        model.messages.flatMap { $0.content.compactMap(\.text) }
    }

    @Test @MainActor
    func `older page uses the returned cursor and prepends in order without duplicates`() async {
        let (log, model) = self.fixture(
            newest: [historyPage(
                [historyRow("three", id: "m3", seq: 3), historyRow("four", seq: 4)],
                olderCursor: "page-1")],
            older: [
                "page-1": historyPage(
                    [
                        historyRow("one", id: "m1", seq: 1),
                        historyRow("two", seq: 2),
                        // Overlap with the loaded page: by `__openclaw.id`, else by `__openclaw.seq`.
                        historyRow("three", id: "m3", seq: 3),
                        historyRow("four", seq: 4),
                    ],
                    hasMore: false),
            ])
        defer { model.detachTransport() }
        #expect(await model.refreshHistoryAfterRun().applied)
        #expect(model.historyOlderCursor == "page-1")

        #expect(await model.loadOlderHistory())

        #expect(await log.cursors == ["page-1"])
        #expect(Self.texts(model) == ["one", "two", "three", "four"])
        #expect(model.historyOlderCursor == nil)
        #expect(await !(model.loadOlderHistory()))
        #expect(await log.cursors == ["page-1"])
    }

    @Test @MainActor
    func `reading position is recorded before older rows are published`() async {
        let (_, model) = self.fixture(
            newest: [historyPage([historyRow("two", id: "m2", seq: 2)], olderCursor: "page-1")],
            older: ["page-1": historyPage([historyRow("one", id: "m1", seq: 1)], hasMore: false)])
        defer { model.detachTransport() }
        #expect(await model.refreshHistoryAfterRun().applied)
        let observed = ObservedTranscripts()
        model.olderHistoryWillPrepend = { observed.texts.append(Self.texts(model)) }

        #expect(await model.loadOlderHistory())

        #expect(observed.texts == [["two"]])
        #expect(Self.texts(model) == ["one", "two"])
    }

    @MainActor
    private final class ObservedTranscripts {
        var texts: [[String]] = []
    }

    @Test @MainActor
    func `newest page refresh keeps prepended rows and their boundary`() async {
        let (log, model) = self.fixture(
            newest: [historyPage([historyRow("three", id: "m3", seq: 3)], olderCursor: "page-1")],
            older: [
                "page-1": historyPage([historyRow("two", id: "m2", seq: 2)], olderCursor: "page-2"),
            ])
        defer { model.detachTransport() }
        #expect(await model.refreshHistoryAfterRun().applied)
        #expect(await model.loadOlderHistory())

        #expect(await model.refreshHistoryAfterRun().applied)

        #expect(Self.texts(model) == ["two", "three"])
        #expect(model.historyOlderCursor == "page-2")
        #expect(await log.cursors == ["page-1"])
    }

    @Test @MainActor
    func `newest page that slid past loaded rows restarts paging from its own boundary`() async {
        let (log, model) = self.fixture(
            newest: [
                historyPage(
                    [
                        historyRow("three", id: "m3", seq: 3),
                        historyRow("four", id: "m4", seq: 4),
                        historyRow("five", id: "m5", seq: 5),
                    ],
                    olderCursor: "page-1"),
                // New rows pushed "three" out of the newest window; no cursor reaches it from "two".
                historyPage(
                    [
                        historyRow("four", id: "m4", seq: 4),
                        historyRow("five", id: "m5", seq: 5),
                        historyRow("six", id: "m6", seq: 6),
                    ],
                    olderCursor: "page-3"),
            ],
            older: [
                "page-1": historyPage(
                    [historyRow("one", id: "m1", seq: 1), historyRow("two", id: "m2", seq: 2)],
                    olderCursor: "page-0"),
            ])
        defer { model.detachTransport() }
        #expect(await model.refreshHistoryAfterRun().applied)
        #expect(await model.loadOlderHistory())
        #expect(Self.texts(model) == ["one", "two", "three", "four", "five"])

        #expect(await model.refreshHistoryAfterRun().applied)

        #expect(Self.texts(model) == ["four", "five", "six"])
        #expect(model.historyOlderCursor == "page-3")
        #expect(await log.cursors == ["page-1"])
    }

    @Test @MainActor
    func `concurrent callers for one boundary share one read`() async {
        let gate = OlderHistoryGate()
        let (log, model) = self.fixture(
            newest: [historyPage([historyRow("two", id: "m2", seq: 2)], olderCursor: "page-1")],
            older: ["page-1": historyPage([historyRow("one", id: "m1", seq: 1)], hasMore: false)],
            gate: gate)
        defer { model.detachTransport() }
        #expect(await model.refreshHistoryAfterRun().applied)

        let first = Task { await model.loadOlderHistory() }
        let second = Task { await model.loadOlderHistory() }
        while await log.cursors.isEmpty {
            await Task.yield()
        }
        await gate.open()

        #expect(await first.value)
        #expect(await second.value)
        #expect(await log.cursors == ["page-1"])
        #expect(Self.texts(model) == ["one", "two"])
    }

    @Test @MainActor
    func `session switch drops an in-flight older page and clears the boundary`() async {
        let gate = OlderHistoryGate()
        let (log, model) = self.fixture(
            newest: [historyPage([historyRow("two", id: "m2", seq: 2)], olderCursor: "page-1")],
            older: ["page-1": historyPage([historyRow("one", id: "m1", seq: 1)], hasMore: false)],
            gate: gate)
        defer { model.detachTransport() }
        #expect(await model.refreshHistoryAfterRun().applied)
        let load = Task { await model.loadOlderHistory() }
        while await log.cursors.isEmpty {
            await Task.yield()
        }

        model.switchSession(to: "other")

        #expect(model.historyOlderCursor == nil)
        #expect(!model.isLoadingOlderHistory)
        await gate.open()
        #expect(await !(load.value))
        #expect(!Self.texts(model).contains("one"))
    }

    @Test @MainActor
    func `same older boundary returned twice stops paging`() async {
        let (log, model) = self.fixture(
            newest: [historyPage([historyRow("two", id: "m2", seq: 2)], olderCursor: "page-1")],
            older: [
                "page-1": historyPage([historyRow("one", id: "m1", seq: 1)], olderCursor: "page-1"),
            ])
        defer { model.detachTransport() }
        #expect(await model.refreshHistoryAfterRun().applied)

        #expect(await !(model.loadOlderHistory()))
        #expect(await !(model.loadOlderHistory()))

        #expect(await log.cursors == ["page-1"])
        #expect(model.historyOlderCursor == nil)
        #expect(Self.texts(model) == ["two"])
    }

    @Test @MainActor
    func `failed older page offers a retry that reuses the cursor`() async {
        let (log, model) = self.fixture(
            newest: [historyPage([historyRow("two", id: "m2", seq: 2)], olderCursor: "missing")],
            older: [:])
        defer { model.detachTransport() }
        #expect(await model.refreshHistoryAfterRun().applied)

        #expect(await !(model.loadOlderHistory()))

        #expect(model.olderHistoryLoadFailed)
        #expect(model.historyOlderCursor == "missing")
        #expect(await !(model.loadOlderHistory()))
        #expect(await log.cursors == ["missing", "missing"])
    }
}
