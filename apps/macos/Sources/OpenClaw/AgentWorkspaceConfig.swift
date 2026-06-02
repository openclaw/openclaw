import Foundation

enum AgentWorkspaceConfig {
    static func workspace(from root: [String: Any]) -> String? {
        let agents = root["agents"] as? [String: Any]
        let defaults = agents?["defaults"] as? [String: Any]
        return defaults?["workspace"] as? String
    }

    static func setWorkspace(in root: inout [String: Any], workspace: String?) {
        var agents = root["agents"] as? [String: Any] ?? [:]
        var defaults = agents["defaults"] as? [String: Any] ?? [:]
        let trimmed = workspace?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if trimmed.isEmpty {
            defaults.removeValue(forKey: "workspace")
        } else {
            defaults["workspace"] = trimmed
        }
        if defaults.isEmpty {
            agents.removeValue(forKey: "defaults")
        } else {
            agents["defaults"] = defaults
        }
        if agents.isEmpty {
            root.removeValue(forKey: "agents")
        } else {
            root["agents"] = agents
        }
    }
}
