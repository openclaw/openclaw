import Foundation

enum ClawdbotConfigFile {
    private static let logger = Logger(subsystem: "com.clawdbot", category: "config")

    static func url() -> URL {
        ClawdbotPaths.configURL
    }

    static func stateDirURL() -> URL {
        ClawdbotPaths.stateDirURL
    }

    static func defaultWorkspaceURL() -> URL {
        ClawdbotPaths.workspaceURL
    }

    static func loadDict() -> [String: Any] {
        let url = self.url()
        guard FileManager.default.fileExists(atPath: url.path) else { return [:] }
        do {
            let data = try Data(contentsOf: url)
            guard let root = self.parseConfigData(data) else {
                self.logger.warning("config JSON root invalid")
                return [:]
            }
            return root
        } catch {
            self.logger.warning("config read failed: \(error.localizedDescription)")
            return [:]
        }
    }

    static func saveDict(_ dict: [String: Any]) {
        if ProcessInfo.processInfo.isNixMode { return }
        do {
            let data = try JSONSerialization.data(withJSONObject: dict, options: [.prettyPrinted, .sortedKeys])
            let url = self.url()
            try FileManager.default.createDirectory(
                at: url.deletingLastPathComponent(),
                withIntermediateDirectories: true)
            try data.write(to: url, options: [.atomic])
        } catch {
            self.logger.error("config save failed: \(error.localizedDescription)")
        }
    }

    static func loadGatewayDict() -> [String: Any] {
        let root = self.loadDict()
        return root["gateway"] as? [String: Any] ?? [:]
    }

    static func updateGatewayDict(_ mutate: (inout [String: Any]) -> Void) {
        var root = self.loadDict()
        var gateway = root["gateway"] as? [String: Any] ?? [:]
        mutate(&gateway)
        if gateway.isEmpty {
            root.removeValue(forKey: "gateway")
        } else {
            root["gateway"] = gateway
        }
        self.saveDict(root)
    }

    static func browserControlEnabled(defaultValue: Bool = true) -> Bool {
        let root = self.loadDict()
        let browser = root["browser"] as? [String: Any]
        return browser?["enabled"] as? Bool ?? defaultValue
    }

    static func setBrowserControlEnabled(_ enabled: Bool) {
        var root = self.loadDict()
        var browser = root["browser"] as? [String: Any] ?? [:]
        browser["enabled"] = enabled
        root["browser"] = browser
        self.saveDict(root)
        self.logger.debug("browser control updated enabled=\(enabled)")
    }

    static func agentWorkspace() -> String? {
        let root = self.loadDict()
        let agent = root["agent"] as? [String: Any]
        return agent?["workspace"] as? String
    }

    static func setAgentWorkspace(_ workspace: String?) {
        var root = self.loadDict()
        var agent = root["agent"] as? [String: Any] ?? [:]
        let trimmed = workspace?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if trimmed.isEmpty {
            agent.removeValue(forKey: "workspace")
        } else {
            agent["workspace"] = trimmed
        }
        root["agent"] = agent
        self.saveDict(root)
        self.logger.debug("agent workspace updated set=\(!trimmed.isEmpty)")
    }

    static func gatewayPassword() -> String? {
        let root = self.loadDict()
        guard let gateway = root["gateway"] as? [String: Any],
              let remote = gateway["remote"] as? [String: Any]
        else {
            return nil
        }
        return remote["password"] as? String
    }

    static func gatewayPort() -> Int? {
        let root = self.loadDict()
        guard let gateway = root["gateway"] as? [String: Any] else { return nil }
        if let port = gateway["port"] as? Int, port > 0 { return port }
        if let number = gateway["port"] as? NSNumber, number.intValue > 0 {
            return number.intValue
        }
        if let raw = gateway["port"] as? String,
           let parsed = Int(raw.trimmingCharacters(in: .whitespacesAndNewlines)),
           parsed > 0
        {
            return parsed
        }
        return nil
    }

    private static func parseConfigData(_ data: Data) -> [String: Any]? {
        if let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
            return root
        }
        let decoder = JSONDecoder()
        if #available(macOS 12.0, *) {
            decoder.allowsJSON5 = true
        }
        if let decoded = try? decoder.decode([String: AnyCodable].self, from: data) {
            self.logger.notice("config parsed with JSON5 decoder")
            return decoded.mapValues { $0.foundationValue }
        }
        return nil
    }
}
