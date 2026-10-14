import Foundation

struct WebChatRoute: Equatable, Sendable {
    let sessionKey: String
    let agentID: String?

    init(sessionKey: String, agentID: String?) {
        self.sessionKey = sessionKey
        self.agentID = Self.normalizedAgentID(agentID)
    }

    func replacingSessionKey(_ sessionKey: String) -> Self {
        Self(sessionKey: sessionKey, agentID: self.agentID)
    }

    static func normalizedAgentID(_ agentID: String?) -> String? {
        let normalized = agentID?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        return normalized?.isEmpty == false ? normalized : nil
    }
}

extension WebChatRoute {
    static func dashboardPath(sessionKey: String, agentID: String?) -> String? {
        let key = sessionKey.trimmingCharacters(in: .whitespacesAndNewlines)
        let explicitAgent = Self.normalizedAgentID(agentID)
        if key.lowercased() == "main" || key.lowercased() == "global" {
            return explicitAgent.map { "/chat/" + Self.encodedSessionSegment($0) }
        }
        let parts = key.components(separatedBy: ":")
        let agent: String
        let rest: [String]
        if parts.first?.lowercased() == "agent" {
            guard parts.count >= 3, let parsedAgent = Self.normalizedAgentID(parts[1]) else { return nil }
            agent = parsedAgent
            rest = Array(parts.dropFirst(2))
        } else if let explicitAgent {
            agent = explicitAgent
            rest = parts
        } else {
            return nil
        }
        guard !rest.contains(where: \.isEmpty) else { return nil }
        // Qualified global is a literal session; only main aliases the agent home.
        if rest.count == 1, rest[0].lowercased() == "main" {
            return "/chat/" + Self.encodedSessionSegment(agent)
        }
        // The Control UI exact-key grammar uses ~key for a single literal rest
        // segment; it must never be mistaken for a display slug or short UUID.
        let suffix = (rest.count == 1 ? ["~key"] : []) + rest.map(Self.encodedSessionSegment)
        return (["", "chat", Self.encodedSessionSegment(agent)] + suffix).joined(separator: "/")
    }

    static func dashboardSearch(draft: String?) -> String? {
        guard let draft, !draft.isEmpty else { return nil }
        var query = URLComponents()
        query.queryItems = [
            URLQueryItem(name: "draft", value: draft),
            URLQueryItem(name: "__openclawComposerFocus", value: "1"),
        ]
        // URLSearchParams decodes '+' as a space; Foundation leaves it literal.
        return query.percentEncodedQuery.map { "?" + $0.replacingOccurrences(of: "+", with: "%2B") }
    }

    private static func encodedSessionSegment(_ value: String) -> String {
        if value == "." { return "~dot" }
        if value == ".." { return "~dotdot" }
        let encoded = value.addingPercentEncoding(withAllowedCharacters:
            CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_~"))!
        return encoded.hasPrefix("~") ? "~" + encoded : encoded
    }
}
