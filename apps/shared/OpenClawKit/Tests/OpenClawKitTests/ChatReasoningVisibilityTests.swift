import Foundation
import Testing
@testable import OpenClawChatUI

@MainActor
struct ChatReasoningVisibilityTests {
    private func decode<T: Decodable>(_ json: String, as _: T.Type = T.self) throws -> T {
        try JSONDecoder().decode(T.self, from: Data(json.utf8))
    }

    private func row(_ level: String?, key: String = "main", updatedAt: Int = 1) throws
        -> OpenClawChatSessionEntry
    {
        let field = level.map { ",\"reasoningLevel\":\"\($0)\"" } ?? ""
        return try self.decode("{\"key\":\"\(key)\",\"updatedAt\":\(updatedAt)\(field)}")
    }

    private func history(_ level: String?) throws -> OpenClawChatHistoryPayload {
        let field = level.map { ",\"reasoningLevel\":\"\($0)\"" } ?? ""
        return try self.decode("""
        {"sessionKey":"main","messages":[],"sessionInfo":{"key":"main","hasActiveRun":false\(field)}}
        """)
    }

    private func model(sidebar: Bool = false, responses: [OpenClawChatSessionsListResponse] = [])
        -> OpenClawChatViewModel
    {
        let viewModel = OpenClawChatViewModel(
            sessionKey: "main",
            transport: TestChatTransport(historyResponses: [], sessionsResponses: responses))
        if sidebar { viewModel.enableSidebarData() }
        return viewModel
    }

    @Test func `only on enables reasoning and exact session beats its alias`() throws {
        let viewModel = self.model()
        defer { viewModel.detachTransport() }
        for level in [nil, "off", "stream", "on"] as [String?] {
            viewModel.sessions = try [self.row(level)]
            #expect(viewModel.currentSessionReasoningVisible == (level == "on"))
        }
        viewModel.sessions = try [
            self.row("off", key: "agent:main:main"),
            self.row("on"),
        ]
        #expect(viewModel.currentSessionReasoningVisible)
    }

