import Foundation
import GRDB
import Testing
@testable import OpenClawChatUI

final class ChatSessionSidebarCacheTests: ClientDatabaseTestSuite, @unchecked Sendable {
    @Test func `sidebar enrichment preserves the existing stored row and reopen contract`() async throws {
        let response = try OpenClawChatGatewayPayloadCodec.decodeSessionsList(
            ChatSessionSidebarFieldsTests.rosterFixture, agentID: "research")
        await self.store.storeSessions(response.sessions, agentID: "research")
        let stored = try await self.databases.cacheQueue.read { db in
            try String.fetchOne(db, sql: "SELECT payload_json FROM cached_agent_sessions")
        }
        let payload = try #require(stored)
        // This is the row payload produced by the pre-enrichment Apple cache writer.
        let baseline = #"{"key":"agent:research:thread","kind":"direct","sessionId":"session-thread","agentId":"research","derivedTitle":"Research findings","createdActor":{"type":"human"}}"#
        let expected = try #require(JSONSerialization.jsonObject(with: Data(baseline.utf8)) as? NSDictionary)
        #expect(try JSONSerialization.jsonObject(with: Data(payload.utf8)) as? NSDictionary == expected)

        try await self.databases.cacheQueue.write { db in
            try db.execute(sql: "UPDATE cached_agent_sessions SET payload_json = ?", arguments: [baseline])
        }
        try self.databases.close()
        let reopened = try OpenClawClientDatabases(directoryURL: self.directory)
        defer { try? reopened.close() }
        let rows = await reopened.store(gatewayID: "gw-a").loadSessions(agentID: "research")
        let row = try #require(rows.first)
        #expect(rows.count == 1)
        #expect(try JSONSerialization.jsonObject(with: JSONEncoder().encode(row)) as? NSDictionary == expected)
        #expect(try await reopened.cacheQueue.read { db in
            try Int.fetchOne(db, sql: "SELECT COUNT(*) FROM cached_agent_sessions")
        } == 1)
    }
}
