import Foundation

enum SystemRunPolicy: String, CaseIterable, Identifiable {
    case never
    case ask
    case always

    var id: String { self.rawValue }

    var title: String {
        switch self {
        case .never:
            "Never"
        case .ask:
            "Always Ask"
        case .always:
            "Always Allow"
        }
    }

    static func load(from defaults: UserDefaults = .standard) -> SystemRunPolicy {
        if let policy = MacNodeConfigFile.systemRunPolicy() {
            return policy
        }
        if let raw = defaults.string(forKey: systemRunPolicyKey),
           let policy = SystemRunPolicy(rawValue: raw)
        {
            MacNodeConfigFile.setSystemRunPolicy(policy)
            return policy
        }
        if let legacy = defaults.object(forKey: systemRunEnabledKey) as? Bool {
            let policy: SystemRunPolicy = legacy ? .ask : .never
            MacNodeConfigFile.setSystemRunPolicy(policy)
            return policy
        }
        let fallback: SystemRunPolicy = .ask
        MacNodeConfigFile.setSystemRunPolicy(fallback)
        return fallback
    }
}

enum SystemRunAllowlist {
    static func key(for argv: [String]) -> String {
        let trimmed = argv.map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
        guard !trimmed.isEmpty else { return "" }
        if let data = try? JSONEncoder().encode(trimmed),
           let json = String(data: data, encoding: .utf8)
        {
            return json
        }
        return trimmed.joined(separator: " ")
    }

    static func displayString(for argv: [String]) -> String {
        argv.map { arg in
            let trimmed = arg.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !trimmed.isEmpty else { return "\"\"" }
            let needsQuotes = trimmed.contains { $0.isWhitespace || $0 == "\"" }
            if !needsQuotes { return trimmed }
            let escaped = trimmed.replacingOccurrences(of: "\"", with: "\\\"")
            return "\"\(escaped)\""
        }.joined(separator: " ")
    }

    static func load(from defaults: UserDefaults = .standard) -> Set<String> {
        if let allowlist = MacNodeConfigFile.systemRunAllowlist() {
            return Set(allowlist)
        }
        if let legacy = defaults.stringArray(forKey: systemRunAllowlistKey), !legacy.isEmpty {
            MacNodeConfigFile.setSystemRunAllowlist(legacy)
            return Set(legacy)
        }
        return []
    }

    static func contains(_ argv: [String], defaults: UserDefaults = .standard) -> Bool {
        let key = key(for: argv)
        return self.load(from: defaults).contains(key)
    }

    static func add(_ argv: [String], defaults: UserDefaults = .standard) {
        let key = key(for: argv)
        guard !key.isEmpty else { return }
        var allowlist = self.load(from: defaults)
        if allowlist.insert(key).inserted {
            MacNodeConfigFile.setSystemRunAllowlist(Array(allowlist).sorted())
        }
    }
}
