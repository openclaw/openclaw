import Foundation
import OpenClawProtocol
import Testing
@testable import OpenClawChatUI

@MainActor
struct ChatSessionMenuAccessTests {
    private func connection(
        _ scopes: Set<String>,
        current: @escaping () -> Bool = { true }) -> OpenClawSessionMenuConnection
    {
        OpenClawSessionMenuConnection(
            methods: ["sessions.patch", "sessions.delete", "sessions.create", "sessions.assignOwner", "chat.history"],
            scopes: scopes, isCurrent: current, request: { _ in Data() })
    }

    @Test func `scoped session grants preserve ownership and field boundaries`() {
        var row = OpenClawChatSessionEntry(key: "agent:research:notes", sessionId: "incarnation")
        row.sharingRole = .owner
        let scoped = self.connection(["operator.sessions.write"])
        #expect(scoped.allows(.rename, session: row))
        #expect(scoped.allows(.pin, session: row))
        #expect(scoped.allows(.archive, session: row))
        #expect(scoped.allows(.markdown, session: row))
        #expect(!scoped.allows(.appearance, session: row))
        #expect(!scoped.allows(.group, session: row))
        #expect(!scoped.allows(.assignOwner, session: row))
        #expect(!scoped.allows(.delete, session: row))
        row.sharingRole = .viewer
        #expect(!scoped.allows(.rename, session: row))
        #expect(!scoped.allows(.archive, session: row))
    }

    @Test func `broad writers cannot archive another creator or delete a live row`() {
        var row = OpenClawChatSessionEntry(key: "agent:research:notes", sessionId: "incarnation")
        row.sharingRole = .member
        let writer = self.connection(["operator.write"])
        #expect(writer.allows(.rename, session: row))
        #expect(!writer.allows(.archive, session: row))
        #expect(!writer.allows(.delete, session: row))
        row.archived = true
        #expect(writer.allows(.delete, session: row))
        let admin = self.connection(["operator.admin"])
        #expect(admin.allows(.archive, session: row))
        row.sessionId = nil
        #expect(!admin.allows(.archive, session: row))
        #expect(!admin.allows(.snooze, session: row))
    }

    @Test func `retired menu authority cannot dispatch or publish awaited response`() async throws {
        var current = true
        var sent = 0
        let connection = OpenClawSessionMenuConnection(
            methods: ["sessions.patch"], scopes: ["operator.admin"], isCurrent: { current },
            request: { _ in sent += 1
                current = false
                return Data()
            })
        let request = OpenClawChatGatewayRequest(method: "sessions.patch", timeoutMs: 100)
        await #expect(throws: CancellationError.self) { try await connection.request(request) }
        await #expect(throws: CancellationError.self) { try await connection.request(request) }
        #expect(sent == 1)
        #expect(!connection.allows("sessions.patch"))
    }

    @Test func `row mutations retain clicked agent incarnation and archived deletion guard`() {
        var row = OpenClawChatSessionEntry(key: "agent:research:notes", sessionId: "old-incarnation")
        row.agentId = "unrelated-selected-agent"
        row.archived = true
        let request = OpenClawChatGatewayRequests.sessionMenu("sessions.delete", session: row, fields: [:])
        #expect(request.params["agentId"]?.value as? String == "research")
        #expect(request.params["expectedSessionId"]?.value as? String == "old-incarnation")
        #expect(request.params["archivedOnly"]?.value as? Bool == true)
        row.key = "global"
        row.agentId = "research"
        #expect(OpenClawChatGatewayRequests.sessionMenuTarget(row)["agentId"]?.value as? String == "research")
    }

    @Test func `bound menu rejects replacement but acknowledges its own committed removal`() async throws {
        let row = OpenClawChatSessionEntry(key: "agent:research:notes", sessionId: "captured")
        var currentID: String? = row.sessionId
        var gatewayCurrent = true
        var sent = 0
        let gateway = OpenClawSessionMenuConnection(
            methods: ["sessions.patch"], scopes: ["operator.admin"], isCurrent: { gatewayCurrent },
            request: { _ in sent += 1
                currentID = nil
                return Data("{}".utf8)
            })
        let bound = gateway.bound(to: row, isCurrent: { currentID == $0.sessionId })
        let archive = OpenClawChatGatewayRequests.sessionMenu(
            "sessions.patch", session: row, fields: ["archived": .init(true)])
        _ = try await bound.request(archive)
        #expect(sent == 1)
        #expect(!bound.isCurrent())
        currentID = "replacement"
        await #expect(throws: CancellationError.self) { try await bound.request(archive) }
        #expect(sent == 1)
        currentID = row.sessionId
        gatewayCurrent = false
        await #expect(throws: CancellationError.self) { try await bound.request(archive) }
    }

    @Test func `bound menu discards async non lifecycle results after incarnation changes`() async throws {
        let row = OpenClawChatSessionEntry(key: "agent:research:notes", sessionId: "captured")
        var currentID = "captured"
        let gateway = OpenClawSessionMenuConnection(
            methods: ["sessions.assignOwner"], scopes: ["operator.admin"], isCurrent: { true },
            request: { _ in currentID = "replacement"
                return Data("{}".utf8)
            })
        let bound = gateway.bound(to: row, isCurrent: { currentID == $0.sessionId })
        await #expect(throws: CancellationError.self) {
            try await bound.request(OpenClawChatGatewayRequests.sessionMenu(
                "sessions.assignOwner", session: row, fields: ["owner": .init(["type": "human", "id": "me"])]))
        }
    }

    @Test func `spawned children do not gain pin or move-to-group actions`() {
        var row = OpenClawChatSessionEntry(key: "agent:main:subagent:child")
        row.spawnedBy = "agent:main:main"
        #expect(!ChatSessionSidebarActions.canPin(row))
        #expect(!ChatSessionSidebarActions.canMoveToGroup(row, mainKeys: ["agent:main:main"]))
        row = OpenClawChatSessionEntry(key: "agent:main:dashboard:root")
        row.parentSessionKey = "agent:main:main"
        row.createdVia = "operator"
        row.spawnDepth = 0
        #expect(ChatSessionSidebarActions.canPin(row))
        #expect(ChatSessionSidebarActions.canMoveToGroup(row, mainKeys: ["agent:main:main"]))
    }
}
