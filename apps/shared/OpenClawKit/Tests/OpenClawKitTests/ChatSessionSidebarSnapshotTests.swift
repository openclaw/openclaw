import Testing
@testable import OpenClawChatUI

struct ChatSessionSidebarSnapshotTests {
    @Test func `complete session snapshots replace metadata and fence retained observer state`() throws {
        var previous = OpenClawChatSessionEntry(key: "agent:main:work", updatedAt: 100)
        previous.kind = "direct"
        previous.sessionId = "work-id"
        previous.label = "Old label"
        previous.status = "running"
        previous.activeRunIds = ["run-1"]
        previous.observerDigest = .init(
            runId: "run-1", revision: 4, updatedAt: 400, headline: "Live", health: "grinding")
        var row = previous
        row.label = "New label"
        row.category = "Research"
        row.pinned = true
        row.observerDigest = nil
        let changed = try #require(ChatSessionSidebarModel.applying(
            sessionChange: .init(sessionKey: row.key, session: row), to: [previous]))
        #expect(changed[0].label == "New label")
        #expect(changed[0].category == "Research")
        #expect(changed[0].pinned == true)
        #expect(changed[0].observerDigest?.headline == "Live")

        row.status = "completed"
        row.hasActiveRun = false
        row.activeRunIds = []
        let completed = try #require(ChatSessionSidebarModel.applying(
            sessionChange: .init(sessionKey: row.key, session: row), to: changed))
        #expect(completed[0].observerDigest == nil)
        row.sessionId = "replacement-id"
        row.status = "running"
        row.activeRunIds = ["run-1"]
        let replacement = try #require(ChatSessionSidebarModel.applying(
            sessionChange: .init(sessionKey: row.key, session: row), to: changed))
        #expect(replacement[0].observerDigest == nil)
        row.activeRunIds = nil
        let unavailable = try #require(ChatSessionSidebarModel.applying(
            sessionChange: .init(sessionKey: row.key, session: row), to: changed))
        #expect(unavailable[0].activeRunIds == nil)
        #expect(unavailable[0].observerDigest == nil)
    }

    @Test func `global snapshots reject foreign observer digests`() throws {
        var previous = OpenClawChatSessionEntry(
            key: "global", kind: "direct", agentId: "main", updatedAt: 100, sessionId: "global-id")
        previous.status = "running"
        previous.activeRunIds = ["run-1"]
        previous.observerDigest = .init(
            agentId: "main", runId: "run-1", revision: 4, updatedAt: 400, headline: "Main", health: "grinding")
        var row = previous
        row.agentId = "work"
        row.observerDigest = nil
        let changed = try #require(ChatSessionSidebarModel.applying(
            sessionChange: .init(sessionKey: row.key, agentId: "work", session: row),
            to: [previous],
            activeAgentId: "work"))
        #expect(changed[0].agentId == "work")
        #expect(changed[0].observerDigest == nil)
    }

    @Test func `global row snapshots clear a digest from a foreign owner`() throws {
        var previous = OpenClawChatSessionEntry(
            key: "global", kind: "direct", agentId: "main", updatedAt: 100, sessionId: "global-id")
        previous.status = "running"
        previous.activeRunIds = ["run-1"]
        var row = previous
        row.observerDigest = .init(
            agentId: "other", runId: "run-1", revision: 4, updatedAt: 400, headline: "Foreign", health: "grinding")
        let changed = try #require(ChatSessionSidebarModel.applying(
            sessionChange: .init(sessionKey: row.key, agentId: "main", session: row),
            to: [previous],
            activeAgentId: "main"))
        #expect(changed[0].observerDigest == nil)
    }
}
