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
    @MainActor
    static func recoveryDocumentURL(for url: URL, baseURL: URL) -> URL? {
        guard url.user == nil, url.password == nil,
              ControlUIDocumentHost.isTrustedLinkSource(url, dashboardURL: baseURL),
              let path = ControlUIDocumentHost.appPath(
                  fromDocumentPath: url.path(percentEncoded: true), baseURL: baseURL)
        else { return nil }
        guard path.hasPrefix("/chat/") else { return url }
        guard let route = URLComponents(url: url, resolvingAgainstBaseURL: false),
              let entry = DashboardRouteMap.dashboardURL(
                  byAppendingSameAppPath: "/__openclaw__/session-entry", to: baseURL),
              var components = URLComponents(url: entry, resolvingAgainstBaseURL: false)
        else { return nil }
        // Match the Gateway's session-entry return-query contract. Keep raw
        // encoding (including '+' semantics), and credentials only in the outer hash.
        let query = route.percentEncodedQuery?.components(separatedBy: "&").filter { field in
            let decodedField = field.replacingOccurrences(of: "+", with: "%20")
            guard let item = URLComponents(string: "?" + decodedField)?.queryItems?.first,
                  route.queryItems?.filter({ $0.name == item.name }).count == 1
            else { return false }
            return Self.isRecoveryQueryItem(item)
        }.joined(separator: "&")
        let search = query.flatMap { $0.isEmpty ? nil : "?" + $0 } ?? ""
        components.queryItems = [.init(name: "path", value: route.percentEncodedPath + search)]
        components.percentEncodedQuery = components.percentEncodedQuery?.replacingOccurrences(of: "+", with: "%2B")
        components.percentEncodedFragment = route.percentEncodedFragment
        return components.url
    }

    private static func isRecoveryQueryItem(_ item: URLQueryItem) -> Bool {
        let value = item.value ?? ""
        switch item.name {
        case "dashboard": return value == "expanded"
        case "draft": return true
        case "openclaw_mount_recovery": return !value.isEmpty && value.utf8.allSatisfy { (48...57).contains($0) }
        case "__openclawSessionFacePreference", "__openclawComposerFocus": return value == "1"
        case "__openclawSessionKey":
            return !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty &&
                !value.unicodeScalars.contains { $0.value < 32 || $0.value == 127 }
        default: return false
        }
    }

    static func documentURL(sessionKey: String, agentID: String?, draft: String?, baseURL: URL) -> URL? {
        guard let path = self.dashboardPath(sessionKey: sessionKey, agentID: agentID),
              let destination = DashboardRouteMap.dashboardURL(byAppendingSameAppPath: path, to: baseURL),
              var route = URLComponents(url: destination, resolvingAgainstBaseURL: false),
              let entry = DashboardRouteMap.dashboardURL(
                  byAppendingSameAppPath: "/__openclaw__/session-entry", to: baseURL),
              var components = URLComponents(url: entry, resolvingAgainstBaseURL: false)
        else { return nil }
        // Canonical /chat URLs are public documents. Bootstrap the private app
        // shell first; its WebSocket still requires the native signing bridge.
        route.queryItems = draft.flatMap { $0.isEmpty ? nil : [.init(name: "draft", value: $0)] }
        let search = route.percentEncodedQuery.map {
            "?" + $0.replacingOccurrences(of: "+", with: "%2B")
        } ?? ""
        components.queryItems = [.init(name: "path", value: route.percentEncodedPath + search)]
        return components.url
    }

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
