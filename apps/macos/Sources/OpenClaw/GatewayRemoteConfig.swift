import Foundation

enum GatewayRemoteConfig {
    private static func isLoopbackHost(_ rawHost: String) -> Bool {
        let host = rawHost
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased()
            .trimmingCharacters(in: CharacterSet(charactersIn: "[]"))
        if host.isEmpty {
            return false
        }
        if host == "localhost" || host == "::1" || host == "127.0.0.1" {
            return true
        }
        if host.hasPrefix("127.") || host.hasPrefix("::ffff:127.") {
            return true
        }
        return false
    }

    static func resolveTransport(root: [String: Any]) -> AppState.RemoteTransport {
        guard let gateway = root["gateway"] as? [String: Any],
              let remote = gateway["remote"] as? [String: Any],
              let raw = remote["transport"] as? String
        else {
            return .ssh
        }
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        return trimmed == AppState.RemoteTransport.direct.rawValue ? .direct : .ssh
    }

    static func resolveUrlString(root: [String: Any]) -> String? {
        guard let gateway = root["gateway"] as? [String: Any],
              let remote = gateway["remote"] as? [String: Any],
              let urlRaw = remote["url"] as? String
        else {
            return nil
        }
        let trimmed = urlRaw.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }

    static func resolveGatewayUrl(root: [String: Any]) -> URL? {
        guard let raw = self.resolveUrlString(root: root) else { return nil }
        return self.normalizeGatewayUrl(raw)
    }

    static func normalizeGatewayUrlString(_ raw: String) -> String? {
        self.normalizeGatewayUrl(raw)?.absoluteString
    }

    static func normalizeGatewayUrl(_ raw: String) -> URL? {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, let url = URL(string: trimmed) else { return nil }
        let scheme = url.scheme?.lowercased() ?? ""
        guard scheme == "ws" || scheme == "wss" else { return nil }
        let host = url.host?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard !host.isEmpty else { return nil }
        if scheme == "ws", !self.isLoopbackHost(host) {
            return nil
        }
        if scheme == "ws", url.port == nil {
            guard var components = URLComponents(url: url, resolvingAgainstBaseURL: false) else {
                return url
            }
            components.port = 18789
            return components.url
        }
        return url
    }

    static func defaultPort(for url: URL) -> Int? {
        if let port = url.port { return port }
        let scheme = url.scheme?.lowercased() ?? ""
        switch scheme {
        case "wss":
            return 443
        case "ws":
            return 18789
        default:
            return nil
        }
    }
}
