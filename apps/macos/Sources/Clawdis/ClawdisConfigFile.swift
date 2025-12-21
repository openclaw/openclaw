import Foundation

enum ClawdisConfigFile {
    static func url() -> URL {
        FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".clawdis")
            .appendingPathComponent("clawdis.json")
    }

    static func defaultWorkspaceURL() -> URL {
        FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".clawdis")
            .appendingPathComponent("workspace", isDirectory: true)
    }

    static func loadDict() -> [String: Any] {
        let url = self.url()
        guard let data = try? Data(contentsOf: url) else { return [:] }
        return (try? JSONSerialization.jsonObject(with: data) as? [String: Any]) ?? [:]
    }

    static func saveDict(_ dict: [String: Any]) {
        do {
            let data = try JSONSerialization.data(withJSONObject: dict, options: [.prettyPrinted, .sortedKeys])
            let url = self.url()
            try FileManager.default.createDirectory(
                at: url.deletingLastPathComponent(),
                withIntermediateDirectories: true)
            try data.write(to: url, options: [.atomic])
        } catch {}
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
    }

    static func inboundWorkspace() -> String? {
        let root = self.loadDict()
        let inbound = root["inbound"] as? [String: Any]
        return inbound?["workspace"] as? String
    }

    static func setInboundWorkspace(_ workspace: String?) {
        var root = self.loadDict()
        var inbound = root["inbound"] as? [String: Any] ?? [:]
        let trimmed = workspace?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if trimmed.isEmpty {
            inbound.removeValue(forKey: "workspace")
        } else {
            inbound["workspace"] = trimmed
        }
        root["inbound"] = inbound
        self.saveDict(root)
    }

    static func loadIdentity() -> AgentIdentity? {
        let root = self.loadDict()
        guard let identity = root["identity"] as? [String: Any] else { return nil }
        let name = identity["name"] as? String ?? ""
        let theme = identity["theme"] as? String ?? ""
        let emoji = identity["emoji"] as? String ?? ""
        let result = AgentIdentity(name: name, theme: theme, emoji: emoji)
        return result.isEmpty ? nil : result
    }

    static func setIdentity(_ identity: AgentIdentity?) {
        var root = self.loadDict()
        if let identity, !identity.isEmpty {
            root["identity"] = [
                "name": identity.name.trimmingCharacters(in: .whitespacesAndNewlines),
                "theme": identity.theme.trimmingCharacters(in: .whitespacesAndNewlines),
                "emoji": identity.emoji.trimmingCharacters(in: .whitespacesAndNewlines),
            ]
        } else {
            root.removeValue(forKey: "identity")
        }
        self.saveDict(root)
    }
}
