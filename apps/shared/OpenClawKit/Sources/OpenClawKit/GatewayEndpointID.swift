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
        // Persisted IDs use the original scalar-per-escape mapping, including values above 255.
        // Keep it separate from UTF-8 display decoding; changing these bytes requires migrating
        // every saved profile, credential, and TLS pin keyed by the ID.
        var decoded = ""
        var i = rawName.startIndex
        while i < rawName.endIndex {
            if rawName[i] == "\\" {
                let digits = rawName[rawName.index(after: i)...].prefix(3)
                if digits.count == 3, digits.allSatisfy(\.isNumber),
                   let value = Int(digits),
                   let scalar = UnicodeScalar(value)
                {
                    decoded.append(Character(scalar))
                    i = rawName.index(i, offsetBy: 4)
                    continue
                }
            }

            decoded.append(rawName[i])
            i = rawName.index(after: i)
        }
        return decoded.split(whereSeparator: \.isWhitespace).joined(separator: " ")
    }
}
