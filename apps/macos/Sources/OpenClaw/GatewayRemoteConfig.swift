import Foundation
import OpenClawKit

enum GatewayRemoteConfig {
    private static func remoteSection(root: [String: Any]) -> [String: Any]? {
        guard let gateway = root["gateway"] as? [String: Any] else { return nil }
        return gateway["remote"] as? [String: Any]
    }

    static func resolveTransport(root: [String: Any]) -> AppState.RemoteTransport {
        guard let raw = self.remoteSection(root: root)?["transport"] as? String else {
            return .ssh
        }
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        return trimmed == AppState.RemoteTransport.direct.rawValue ? .direct : .ssh
    }

    static func resolveDirectInputMode(root: [String: Any]) -> AppState.RemoteDirectInputMode {
        guard let raw = self.remoteSection(root: root)?["inputMode"] as? String else {
            return .autoDiscovery
        }
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        return AppState.RemoteDirectInputMode(rawValue: trimmed) ?? .autoDiscovery
    }

    static func resolveManualTLSMode(root: [String: Any]) -> AppState.RemoteDirectTLSMode {
        if let raw = self.remoteSection(root: root)?["tlsMode"] as? String {
            let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
            if let mode = AppState.RemoteDirectTLSMode(rawValue: trimmed) {
                return mode
            }
        }
        if let url = self.resolveGatewayUrl(root: root, allowInsecureRemoteWS: true),
           url.scheme?.lowercased() == "ws"
        {
            return .unencrypted
        }
        return .strict
    }

    static func resolveConfiguredManualHost(root: [String: Any]) -> String? {
        guard let raw = self.remoteSection(root: root)?["host"] as? String else { return nil }
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }

    static func resolveManualHost(root: [String: Any]) -> String? {
        if let configured = self.resolveConfiguredManualHost(root: root) {
            return configured
        }
        return self.resolveUrlString(root: root).flatMap(self.manualHost(fromGatewayURLString:))
    }

    static func resolveUrlString(root: [String: Any]) -> String? {
        guard let urlRaw = self.remoteSection(root: root)?["url"] as? String else {
            return nil
        }
        let trimmed = urlRaw.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }

    static func resolveGatewayUrl(root: [String: Any]) -> URL? {
        let allowInsecureRemoteWS = self.resolveManualTLSMode(root: root) == .unencrypted
        return self.resolveGatewayUrl(root: root, allowInsecureRemoteWS: allowInsecureRemoteWS)
    }

    static func resolveGatewayUrl(root: [String: Any], allowInsecureRemoteWS: Bool) -> URL? {
        guard let raw = self.resolveUrlString(root: root) else { return nil }
        return self.normalizeGatewayUrl(raw, allowInsecureRemoteWS: allowInsecureRemoteWS)
    }

    static func normalizeGatewayUrlString(_ raw: String, allowInsecureRemoteWS: Bool = false) -> String? {
        self.normalizeGatewayUrl(raw, allowInsecureRemoteWS: allowInsecureRemoteWS)?.absoluteString
    }

    static func normalizeGatewayUrl(_ raw: String, allowInsecureRemoteWS: Bool = false) -> URL? {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, let url = URL(string: trimmed) else { return nil }
        let scheme = url.scheme?.lowercased() ?? ""
        guard scheme == "ws" || scheme == "wss" else { return nil }
        let host = url.host?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard !host.isEmpty else { return nil }
        if scheme == "ws", !allowInsecureRemoteWS, !LoopbackHost.isLoopbackHost(host) {
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

    static func normalizeManualHost(_ raw: String) -> String? {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        if trimmed.contains("://"),
           let components = URLComponents(string: trimmed),
           let host = components.host?.trimmingCharacters(in: .whitespacesAndNewlines),
           !host.isEmpty
        {
            return self.hostPortString(host: host, port: components.port)
        }

        let pathCut = trimmed.split(whereSeparator: { $0 == "/" || $0 == "?" || $0 == "#" }).first.map(String.init)
            ?? trimmed
        guard !pathCut.isEmpty,
              pathCut.rangeOfCharacter(from: .whitespacesAndNewlines) == nil
        else {
            return nil
        }
        return pathCut
    }

    static func buildManualGatewayUrlString(host: String, tlsMode: AppState.RemoteDirectTLSMode) -> String? {
        guard let normalizedHost = self.normalizeManualHost(host) else { return nil }
        let scheme = tlsMode == .unencrypted ? "ws" : "wss"
        let raw = "\(scheme)://\(normalizedHost)"
        return self.normalizeGatewayUrlString(raw, allowInsecureRemoteWS: tlsMode == .unencrypted)
    }

    static func manualHost(fromGatewayURLString raw: String) -> String? {
        guard let url = self.normalizeGatewayUrl(raw, allowInsecureRemoteWS: true),
              let host = url.host?.trimmingCharacters(in: .whitespacesAndNewlines),
              !host.isEmpty
        else {
            return nil
        }
        return self.hostPortString(host: host, port: url.port)
    }

    static func resolveManualTLSMode(root: [String: Any], matching url: URL) -> AppState.RemoteDirectTLSMode? {
        guard self.resolveTransport(root: root) == .direct,
              self.resolveDirectInputMode(root: root) == .manual,
              let configured = self.resolveGatewayUrl(root: root, allowInsecureRemoteWS: true)
        else {
            return nil
        }
        guard self.sameGatewayEndpoint(lhs: configured, rhs: url) else { return nil }
        return self.resolveManualTLSMode(root: root)
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

    private static func hostPortString(host: String, port: Int?) -> String {
        let hostText = host.contains(":") ? "[\(host)]" : host
        if let port {
            return "\(hostText):\(port)"
        }
        return hostText
    }

    private static func sameGatewayEndpoint(lhs: URL, rhs: URL) -> Bool {
        let lhsHost = lhs.host?.lowercased() ?? ""
        let rhsHost = rhs.host?.lowercased() ?? ""
        guard !lhsHost.isEmpty, lhsHost == rhsHost else { return false }
        let lhsScheme = lhs.scheme?.lowercased() ?? ""
        let rhsScheme = rhs.scheme?.lowercased() ?? ""
        guard lhsScheme == rhsScheme else { return false }
        return self.defaultPort(for: lhs) == self.defaultPort(for: rhs)
    }
}
