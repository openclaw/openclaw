import Foundation
import GRDB
import OSLog

private let cacheLogger = Logger(subsystem: "ai.openclaw", category: "OpenClawChatTranscriptCache")

extension OpenClawChatSQLiteTranscriptCache {
    /// The text fields of one cached agent. Every field is optional, so a row written by a newer
    /// build (extra keys) or an older one (missing keys) still loads; new fields go here, not in
    /// new columns, so adding one never needs a cache format bump.
    private struct AgentIdentityPayload: Codable {
        var rosterName: String?
        var identityName: String?
        var emoji: String?
        var isDefault: Bool?
    }

    /// Synchronous so the first frame after a cold start can draw the last known agent.
    public nonisolated func loadAgentIdentities() -> [OpenClawChatCachedAgentIdentity] {
        do {
            return try self.databases.cacheQueue.read { db in
                try Row.fetchAll(
                    db,
                    sql: """
                    SELECT agent_id, payload_json, avatar
                    FROM cached_agent_identities WHERE gateway_id = ? ORDER BY position
                    """,
                    arguments: [self.gatewayID]).compactMap { row in
                    let agentID: String = row["agent_id"]
                    let json: String = row["payload_json"]
                    guard let payload = try? JSONDecoder().decode(AgentIdentityPayload.self, from: Data(json.utf8))
                    else {
                        cacheLogger.error("agent identity cache row skipped: payload does not decode")
                        return nil
                    }
                    return OpenClawChatCachedAgentIdentity(
                        agentID: agentID,
                        rosterName: payload.rosterName,
                        identityName: payload.identityName,
                        emoji: payload.emoji,
                        isDefault: payload.isDefault ?? false,
                        avatar: row["avatar"])
                }
            }
        } catch {
            cacheLogger.error("agent identity cache read failed: \(error.localizedDescription, privacy: .public)")
            return []
        }
    }

    /// Replaces this Gateway's agent snapshot with the latest complete answer.
    public func storeAgentIdentities(_ identities: [OpenClawChatCachedAgentIdentity]) async {
        guard !self.isRetired else { return }
        let gatewayID = self.gatewayID
        do {
            let payloads = try identities.map { identity in
                try Self.encodeAgentIdentityPayload(AgentIdentityPayload(
                    rosterName: identity.rosterName,
                    identityName: identity.identityName,
                    emoji: identity.emoji,
                    isDefault: identity.isDefault))
            }
            try await self.databases.cacheQueue.write { db in
                try db.execute(
                    sql: "DELETE FROM cached_agent_identities WHERE gateway_id = ?",
                    arguments: [gatewayID])
                for (position, (identity, payload)) in zip(identities, payloads).enumerated() {
                    try db.execute(
                        sql: """
                        INSERT INTO cached_agent_identities(gateway_id, agent_id, position, payload_json, avatar)
                        VALUES (?, ?, ?, ?, ?)
                        """,
                        arguments: [gatewayID, identity.agentID, position, payload, identity.avatar])
                }
            }
        } catch {
            cacheLogger.error("agent identity cache write failed: \(error.localizedDescription, privacy: .public)")
        }
    }

    private static func encodeAgentIdentityPayload(_ payload: AgentIdentityPayload) throws -> String {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        return try String(bytes: encoder.encode(payload), encoding: .utf8)!
    }
}
