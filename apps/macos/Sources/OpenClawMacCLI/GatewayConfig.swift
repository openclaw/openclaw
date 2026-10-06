import Foundation
import OpenClawIPC

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

func resolvedCredential(
    _ explicit: String?,
    mode: String,
    local: String?,
    remote: String?,
    inheritConfigCredentials: Bool = true) -> String?
{
    if let explicit, !explicit.isEmpty { return explicit }
    guard inheritConfigCredentials else { return nil }
    return mode == "remote" ? remote : local
}

/// Keep standalone CLI reads and configure-remote writes on the same profile.
/// An explicit config path wins; otherwise the selected state directory owns openclaw.json.
func resolveOpenClawConfigURL(
    profile: MacControlProfile,
    environment: [String: String],
    homeDirectory: URL) -> URL
{
    if let configPath = openClawEnvironmentPath("OPENCLAW_CONFIG_PATH", environment: environment) {
        return URL(fileURLWithPath: NSString(string: configPath).expandingTildeInPath)
    }
    let stateDir = openClawEnvironmentPath("OPENCLAW_STATE_DIR", environment: environment).map {
        URL(fileURLWithPath: NSString(string: $0).expandingTildeInPath, isDirectory: true)
    } ?? profile.stateDirectoryURL(homeDirectory: homeDirectory)
    return stateDir.appendingPathComponent("openclaw.json")
}

private func openClawEnvironmentPath(_ key: String, environment: [String: String]) -> String? {
    guard let raw = environment[key] else { return nil }
    let value = raw.trimmingCharacters(in: .whitespacesAndNewlines)
    return value.isEmpty ? nil : value
}

func loadGatewayConfig(from configURL: URL) -> GatewayConfig {
    guard let data = try? Data(contentsOf: configURL) else { return GatewayConfig() }
    guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
        return GatewayConfig()
    }

    let gateway = json["gateway"] as? [String: Any] ?? [:]
    let auth = gateway["auth"] as? [String: Any] ?? [:]
    let remote = gateway["remote"] as? [String: Any] ?? [:]
    return GatewayConfig(
        mode: gateway["mode"] as? String,
        bind: gateway["bind"] as? String,
        port: parseInt(gateway["port"]),
        remoteUrl: remote["url"] as? String,
        remotePort: parseInt(remote["remotePort"]),
        token: auth["token"] as? String,
        password: auth["password"] as? String,
        remoteToken: remote["token"] as? String,
        remotePassword: remote["password"] as? String)
}

func parseInt(_ value: Any?) -> Int? {
    switch value {
    case let number as Int:
        number
    case let number as Double:
        Int(exactly: number.rounded(.towardZero))
    case let raw as String:
        Int(raw.trimmingCharacters(in: .whitespacesAndNewlines))
    default:
        nil
    }
}
