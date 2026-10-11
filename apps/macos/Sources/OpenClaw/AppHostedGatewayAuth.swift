import Foundation
import Security

enum AppHostedGatewayAuth {
    enum Decision {
        case persist
        case keep
    }

    static func decision(root: [String: Any]?, environment: [String: String]) -> Decision {
        guard let root,
              environment["OPENCLAW_GATEWAY_TOKEN"]?.nonEmpty == nil,
              environment["OPENCLAW_GATEWAY_PASSWORD"]?.nonEmpty == nil
        else { return .keep }
        // Malformed authored sections belong to config validation, not first-run repair.
        if let gateway = root["gateway"], !(gateway is [String: Any]) { return .keep }
        let gateway = root["gateway"] as? [String: Any] ?? [:]
        if let auth = gateway["auth"], !(auth is [String: Any]) { return .keep }
        let auth = gateway["auth"] as? [String: Any] ?? [:]
        if let mode = auth["mode"], mode as? String != "token" { return .keep }
        if let token = auth["token"] {
            guard let string = token as? String, string.nonEmpty == nil else { return .keep }
        }
        guard auth["password"] == nil else { return .keep }
        return .persist
    }

    static func generateToken() throws -> String {
        var bytes = [UInt8](repeating: 0, count: 24)
        guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else {
            throw GatewayHostingError(message: "Could not generate a local Gateway authentication token. Retry setup.")
        }
        return bytes.map { String(format: "%02x", $0) }.joined()
    }

    static func persisting(token: String, in root: [String: Any]) -> [String: Any] {
        var output = root
        var gateway = root["gateway"] as? [String: Any] ?? [:]
        var auth = gateway["auth"] as? [String: Any] ?? [:]
        if auth["mode"] == nil { auth["mode"] = "token" }
        auth["token"] = token
        gateway["auth"] = auth
        output["gateway"] = gateway
        return output
    }
}
