import Foundation
import OpenClawChatUI
import OpenClawProtocol
import Testing
@testable import OpenClaw

struct ChatInfoEnvironmentTests {
    @Test func `catalog asks only for assistant outputs from the chosen chat`() throws {
        let query = ChatInfoVisit.mediaQuery(for: .init(sessionKey: "agent:ink:main", agentID: "ink"))
        let bytes = try JSONEncoder().encode(query)
        let fields = try #require(JSONSerialization.jsonObject(with: bytes) as? [String: String])
        #expect(fields == ["sessionKey": "agent:ink:main", "agentId": "ink", "messageRole": "assistant"])
    }

    @Test func `the agent profile never offers Archive`() {
        let row = OpenClawChatSessionEntry(key: "agent:molty:brief", sessionId: "test-chat")
        #expect(ChatInfoVisit.offersArchive(isProfile: false, session: row, mainSessionKey: "main"))
        #expect(!ChatInfoVisit.offersArchive(isProfile: true, session: row, mainSessionKey: "main"))
    }

    @Test func `checkout counts come only from a ready summary and omit zero sides`() {
        func summary(
            _ added: Int,
            _ removed: Int,
            computing: Bool = false,
            unavailable: Bool = false) -> SessionsDiffResult
        {
            SessionsDiffResult(
                sessionkey: "chat",
                files: [],
                additions: added,
                deletions: removed,
                computing: computing,
                unavailablereason: unavailable ? AnyCodable("not_git") : nil)
        }
        #expect(ChatInfoCheckoutChanges(summary: summary(2280, 327)) == ChatInfoCheckoutChanges(
            additions: 2280,
            deletions: 327))
        #expect(ChatInfoCheckoutChanges(summary: summary(0, 3))?.additions == nil)
        #expect(ChatInfoCheckoutChanges(summary: summary(0, 0)) == nil)
        #expect(ChatInfoCheckoutChanges(summary: summary(8, 2, computing: true)) == nil)
        #expect(ChatInfoCheckoutChanges(summary: summary(8, 2, unavailable: true)) == nil)
    }

    @Test func `plain workspace is not A project`() {
        var row = OpenClawChatSessionEntry(key: "chat")
        row.workspaceDir = "/workspaces/molty"
        row.spawnedCwd = "/workspaces/molty"
        #expect(ChatInfoEnvironment(session: row, feedBranch: nil) == nil)
        #expect(ChatInfoEnvironment(session: row, feedBranch: "review")?.branch == "review")
    }

    @Test func `repository and worktree remain distinct`() {
        var row = OpenClawChatSessionEntry(key: "chat")
        row.repository = ["url": AnyCodable("https://example.test/demo/notes.git"), "branch": AnyCodable("main")]
        #expect(ChatInfoEnvironment(session: row, feedBranch: nil)?.project == "notes")
        #expect(ChatInfoEnvironment(session: row, feedBranch: nil)?.worktree == false)
        row.worktree = .init(id: "one", branch: "fix/preview", repoRoot: "/projects/notes")
        row.projectId = "review-notes"
        let checkout = ChatInfoEnvironment(session: row, feedBranch: "old")
        #expect(checkout?.project == "review-notes")
        #expect(checkout?.branch == "main")
        #expect(checkout?.worktree == true)
    }
}
