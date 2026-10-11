import Foundation
import OpenClawKit

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
        OpenClawSessionLink.path(sessionKey: sessionKey, agentID: agentID)
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
}
