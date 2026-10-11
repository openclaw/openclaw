import Foundation
import OpenClawProtocol
import Testing
@testable import OpenClawChatUI

struct ChatSessionGroupCatalogTests {
    @Test func `catalog order wins and local names do not leak into a different Gateway`() {
        let names = OpenClawChatSessionGroupCatalog.names(
            catalog: [.init(name: "Zulu", position: 0), .init(name: "Alpha", position: 1)],
            local: ["Private local group"],
            sessions: [.init(key: "orphan", category: "Uncataloged"), .init(key: "z", category: "Zulu")])
        #expect(names == ["Zulu", "Alpha", "Uncataloged"])
        #expect(!names.contains("Private local group"))
        #expect(OpenClawChatSessionGroupCatalog.names(catalog: [], local: ["Private"], sessions: []).isEmpty)
    }

    @Test func `legacy fallback retains empty local groups and normalizes memberships`() {
        #expect(OpenClawChatSessionGroupCatalog.names(
            catalog: nil,
            local: ["Zulu", "", "Zulu", " Alpha "],
            sessions: [.init(key: "b", category: "Beta"), .init(key: "z", category: "Zulu")]) ==
            ["Zulu", "Alpha", "Beta"])
    }

    @Test func `reorder only moves one neighbor and preserves all names`() {
        let names = ["Zulu", "Alpha", "Beta"]
        #expect(OpenClawChatSessionGroupCatalog.moving("Alpha", by: -1, in: names) == ["Alpha", "Zulu", "Beta"])
        #expect(OpenClawChatSessionGroupCatalog.moving("Alpha", by: 1, in: names) == ["Zulu", "Beta", "Alpha"])
        #expect(OpenClawChatSessionGroupCatalog.moving("Zulu", by: -1, in: names) == names)
        #expect(OpenClawChatSessionGroupCatalog.moving("Beta", by: 1, in: names) == names)
        #expect(OpenClawChatSessionGroupCatalog.moving("Missing", by: 1, in: names) == names)
    }

    @Test func `grouped create carries category and explicit saved placement defaults`() {
        let request = OpenClawChatGatewayRequests.createSession(
            key: "agent:main:dashboard:new",
            agentID: "main",
            label: nil,
            parentSessionKey: nil,
            worktree: true,
            category: "Research",
            cwd: "/work/repo")
        #expect(request.method == "sessions.create")
        #expect(request.params["category"]?.value as? String == "Research")
        #expect(request.params["worktree"]?.value as? Bool == true)
        #expect(request.params["cwd"]?.value as? String == "/work/repo")
    }

    @Test @MainActor func `group connection gates individual advertised methods and stale routes`() async throws {
        var current = true
        let connection = OpenClawSessionMenuConnection(
            methods: ["sessions.groups.list", "sessions.groups.rename"],
            scopes: ["operator.read"],
            isCurrent: { current },
            request: { _ in Data() })
        #expect(connection.allows("sessions.groups.list", scope: "operator.read"))
        #expect(!connection.allows("sessions.groups.rename"))
        #expect(!connection.allows("sessions.groups.update"))
        current = false
        #expect(!connection.allows("sessions.groups.list", scope: "operator.read"))
        await #expect(throws: CancellationError.self) { try await connection.request(.init(
            method: "sessions.groups.list",
            timeoutMs: 15000)) }
    }
}
