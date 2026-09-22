import Foundation
import Testing
@testable import OpenClawChatUI

private struct SidebarPreviewTransport: OpenClawChatTransport {
    func requestHistory(sessionKey: String) async throws -> OpenClawChatHistoryPayload {
        .init(sessionKey: sessionKey, sessionId: nil, messages: [], thinkingLevel: "off")
    }

    func sendMessage(
        sessionKey _: String, message _: String, thinking _: String,
        idempotencyKey: String, attachments _: [OpenClawChatAttachmentPayload]) async throws -> OpenClawChatSendResponse
    {
        .init(runId: idempotencyKey, status: "ok")
    }

    func requestHealth(timeoutMs _: Int) async throws -> Bool {
        false
    }

    func events() -> AsyncStream<OpenClawChatTransportEvent> {
        AsyncStream { $0.finish() }
    }
}

private actor SidebarPreviewCache: OpenClawChatTranscriptCache {
    let text: String
    private var released: Bool
    private var continuation: CheckedContinuation<Void, Never>?
    private(set) var requests: [(String, String?)] = []

    init(text: String, held: Bool = false) {
        self.text = text
        self.released = !held
    }

    func release() {
        self.released = true
        self.continuation?.resume()
        self.continuation = nil
    }

    func loadTranscript(sessionKey: String, agentID: String?) async -> [OpenClawChatMessage] {
        self.requests.append((sessionKey, agentID))
        if !self.released { await withCheckedContinuation { self.continuation = $0 } }
        return [.init(role: "assistant", content: [
            .init(type: "text", text: self.text, mimeType: nil, fileName: nil, content: nil),
        ], timestamp: 1)]
    }

    func loadTranscript(sessionKey: String) async -> [OpenClawChatMessage] {
        await self.loadTranscript(sessionKey: sessionKey, agentID: nil)
    }

    func loadSessions() async -> [OpenClawChatSessionEntry] {
        []
    }

    func storeSessions(_: [OpenClawChatSessionEntry]) async {}
    func storeCanonicalTranscript(
        sessionKey _: String, agentID _: String?, messages _: [OpenClawChatMessage],
        canonicalMessageIdempotencyKeys _: Set<String>) async {}
}

@MainActor
struct ChatSessionSidebarPreviewsTests {
    @Test(arguments: [false, true])
    func `changing Gateway owners never reuses an identical session preview`(oldLoadPending: Bool) async throws {
        let suite = "ChatSessionSidebarPreviewsTests.\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suite))
        let first = self.model(defaults: defaults)
        let second = self.model(defaults: defaults)
        defer {
            first.detachTransport()
            second.detachTransport()
            defaults.removePersistentDomain(forName: suite)
        }
        let row = self.row(key: "global")
        let firstRequest = ChatSessionSidebarPreviews.Request(viewModel: first, sessions: [row])
        let secondRequest = ChatSessionSidebarPreviews.Request(viewModel: second, sessions: [row])
        let store = ChatSessionSidebarPreviews()
        let old = SidebarPreviewCache(text: "Gateway A", held: oldLoadPending)
        let next = SidebarPreviewCache(text: "Gateway B", held: !oldLoadPending)
        if oldLoadPending {
            let pending = Task { await store.refresh(firstRequest, cache: old) }
            try await waitUntil("old cache read starts") { await old.requests.count == 1 }
            await store.refresh(secondRequest, cache: next)
            await old.release()
            await pending.value
        } else {
            await store.refresh(firstRequest, cache: old)
            #expect(store.text(for: row, in: firstRequest) == "Gateway A")
            let pending = Task { await store.refresh(secondRequest, cache: next) }
            try await waitUntil("new cache read starts") { await next.requests.count == 1 }
            #expect(store.text(for: row, in: secondRequest) == nil)
            await next.release()
            await pending.value
        }
        #expect(store.text(for: row, in: secondRequest) == "Gateway B")
        #expect(store.text(for: row, in: firstRequest) == nil)
    }

    @Test func `preview reads are bounded and retain the selected global owner`() async throws {
        let suite = "ChatSessionSidebarPreviewsTests.\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suite))
        let model = self.model(defaults: defaults)
        defer {
            model.detachTransport()
            defaults.removePersistentDomain(forName: suite)
        }
        let rows = [self.row(key: "global")] + (0..<60).map { self.row(key: "agent:research:thread-\($0)") }
        let request = ChatSessionSidebarPreviews.Request(viewModel: model, sessions: rows)
        let cache = SidebarPreviewCache(text: "Preview")
        let store = ChatSessionSidebarPreviews()
        await store.refresh(request, cache: cache)
        let calls = await cache.requests
        #expect(calls.count == 32)
        #expect(calls.first?.0 == "global")
        #expect(calls.first?.1 == "research")
        #expect(calls.dropFirst().allSatisfy { $0.1 == nil })
        #expect(try store.text(for: #require(rows.last), in: request) == nil)
    }

    private func model(defaults: UserDefaults) -> OpenClawChatViewModel {
        OpenClawChatViewModel(
            sessionKey: "global", transport: SidebarPreviewTransport(), activeAgentId: "research",
            modelPickerStore: ChatModelPickerStore(defaults: defaults))
    }

    private func row(key: String) -> OpenClawChatSessionEntry {
        var row = OpenClawChatSessionEntry.placeholder(key: key)
        row.agentId = "research"
        row.sessionId = "same-session"
        row.updatedAt = 1
        return row
    }
}
