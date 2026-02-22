import Foundation
import Network

enum GatewayRemoteConfig {
    private static func isLoopbackHost(_ rawHost: String) -> Bool {
        var host = rawHost
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased()
            .trimmingCharacters(in: CharacterSet(charactersIn: "[]"))
        if host.hasSuffix(".") {
            host.removeLast()
        }
        if let zoneIndex = host.firstIndex(of: "%") {
            host = String(host[..<zoneIndex])
        }
        if host.isEmpty {
            return false
        }
        if host == "localhost" || host == "0.0.0.0" || host == "::" {
            return true
        }

        if let ipv4 = IPv4Address(host) {
            return ipv4.rawValue.first == 127
        }
        if let ipv6 = IPv6Address(host) {
            let bytes = Array(ipv6.rawValue)
            let isV6Loopback = bytes[0..<15].allSatisfy { $0 == 0 } && bytes[15] == 1
            if isV6Loopback {
                return true
            }
            let isMappedV4 = bytes[0..<10].allSatisfy { $0 == 0 } && bytes[10] == 0xFF && bytes[11] == 0xFF
            return isMappedV4 && bytes[12] == 127
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
