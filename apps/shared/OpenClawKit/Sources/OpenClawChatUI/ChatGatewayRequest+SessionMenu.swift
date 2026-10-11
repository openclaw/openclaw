import Foundation
import OpenClawProtocol

extension OpenClawChatGatewayRequests {
    public static func sessionMenuTarget(_ session: OpenClawChatSessionEntry) -> [String: AnyCodable] {
        var params: [String: AnyCodable] = ["key": .init(session.key)]
        if let agent = OpenClawChatSessionKey.agentID(from: session.key) ?? session.agentId {
            params["agentId"] = .init(agent)
        }
        return params
    }

    public static func sessionMenu(
        _ method: String, session: OpenClawChatSessionEntry, fields: [String: AnyCodable]) -> OpenClawChatGatewayRequest
    {
        var params = self.sessionMenuTarget(session).merging(fields) { _, value in value }
        if ["sessions.patch", "sessions.delete"].contains(method),
           let id = session.sessionId { params["expectedSessionId"] = .init(id) }
        if method == "sessions.delete", session.isArchived { params["archivedOnly"] = .init(true) }
        return .init(method: method, params: params, timeoutMs: 15000)
    }
}
