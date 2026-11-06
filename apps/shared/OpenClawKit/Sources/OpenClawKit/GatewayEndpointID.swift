import Foundation
import Network

public enum GatewayEndpointID {
    public static func isSensitiveQueryItemName(_ value: String) -> Bool {
        let normalized = value
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased()
            .replacingOccurrences(of: "-", with: "_")
        return [
            "access_token", "api_key", "apikey", "app_secret", "auth", "auth_token",
            "authorization", "client_secret", "code", "credential", "hook_token", "id_token",
            "jwt", "key", "pass", "passwd", "password", "private_key", "refresh_token",
            "secret", "session", "signature", "token", "x_amz_security_token", "x_amz_signature",
        ].contains(normalized)
    }

    public static func stableID(_ endpoint: NWEndpoint) -> String {
        switch endpoint {
        case let .service(name, type, domain, _):
            // Keep stable across encoded/decoded differences (e.g. \032 for spaces).
            let normalizedName = Self.normalizeServiceNameForID(name)
            return "\(type)|\(domain)|\(normalizedName)"
        default:
            return String(describing: endpoint)
        }
    }

    public static func prettyDescription(_ endpoint: NWEndpoint) -> String {
        BonjourEscapes.decode(String(describing: endpoint))
    }

    private static func normalizeServiceNameForID(_ rawName: String) -> String {
        let decoded = BonjourEscapes.decode(rawName)
        return decoded.split(whereSeparator: \.isWhitespace).joined(separator: " ")
    }
}
