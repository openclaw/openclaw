#if os(macOS)
import Foundation
import OpenClawProtocol
import Testing
@testable import OpenClawChatUI

extension ChatSessionSidebarArchiveUndoTests {
    private var tokenCapabilities: [String] {
        ["personal-session-pins", "session-archive-undo-v1"]
    }

    private func target(_ row: OpenClawChatSessionEntry, _ fields: [String: AnyCodable] = [:]) -> [String: AnyCodable] {
        var params = fields
        params["key"] = .init(row.key)
        params["agentId"] = .init(row.agentId!)
        params["expectedSessionId"] = .init(row.sessionId!)
        return params
    }

    enum SingleTokenReply: CaseIterable { case accepted, wrongRestoreID, stillArchived, refused, missing, empty,
                                               unsolicited
    }

    @Test(arguments: SingleTokenReply.allCases)
    func `single archive offers only negotiated tokens and confirms the restored incarnation`(
        _ reply: SingleTokenReply) async throws
    {
        let row = try self.row(), batch = ChatSessionSidebarBatch(), owner = OpenClawChatSessionSidebarData()
        owner.receive([row], read: owner.beginRead())
        let negotiated = reply != .unsolicited
        let capabilities = negotiated ? self.tokenCapabilities : ["personal-session-pins"]
        var calls: [OpenClawChatGatewayRequest] = []
        let connection = try self.connection(capabilities: capabilities) { request in
            calls.append(request)
            if calls.count == 1 {
                let token: String? = reply == .missing ? nil : (reply == .empty ? "" : "single-ticket")
                return try self.acknowledgement(row, archived: true, token: token)
            }
            if reply == .refused { throw URLError(.resourceUnavailable) }
            var restored = row
            if reply == .wrongRestoreID { restored.sessionId = "different-incarnation" }
            return try self.acknowledgement(restored, archived: reply == .stillArchived)
        }
        var archived = 0
        let offered = await batch.archive(row, mainKey: "main", connection: connection, owner: owner) { archived += 1 }
        var archiveFields: [String: AnyCodable] = ["archived": .init(true)]
        if negotiated { archiveFields["requestArchiveUndo"] = .init(true) }
        #expect(calls == [.init(method: "sessions.patch", params: self.target(row, archiveFields), timeoutMs: 600_000)])
        #expect(archived == 1)
        #expect(batch.errors.isEmpty)
        #expect(owner.row(key: row.key, agentID: row.agentId)?.isArchived == true)
        if [.missing, .empty, .unsolicited].contains(reply) {
            #expect(offered == nil && batch.archiveUndo == nil)
            return
        }
        let id = try #require(offered?.id)
        let clicked = try #require(batch.takeArchiveUndo(id: id))
        #expect(batch.takeArchiveUndo(id: id) == nil)
        await batch.undoArchive(clicked, owner: owner)
        let restore = self.target(row, ["archived": .init(false), "archiveUndoToken": .init("single-ticket")])
        #expect(Array(calls.dropFirst()) == [.init(method: "sessions.patch", params: restore, timeoutMs: 15000)])
        #expect(owner.row(key: row.key, agentID: row.agentId)?.isArchived == (reply != .accepted))
        let errorTargets = reply == .accepted ? [] : [OpenClawChatSessionSidebarData.identity(row)]
        #expect(Array(batch.errors.keys) == errorTargets)
    }

