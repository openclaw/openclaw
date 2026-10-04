#if os(macOS)
import OpenClawProtocol

extension OpenClawChatGatewayRequests {
    static func sessionMenuTarget(_ session: OpenClawChatSessionEntry) -> [String: AnyCodable] {
        var params: [String: AnyCodable] = ["key": .init(session.key)]
        if let agent = OpenClawChatSessionKey.agentID(from: session.key) ?? session.agentId {
            params["agentId"] = .init(agent)
        }
        return params
    }

    static func sessionMenu(
        _ method: String, session: OpenClawChatSessionEntry, fields: [String: AnyCodable]) -> OpenClawChatGatewayRequest
    {
        var params = self.sessionMenuTarget(session).merging(fields) { _, value in value }
        if method == "sessions.patch", let id = session.sessionId { params["expectedSessionId"] = .init(id) }
        return .init(method: method, params: params, timeoutMs: 15000)
    }
}
#endif
