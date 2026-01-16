import Foundation
import OSLog

enum MacNodeConfigFile {
    private static let logger = Logger(subsystem: "com.clawdbot", category: "mac-node-config")

    static func url() -> URL {
        ClawdbotPaths.stateDirURL.appendingPathComponent("macos-node.json")
    }

    static func loadDict() -> [String: Any] {
        let url = self.url()
        guard FileManager.default.fileExists(atPath: url.path) else { return [:] }
        do {
            let data = try Data(contentsOf: url)
            guard let root = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
                self.logger.warning("mac node config JSON root invalid")
                return [:]
            }
            return root
        } catch {
            self.logger.warning("mac node config read failed: \(error.localizedDescription, privacy: .public)")
            return [:]
        }
    }

    static func saveDict(_ dict: [String: Any]) {
        do {
            let data = try JSONSerialization.data(withJSONObject: dict, options: [.prettyPrinted, .sortedKeys])
            let url = self.url()
            try FileManager.default.createDirectory(
                at: url.deletingLastPathComponent(),
                withIntermediateDirectories: true)
            try data.write(to: url, options: [.atomic])
            try? FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
        } catch {
            self.logger.error("mac node config save failed: \(error.localizedDescription, privacy: .public)")
        }
    }

    static func systemRunPolicy() -> SystemRunPolicy? {
        let root = self.loadDict()
        let systemRun = root["systemRun"] as? [String: Any]
        let raw = systemRun?["policy"] as? String
        guard let raw, let policy = SystemRunPolicy(rawValue: raw) else { return nil }
        return policy
    }

    static func setSystemRunPolicy(_ policy: SystemRunPolicy) {
        var root = self.loadDict()
        var systemRun = root["systemRun"] as? [String: Any] ?? [:]
        systemRun["policy"] = policy.rawValue
        root["systemRun"] = systemRun
        self.saveDict(root)
    }

    static func systemRunAllowlist() -> [String]? {
        let root = self.loadDict()
        let systemRun = root["systemRun"] as? [String: Any]
        return systemRun?["allowlist"] as? [String]
    }

    static func setSystemRunAllowlist(_ allowlist: [String]) {
        let cleaned = allowlist
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
        var root = self.loadDict()
        var systemRun = root["systemRun"] as? [String: Any] ?? [:]
        if cleaned.isEmpty {
            systemRun.removeValue(forKey: "allowlist")
        } else {
            systemRun["allowlist"] = cleaned
        }
        if systemRun.isEmpty {
            root.removeValue(forKey: "systemRun")
        } else {
            root["systemRun"] = systemRun
        }
        self.saveDict(root)
    }
}