    @Test func `batch undo keeps each successful token across chunks even when the tail fails`() async throws {
        var rows = try (0...200).map { try self.row("thread-\($0)") }
        // Same key across owners; same owner/key across incarnations in separate chunks.
        rows[0].key = "shared"
        rows[3].key = "shared"
        rows[3].agentId = "design"
        rows[3].sessionId = rows[0].sessionId
        rows[100].key = "shared"
        let ranges = [0..<100, 100..<200, 200..<201]
        let refused = [1, 101], tokenless = [2, 102]
        let successes = (0..<200).filter { !refused.contains($0) }
        let undoable = successes.filter { !tokenless.contains($0) }
        let tokens = Dictionary(uniqueKeysWithValues: undoable.map { ("ticket-\($0)", $0) })
        var chunks = 0, restores: [[String: AnyCodable]] = []
        let connection = try self.connection(capabilities: self.tokenCapabilities) { request in
            if request.method == "sessions.patch" {
                restores.append(request.params)
                let token = try #require(request.params["archiveUndoToken"]?.value as? String)
                let index = try #require(tokens[token])
                return try self.acknowledgement(rows[index], archived: false)
            }
            let range = try #require(ranges.dropFirst(chunks).first)
            chunks += 1
            #expect(request.method == "sessions.patchMany")
            #expect(request.params == [
                "targets": .init(range.map { self.target(rows[$0]) }),
                "patch": .init(["archived": true, "requestArchiveUndo": true]),
            ])
            if chunks == 3 { throw URLError(.networkConnectionLost) }
            let outcomes = range.map { index -> [String: Any] in
                var outcome: [String: Any] = [
                    "key": rows[index].key,
                    "agentId": rows[index].agentId!,
                    "ok": !refused.contains(index),
                ]
                if !tokenless.contains(index) { outcome["archiveUndoToken"] = "ticket-\(index)" }
                if refused.contains(index) { outcome["error"] = ["message": "Archive denied"] }
                return outcome
            }
            return try JSONSerialization.data(withJSONObject: ["outcomes": outcomes])
        }
        let batch = ChatSessionSidebarBatch()
        let archived = await batch.run(.archived(true), rows: rows, mainKey: "main", connection: connection)
        #expect(chunks == 3 && archived == successes.map { rows[$0] })
        let offer = try #require(batch.archiveUndo)
        #expect(offer.rows == undoable.map { rows[$0] })
        let clicked = try #require(batch.takeArchiveUndo(id: offer.id))
        await batch.undoArchive(clicked, owner: nil)
        let expected = undoable.map { self.target(
            rows[$0],
            ["archived": .init(false), "archiveUndoToken": .init("ticket-\($0)")]) }
        #expect(restores.count == expected.count && Set(restores) == Set(expected))
        let tail = OpenClawChatSessionSidebarData.identity(rows[200])
        var errors = [tail: URLError(.networkConnectionLost).localizedDescription]
        for index in refused {
            errors[OpenClawChatSessionSidebarData.identity(rows[index])] = "Archive denied"
        }
        #expect(batch.errors == errors)
    }

    @Test(arguments: [true, false])
    func `batch tokens from another owner or without negotiation never offer undo`(_ negotiated: Bool) async throws {
        var first = try self.row(), second = first
        first.key = "shared"
        second.key = first.key
        second.agentId = "design"
        let rows = [first, second], batch = ChatSessionSidebarBatch()
        var calls = 0
        let capabilities = negotiated ? self.tokenCapabilities : ["personal-session-pins"]
        let connection = try self.connection(capabilities: capabilities) { request in
            calls += 1
            #expect(request.method == "sessions.patchMany")
            let patch = negotiated ? ["archived": true, "requestArchiveUndo": true] : ["archived": true]
            #expect(request.params["targets"] == .init(rows.map { self.target($0) }))
            #expect(request.params["patch"] == .init(patch))
            let outcomes = (negotiated ? Array(rows.reversed()) : rows).map { row in
                [
                    "key": row.key,
                    "agentId": row.agentId!,
                    "ok": true,
                    "archiveUndoToken": "ticket-\(row.agentId!)",
                ] as [String: Any]
            }
            return try JSONSerialization.data(withJSONObject: ["outcomes": outcomes])
        }
        let archived = await batch.run(.archived(true), rows: rows, mainKey: "main", connection: connection)
        #expect(calls == 1)
        #expect(archived == (negotiated ? [] : rows))
        #expect(Set(batch.errors.keys) == (negotiated ? Set(rows.map(OpenClawChatSessionSidebarData.identity)) : []))
        #expect(batch.archiveUndo == nil)
    }
}
#endif
