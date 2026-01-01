import Foundation

enum ClawdisConfigFile {
    private static let logger = Logger(subsystem: "com.steipete.clawdis", category: "config")
    private static let configPathEnv = "CLAWDIS_CONFIG_PATH"
    private static let stateDirEnv = "CLAWDIS_STATE_DIR"

    static func url() -> URL {
        if let override = self.envPath(self.configPathEnv) {
            return URL(fileURLWithPath: override)
        }
        return self.stateDirURL()
            .appendingPathComponent("clawdis.json")
    }

    static func stateDirURL() -> URL {
        if let override = self.envPath(self.stateDirEnv) {
            return URL(fileURLWithPath: override, isDirectory: true)
        }
        return FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".clawdis", isDirectory: true)
    }

    static func defaultWorkspaceURL() -> URL {
        self.stateDirURL()
            .appendingPathComponent("workspace", isDirectory: true)
    }

    static func loadDict() -> [String: Any] {
        let url = self.url()
        guard FileManager.default.fileExists(atPath: url.path) else { return [:] }
        do {
            let data = try Data(contentsOf: url)
            guard let root = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
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

    private static func envPath(_ key: String) -> String? {
        guard let value = ProcessInfo.processInfo.environment[key]?.trimmingCharacters(in: .whitespacesAndNewlines),
              !value.isEmpty else {
            return nil
        }
        return value
    }
}
