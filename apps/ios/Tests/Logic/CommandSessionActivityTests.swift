import Foundation
import OpenClawChatUI
import Testing

@MainActor
struct CommandSessionActivityTests {
    private let now = Date(timeIntervalSince1970: 1000)

    @Test func `filters count conversations and retain independent work and attention states`() throws {
        let sessions = try self.sessions("""
        [
          {"key":"agent:main:review","status":"running","hasActiveRun":true},
          {"key":"agent:main:queued","status":"queued"},
          {"key":"agent:main:finished","status":"done","hasActiveRun":true},
          {"key":"agent:main:inactive","status":"running","hasActiveRun":false},
          {"key":"agent:main:parent","status":"done","hasActiveSubagentRun":true},
          {"key":"agent:main:archived","archived":true,"hasActiveRun":true},
          {"key":"agent:main:idle"}
        ]
        """)
        let requests = [
            self.request("first", session: "agent:main:review", count: 2),
            self.request("second", session: "agent:main:review"),
            self.request("expired", session: "agent:main:idle", expiresAtMs: 1_000_000),
            self.request("archived", session: "agent:main:archived"),
        ]
        let snapshot = self.snapshot(sessions, requests: requests)
        #expect(snapshot.sessions(matching: .all).map(\.key) == sessions.map(\.key))
        #expect(snapshot.sessions(matching: .needsYou).map(\.key) == ["agent:main:review"])
        #expect(snapshot.sessions(matching: .working).map(\.key) == [
            "agent:main:review", "agent:main:queued", "agent:main:parent",
        ])
        #expect(snapshot.countText(for: .needsYou) == "1")
        #expect(snapshot.attention(for: sessions[0])?.count == 3)
    }

    @Test func `resolution expiry and agent identity control attention membership`() throws {
        let sessions = try self.sessions("""
        [{"key":"agent:main:review"},{"key":"agent:other:review"}]
        """)
        let request = self.request("approval", session: "agent:main:review", kind: .approval)
        let pending = self.snapshot(sessions, requests: [request])
        #expect(pending.sessions(matching: .needsYou).map(\.key) == ["agent:main:review"])
        #expect(pending.attention(for: sessions[0])?.kind == .approval)
        let expired = self.snapshot(sessions, requests: [request], now: Date(timeIntervalSince1970: 2000))
        #expect(expired.sessions(matching: .needsYou).isEmpty)
        let resolved = self.snapshot(sessions, requests: [])
        #expect(resolved.sessions(matching: .needsYou).isEmpty)
    }

    @Test func `offline and incomplete rosters do not claim complete live counts`() throws {
        let sessions = try self.sessions("""
        [{"key":"agent:main:review","status":"running"}]
        """)
        let request = self.request("question", session: "agent:main:review")
        let partial = self.snapshot(sessions, requests: [request], complete: false)
        #expect(partial.countText(for: .all) == "1+")
        #expect(partial.countText(for: .needsYou) == "1+")
        #expect(partial.countText(for: .working) == "1+")
        let offline = self.snapshot(sessions, requests: [request], connected: false, complete: false)
        #expect(offline.sessions(matching: .all).map(\.key) == ["agent:main:review"])
        #expect(offline.sessions(matching: .needsYou).isEmpty)
        #expect(offline.sessions(matching: .working).isEmpty)
        #expect(offline.countText(for: .needsYou) == "—")
        #expect(offline.countText(for: .working) == "—")
    }

    private func sessions(_ json: String) throws -> [OpenClawChatSessionEntry] {
        try JSONDecoder().decode([OpenClawChatSessionEntry].self, from: Data(json.utf8))
    }

    private func request(
        _ id: String,
        session: String,
        kind: OpenClawChatAttentionRequest.Kind = .question,
        count: Int = 1,
        expiresAtMs: Double = 2_000_000) -> OpenClawChatAttentionRequest
    {
        OpenClawChatAttentionRequest(
            id: id,
            kind: kind,
            sessionKey: session,
            agentID: "main",
            createdAtMs: 900_000,
            expiresAtMs: expiresAtMs,
            preview: "Choose the next step",
            count: count)
    }

    private func snapshot(
        _ sessions: [OpenClawChatSessionEntry],
        requests: [OpenClawChatAttentionRequest],
        connected: Bool = true,
        complete: Bool = true,
        now: Date? = nil) -> CommandSessionActivitySnapshot
    {
        CommandSessionActivitySnapshot(
            sessions: sessions,
            requests: requests,
            mainSessionKey: "main",
            activeAgentID: "main",
            sessionRoutingContract: nil,
            isConnected: connected,
            isComplete: complete,
            now: now ?? self.now)
    }
}
