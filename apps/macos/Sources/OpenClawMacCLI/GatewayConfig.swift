import Foundation
#if canImport(Darwin)
import Darwin
#endif

/// Resolve the openclaw config file URL using the same precedence as the macOS
/// GUI (`OpenClawPaths.configURL`):
///   1. `OPENCLAW_CONFIG_PATH` (explicit override)
///   2. `$OPENCLAW_STATE_DIR/openclaw.json` (custom state dir)
///   3. `~/.openclaw/openclaw.json` (default)
func resolveOpenClawConfigURL() -> URL {
    if let raw = envValue("OPENCLAW_CONFIG_PATH") {
        return URL(fileURLWithPath: NSString(string: raw).expandingTildeInPath)
    }
    if let stateDir = envValue("OPENCLAW_STATE_DIR") {
        let dir = URL(fileURLWithPath: stateDir, isDirectory: true)
        let candidate = dir.appendingPathComponent("openclaw.json")
        if FileManager().isReadableFile(atPath: candidate.path) {
            return candidate
        }
        // Return the candidate even if it doesn't exist yet, so
        // configure-remote writes into the state dir rather than the
        // default home location.
        return candidate
    }
    return FileManager().homeDirectoryForCurrentUser
        .appendingPathComponent(".openclaw/openclaw.json")
}

private func envValue(_ key: String) -> String? {
    #if canImport(Darwin)
    guard let raw = getenv(key) else { return nil }
    let value = String(cString: raw).trimmingCharacters(in: .whitespacesAndNewlines)
    return value.isEmpty ? nil : value
    #else
    return nil
    #endif
}

struct GatewayConfig {
    var mode: String?
    var bind: String?
    var port: Int?
    var remoteUrl: String?
    var remotePort: Int?
    var token: String?
    var password: String?
    var remoteToken: String?
    var remotePassword: String?
}

struct GatewayEndpoint {
    let url: URL
    let token: String?
    let password: String?
    let mode: String
}

func loadGatewayConfig() -> GatewayConfig {
    let url = resolveOpenClawConfigURL()
    guard let data = try? Data(contentsOf: url) else { return GatewayConfig() }
    guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
        return GatewayConfig()
    }

    var cfg = GatewayConfig()
    if let gateway = json["gateway"] as? [String: Any] {
        cfg.mode = gateway["mode"] as? String
        cfg.bind = gateway["bind"] as? String
        cfg.port = gateway["port"] as? Int ?? parseInt(gateway["port"])

        if let auth = gateway["auth"] as? [String: Any] {
            cfg.token = auth["token"] as? String
            cfg.password = auth["password"] as? String
        }
        if let remote = gateway["remote"] as? [String: Any] {
            cfg.remoteUrl = remote["url"] as? String
            cfg.remotePort = remote["remotePort"] as? Int ?? parseInt(remote["remotePort"])
            cfg.remoteToken = remote["token"] as? String
            cfg.remotePassword = remote["password"] as? String
        }
    }
    return cfg
}

func parseInt(_ value: Any?) -> Int? {
    switch value {
    case let number as Int:
        number
    case let number as Double:
        Int(number)
    case let raw as String:
        Int(raw.trimmingCharacters(in: .whitespacesAndNewlines))
    default:
        nil
    }
}
