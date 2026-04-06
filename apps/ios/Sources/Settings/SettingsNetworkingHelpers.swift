import Foundation

struct SettingsHostPort: Equatable {
    var host: String
    var port: Int
}

enum SettingsNetworkingHelpers {
    static func parseHostPort(from address: String) -> SettingsHostPort? {
        let trimmed = address.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }

        if trimmed.hasPrefix("["),
           let close = trimmed.firstIndex(of: "]"),
           close < trimmed.endIndex
        {
            let host = String(trimmed[trimmed.index(after: trimmed.startIndex)..<close])
            let portStart = trimmed.index(after: close)
            guard portStart < trimmed.endIndex, trimmed[portStart] == ":" else { return nil }
            let portString = String(trimmed[trimmed.index(after: portStart)...])
            guard let port = Int(portString) else { return nil }
            return SettingsHostPort(host: host, port: port)
        }

        guard let colon = trimmed.lastIndex(of: ":") else { return nil }
        let host = String(trimmed[..<colon])
        let portString = String(trimmed[trimmed.index(after: colon)...])
        guard !host.isEmpty, let port = Int(portString) else { return nil }
        return SettingsHostPort(host: host, port: port)
    }

    static func httpURLString(host: String?, port: Int?, fallback: String) -> String {
        if let host, let port {
            let needsBrackets = host.contains(":") && !host.hasPrefix("[") && !host.hasSuffix("]")
            let hostPart = needsBrackets ? "[\(host)]" : host
            return "http://\(hostPart):\(port)"
        }
        return "http://\(fallback)"
    }
}
