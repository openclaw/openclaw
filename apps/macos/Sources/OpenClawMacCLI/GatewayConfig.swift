import Foundation

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

enum OpenClawMacCLIPaths {
    private static func envPath(_ key: String) -> String? {
        guard let raw = getenv(key) else { return nil }
        let value = String(cString: raw).trimmingCharacters(in: .whitespacesAndNewlines)
        return value.isEmpty ? nil : value
    }

    private static func fileURL(path: String, isDirectory: Bool = false) -> URL {
        URL(fileURLWithPath: NSString(string: path).expandingTildeInPath, isDirectory: isDirectory)
    }

    static var stateDirURL: URL {
        if let raw = self.envPath("OPENCLAW_STATE_DIR") {
            return self.fileURL(path: raw, isDirectory: true)
        }
        return FileManager().homeDirectoryForCurrentUser.appendingPathComponent(".openclaw", isDirectory: true)
    }

    static var configURL: URL {
        if let raw = self.envPath("OPENCLAW_CONFIG_PATH") {
            return self.fileURL(path: raw)
        }
        return self.stateDirURL.appendingPathComponent("openclaw.json")
    }
}

func loadGatewayConfig() -> GatewayConfig {
    let url = OpenClawMacCLIPaths.configURL
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
