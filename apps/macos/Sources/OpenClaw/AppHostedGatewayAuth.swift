import Foundation
import Security

enum AppHostedGatewayAuth {
    enum Decision {
        case persist
        case keep
    }

    enum DotEnvFile {
        case missing
        case unreadable
        case contents(String)
    }

    static func decision(
        root: [String: Any]?,
        environment: [String: String],
        trustedDotEnvFiles: [DotEnvFile] = []) -> Decision
    {
        guard let root,
              environment["OPENCLAW_GATEWAY_TOKEN"]?.nonEmpty == nil,
              environment["OPENCLAW_GATEWAY_PASSWORD"]?.nonEmpty == nil,
              !self.isTruthy(environment["OPENCLAW_LOAD_SHELL_ENV"]),
              !trustedDotEnvFiles.contains(where: self.dotEnvMaySupplyCredential)
        else { return .keep }
        // Malformed authored sections belong to config validation, not first-run repair.
        if let gateway = root["gateway"], !(gateway is [String: Any]) { return .keep }
        let gateway = root["gateway"] as? [String: Any] ?? [:]
        if let auth = gateway["auth"], !(auth is [String: Any]) { return .keep }
        let auth = gateway["auth"] as? [String: Any] ?? [:]
        if let remote = gateway["remote"] {
            guard let remote = remote as? [String: Any],
                  remote["$include"] == nil, remote["token"] == nil, remote["password"] == nil
            else { return .keep }
        }
        // This reads the authored file, not the resolved config: includes and config env vars can
        // supply credentials (and include siblings override included values), so keep those sources.
        guard [root, gateway, auth].allSatisfy({ $0["$include"] == nil }),
              !self.configEnvMaySupplyCredential(root["env"])
        else { return .keep }
        if let mode = auth["mode"], mode as? String != "token" { return .keep }
        if let token = auth["token"] {
            guard let string = token as? String, string.nonEmpty == nil else { return .keep }
        }
        guard auth["password"] == nil else { return .keep }
        return .persist
    }

    /// Mirrors collectConfigRuntimeEnvVars (`env.vars` and direct `env` string keys, case-insensitive;
    /// direct keys win at runtime, so check both sources independently). Includes or malformed shapes keep.
    private static func configEnvMaySupplyCredential(_ env: Any?) -> Bool {
        guard let env else { return false }
        guard let env = env as? [String: Any] else { return true }
        let vars = env["vars"]
        if let vars, !(vars is [String: Any]) { return true }
        if let shell = env["shellEnv"] {
            guard let shell = shell as? [String: Any], shell["$include"] == nil else { return true }
            if let enabled = shell["enabled"], (enabled as? Bool) != false { return true }
        }
        return [env, vars as? [String: Any] ?? [:]].contains { source in
            source["$include"] != nil || source.contains { key, value in
                let key = key.uppercased()
                let value = (value as? String)?.nonEmpty
                return (self.credentialSourceKeys.contains(key) && value != nil) ||
                    (key == "OPENCLAW_LOAD_SHELL_ENV" && self.isTruthy(value))
            }
        }
    }

    /// Path selectors can redirect subsequent trusted dotenv reads; do not resolve those here.
    private static let credentialSourceKeys: Set<String> = [
        "OPENCLAW_GATEWAY_TOKEN", "OPENCLAW_GATEWAY_PASSWORD", "OPENCLAW_HOME", "HOME", "USERPROFILE",
        "OPENCLAW_STATE_DIR", "OPENCLAW_CONFIG_PATH",
    ]

    private static func isTruthy(_ value: String?) -> Bool {
        ["true", "1", "yes", "on"].contains(value?.nonEmpty?.lowercased() ?? "")
    }

    private static func dotEnvMaySupplyCredential(_ file: DotEnvFile) -> Bool {
        switch file {
        case .missing: return false
        case .unreadable: return true
        case let .contents(contents):
            for line in contents.components(separatedBy: .newlines) {
                var line = line.trimmingCharacters(in: .whitespaces)
                if line.hasPrefix("export ") || line.hasPrefix("export\t") {
                    line = String(line.dropFirst(6)).trimmingCharacters(in: .whitespaces)
                }
                let key = String(line.prefix { $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "_") })
                    .uppercased()
                if self.credentialSourceKeys.contains(key) || key == "OPENCLAW_LOAD_SHELL_ENV" { return true }
            }
            return false
        }
    }

    /// Mirrors resolveConfigDir and resolveGlobalDotEnvFiles for the child's absolute paths.
    /// Relative or unavailable home/path inputs cannot be proven without the child's cwd.
    static func trustedDotEnvURLs(environment: [String: String]) -> [URL]? {
        func homeValue(_ key: String) -> String? {
            guard let value = environment[key]?.nonEmpty, value != "undefined", value != "null" else { return nil }
            return value
        }
        let osHome = homeValue("HOME") ?? homeValue("USERPROFILE")
        var home = homeValue("OPENCLAW_HOME") ?? osHome
        if let value = home, value == "~" || value.hasPrefix("~/") || value.hasPrefix("~\\") {
            guard let osHome else { return nil }
            home = osHome + value.dropFirst()
        }
        guard let home, home.hasPrefix("/") else { return nil }
        let homeURL = URL(fileURLWithPath: home, isDirectory: true).standardizedFileURL
        func resolve(_ path: String) -> URL? {
            let expanded: String = if path == "~" || path.hasPrefix("~/") || path.hasPrefix("~\\") {
                homeURL.path + path.dropFirst()
            } else {
                path
            }
            guard expanded.hasPrefix("/") else { return nil }
            return URL(fileURLWithPath: expanded).standardizedFileURL
        }
        let defaultState = homeURL.appendingPathComponent(".openclaw", isDirectory: true)
        let state: URL
        if let path = environment["OPENCLAW_STATE_DIR"]?.nonEmpty {
            guard let resolved = resolve(path) else { return nil }
            state = resolved
        } else if let path = environment["OPENCLAW_CONFIG_PATH"]?.nonEmpty {
            guard let resolved = resolve(path) else { return nil }
            state = resolved.deletingLastPathComponent()
        } else {
            state = defaultState
        }
        var files = [state.appendingPathComponent(".env")]
        // Gateway pre-bootstrap also loads the default state .env when only config is overridden.
        if environment["OPENCLAW_STATE_DIR"]?.nonEmpty == nil, state.path != defaultState.path {
            files.insert(defaultState.appendingPathComponent(".env"), at: 0)
        }
        if environment["OPENCLAW_STATE_DIR"]?.nonEmpty == nil || state.path == defaultState.path {
            files.append(homeURL.appendingPathComponent(".config/openclaw/gateway.env"))
        }
        return files
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