    @Test(arguments: [false, true])
    func `accepted history updates visibility despite run snapshot invalidation`(sidebar: Bool) throws {
        let viewModel = self.model(sidebar: sidebar)
        defer { viewModel.detachTransport() }
        viewModel.sessions = try [self.row("off")]
        let request = viewModel.beginHistoryRequest()
        viewModel.invalidateRunSnapshots()
        #expect(try viewModel.applyHistoryPayload(
            self.history("on"), for: request, preservingOptimisticLocalMessages: false))
        #expect(viewModel.currentSessionReasoningVisible)
        #expect(viewModel.currentSessionEntry()?.reasoningLevel == "on")

        viewModel.sessions = []
        #expect(try viewModel.applyHistoryPayload(
            self.history("off"),
            for: viewModel.beginHistoryRequest(),
            preservingOptimisticLocalMessages: false))
        #expect(!viewModel.currentSessionReasoningVisible)
        #expect(try viewModel.applyHistoryPayload(
            self.history("on"),
            for: viewModel.beginHistoryRequest(),
            preservingOptimisticLocalMessages: false))
        #expect(try viewModel.applyHistoryPayload(
            self.history(nil),
            for: viewModel.beginHistoryRequest(),
            preservingOptimisticLocalMessages: false))
        #expect(viewModel.currentSessionReasoningVisible)
    }

    @Test(arguments: [false, true])
    func `roster eviction preserves reasoning but a complete unknown row clears it`(sidebar: Bool) async throws {
        let omitted: OpenClawChatSessionsListResponse = try self.decode(#"{"sessions":[{"key":"other"}]}"#)
        let unknown: OpenClawChatSessionsListResponse = try self.decode(#"{"sessions":[{"key":"main"}]}"#)
        let viewModel = self.model(sidebar: sidebar, responses: [omitted, unknown, omitted])
        defer { viewModel.detachTransport() }
        viewModel.sessions = try [self.row("on")]

        await viewModel.fetchSessions(limit: 50)
        #expect(viewModel.currentSessionEntry() == nil)
        #expect(viewModel.currentSessionReasoningVisible)
        await viewModel.fetchSessions(limit: 50)
        #expect(viewModel.currentSessionEntry() != nil)
        #expect(!viewModel.currentSessionReasoningVisible)
        await viewModel.fetchSessions(limit: 50)
        #expect(viewModel.currentSessionEntry() == nil)
        #expect(!viewModel.currentSessionReasoningVisible)
    }

    @Test func `shared sidebar ingress updates the retained projection`() throws {
        let viewModel = self.model(sidebar: true)
        defer { viewModel.detachTransport() }
        let owner = try #require(viewModel.sidebarData)
        try owner.receive([self.row("on")], read: owner.beginRead(), replacingAgent: "")
        #expect(viewModel.currentSessionReasoningVisible)
        owner.receive([], read: owner.beginRead(), replacingAgent: "")
        #expect(viewModel.currentSessionEntry() == nil)
        #expect(viewModel.currentSessionReasoningVisible)
        try owner.receive([self.row(nil)], read: owner.beginRead(), replacingAgent: "")
        owner.receive([], read: owner.beginRead(), replacingAgent: "")
        #expect(!viewModel.currentSessionReasoningVisible)
    }

    @Test(arguments: [false, true], [false, true])
    func `patch and lifecycle reasoning events apply with or without a roster row`(
        sidebar: Bool, listed: Bool) throws
    {
        let viewModel = self.model(sidebar: sidebar)
        defer { viewModel.detachTransport() }
        viewModel.sessions = try [self.row("on")]
        if !listed { viewModel.sessions = [] }
        let patch: OpenClawChatSessionsChangedEvent = try self.decode("""
        {"sessionKey":"main","reason":"patch","session":{"key":"main","reasoningLevel":"off"}}
        """)
        viewModel.handleTransportEvent(.sessionsChanged(patch))
        #expect(!viewModel.currentSessionReasoningVisible)

        let lifecycle: OpenClawChatSessionsChangedEvent = try self.decode("""
        {"sessionKey":"main","reason":"run-progress","phase":"start","runId":"run-1",
         "session":{"key":"main","updatedAt":2,"reasoningLevel":"on"}}
        """)
        viewModel.handleTransportEvent(.sessionsChanged(lifecycle))
        #expect(viewModel.currentSessionReasoningVisible)
        let partial: OpenClawChatSessionsChangedEvent = try self.decode("""
        {"sessionKey":"main","reason":"patch","session":{"key":"main"}}
        """)
        viewModel.handleTransportEvent(.sessionsChanged(partial))
        #expect(viewModel.currentSessionReasoningVisible)
        let foreign: OpenClawChatSessionsChangedEvent = try self.decode("""
        {"sessionKey":"other","reason":"patch","session":{"key":"other","reasoningLevel":"off"}}
        """)
        viewModel.handleTransportEvent(.sessionsChanged(foreign))
        #expect(viewModel.currentSessionReasoningVisible)
    }

    @Test(arguments: [false, true], [false, true])
    func `lifecycle merge retains an omitted level and rejects stale snapshots after eviction`(
        sidebar: Bool, evicted: Bool) throws
    {
        let viewModel = self.model(sidebar: sidebar)
        defer { viewModel.detachTransport() }
        viewModel.sessions = try [self.row("off")]
        let on: OpenClawChatSessionsChangedEvent = try self.decode("""
        {"sessionKey":"main","reason":"run-progress","phase":"start","runId":"run-1",
         "session":{"key":"main","updatedAt":2,"reasoningLevel":"on"}}
        """)
        viewModel.handleTransportEvent(.sessionsChanged(on))
        #expect(viewModel.currentSessionReasoningVisible)
        let partial: OpenClawChatSessionsChangedEvent = try self.decode("""
        {"sessionKey":"main","reason":"run-progress","phase":"end","runId":"run-1",
         "session":{"key":"main","updatedAt":3,"hasActiveRun":false}}
        """)
        viewModel.handleTransportEvent(.sessionsChanged(partial))
        #expect(viewModel.currentSessionReasoningVisible)
        if evicted { viewModel.sessions = [] }
        let stale: OpenClawChatSessionsChangedEvent = try self.decode("""
        {"sessionKey":"main","reason":"run-progress","phase":"start","runId":"older-run",
         "session":{"key":"main","updatedAt":1,"reasoningLevel":"off"}}
        """)
        viewModel.handleTransportEvent(.sessionsChanged(stale))
        viewModel.sessions = []
        #expect(viewModel.currentSessionReasoningVisible)
    }

    @Test(arguments: [false, true])
    func `evicted session retains run ownership when accepting terminal reasoning`(sidebar: Bool) throws {
        let viewModel = self.model(sidebar: sidebar)
        defer { viewModel.detachTransport() }
        viewModel.sessions = try [self.decode("""
        {"key":"main","updatedAt":3,"reasoningLevel":"off","hasActiveRun":true,"activeRunIds":["current"]}
        """)]
        viewModel.sessions = []
        for runID in ["older", "current"] {
            let terminal: OpenClawChatSessionsChangedEvent = try self.decode("""
            {"sessionKey":"main","reason":"run-progress","phase":"end","runId":"\(runID)",
             "session":{"key":"main","updatedAt":4,"reasoningLevel":"on","hasActiveRun":false}}
            """)
            viewModel.handleTransportEvent(.sessionsChanged(terminal))
            #expect(viewModel.currentSessionReasoningVisible == (runID == "current"))
        }
    }

    @Test func `session switch clears retained reasoning and rejects old history`() throws {
        let viewModel = self.model()
        defer { viewModel.detachTransport() }
        viewModel.sessions = try [self.row("on")]
        viewModel.sessions = []
        let request = viewModel.beginHistoryRequest()
        viewModel.switchSession(to: "other")
        #expect(!viewModel.currentSessionReasoningVisible)
        #expect(try !viewModel.applyHistoryPayload(
            self.history("on"), for: request, preservingOptimisticLocalMessages: false))
        #expect(!viewModel.currentSessionReasoningVisible)
    }

    @Test(arguments: [false, true])
    func `switching to a listed session retains its reasoning through eviction`(sidebar: Bool) throws {
        let viewModel = self.model(sidebar: sidebar)
        defer { viewModel.detachTransport() }
        viewModel.sessions = try [self.row("off"), self.row("on", key: "other")]
        viewModel.switchSession(to: "other")
        #expect(viewModel.currentSessionReasoningVisible)
        viewModel.sessions = []
        #expect(viewModel.currentSessionReasoningVisible)
        viewModel.switchSession(to: "unlisted")
        #expect(!viewModel.currentSessionReasoningVisible)
    }

    @Test func `session owned clear resets reasoning without a replacement row`() throws {
        let viewModel = self.model()
        defer { viewModel.detachTransport() }
        viewModel.sessions = try [self.row("on")]
        viewModel.sessions = []
        #expect(viewModel.currentSessionReasoningVisible)
        viewModel.clearSessionOwnedState()
        #expect(!viewModel.currentSessionReasoningVisible)
    }
}
