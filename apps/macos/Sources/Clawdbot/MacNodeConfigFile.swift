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

    private static func systemRunSection(from root: [String: Any]) -> [String: Any] {
        root["systemRun"] as? [String: Any] ?? [:]
    }

    private static func updateSystemRunSection(_ mutate: (inout [String: Any]) -> Void) {
        var root = self.loadDict()
        var systemRun = self.systemRunSection(from: root)
        mutate(&systemRun)
        if systemRun.isEmpty {
            root.removeValue(forKey: "systemRun")
        } else {
            root["systemRun"] = systemRun
        }
        self.saveDict(root)
    }

    private static func agentSection(_ systemRun: [String: Any], agentId: String) -> [String: Any]? {
        let agents = systemRun["agents"] as? [String: Any]
        return agents?[agentId] as? [String: Any]
    }

    private static func updateAgentSection(
        _ systemRun: inout [String: Any],
        agentId: String,
        mutate: (inout [String: Any]) -> Void)
    {
        var agents = systemRun["agents"] as? [String: Any] ?? [:]
        var entry = agents[agentId] as? [String: Any] ?? [:]
        mutate(&entry)
        if entry.isEmpty {
            agents.removeValue(forKey: agentId)
        } else {
            agents[agentId] = entry
        }
        if agents.isEmpty {
            systemRun.removeValue(forKey: "agents")
        } else {
            systemRun["agents"] = agents
        }
    }

    static func systemRunPolicy(agentId: String? = nil) -> SystemRunPolicy? {
        let root = self.loadDict()
        let systemRun = self.systemRunSection(from: root)
        if let agentId, let agent = self.agentSection(systemRun, agentId: agentId) {
            let raw = agent["policy"] as? String
            if let raw, let policy = SystemRunPolicy(rawValue: raw) { return policy }
        }
        let raw = systemRun["policy"] as? String
        guard let raw, let policy = SystemRunPolicy(rawValue: raw) else { return nil }
        return policy
    }

    static func setSystemRunPolicy(_ policy: SystemRunPolicy, agentId: String? = nil) {
        self.updateSystemRunSection { systemRun in
            if let agentId {
                self.updateAgentSection(&systemRun, agentId: agentId) { entry in
                    entry["policy"] = policy.rawValue
                }
                return
            }
            systemRun["policy"] = policy.rawValue
        }
    }

    static func systemRunAutoAllowSkills(agentId: String?) -> Bool? {
        let root = self.loadDict()
        let systemRun = self.systemRunSection(from: root)
        if let agentId, let agent = self.agentSection(systemRun, agentId: agentId) {
            if let value = agent["autoAllowSkills"] as? Bool { return value }
        }
        return systemRun["autoAllowSkills"] as? Bool
    }

    static func setSystemRunAutoAllowSkills(_ enabled: Bool, agentId: String?) {
        self.updateSystemRunSection { systemRun in
            if let agentId {
                self.updateAgentSection(&systemRun, agentId: agentId) { entry in
                    entry["autoAllowSkills"] = enabled
                }
                return
            }
            systemRun["autoAllowSkills"] = enabled
        }
    }

    static func systemRunAllowlist(agentId: String?) -> [SystemRunAllowlistEntry]? {
        let root = self.loadDict()
        let systemRun = self.systemRunSection(from: root)
        let raw: [Any]? = {
            if let agentId, let agent = self.agentSection(systemRun, agentId: agentId) {
                return agent["allowlist"] as? [Any]
            }
            return systemRun["allowlist"] as? [Any]
        }()
        guard let raw else { return nil }

        if raw.allSatisfy({ $0 is String }) {
            let legacy = raw.compactMap { $0 as? String }
            return legacy.compactMap { key in
                let pattern = key.trimmingCharacters(in: .whitespacesAndNewlines)
                guard !pattern.isEmpty else { return nil }
                return SystemRunAllowlistEntry(
                    pattern: pattern,
                    enabled: true,
                    matchKind: .argv,
                    source: .manual)
            }
        }

        return raw.compactMap { item in
            guard let dict = item as? [String: Any] else { return nil }
            return SystemRunAllowlistEntry(dict: dict)
        }
    }

    static func setSystemRunAllowlist(_ allowlist: [SystemRunAllowlistEntry], agentId: String?) {
        let cleaned = allowlist
            .map { $0 }
            .filter { !$0.pattern.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
        let raw = cleaned.map { $0.asDict() }
        self.updateSystemRunSection { systemRun in
            if let agentId {
                self.updateAgentSection(&systemRun, agentId: agentId) { entry in
                    if raw.isEmpty {
                        entry.removeValue(forKey: "allowlist")
                    } else {
                        entry["allowlist"] = raw
                    }
                }
                return
            }
            if raw.isEmpty {
                systemRun.removeValue(forKey: "allowlist")
            } else {
                systemRun["allowlist"] = raw
            }
        }
    }

    static func systemRunAllowlistStrings() -> [String]? {
        let root = self.loadDict()
        let systemRun = self.systemRunSection(from: root)
        return systemRun["allowlist"] as? [String]
    }

    static func setSystemRunAllowlistStrings(_ allowlist: [String]) {
        let cleaned = allowlist
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
        self.updateSystemRunSection { systemRun in
            if cleaned.isEmpty {
                systemRun.removeValue(forKey: "allowlist")
            } else {
                systemRun["allowlist"] = cleaned
            }
        }
    }
}
