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

    static func load(agentId: String? = nil, from defaults: UserDefaults = .standard) -> SystemRunPolicy {
        if let policy = MacNodeConfigFile.systemRunPolicy(agentId: agentId) {
            return policy
        }
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
    static func legacyKey(for argv: [String]) -> String {
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

    static func loadLegacy(from defaults: UserDefaults = .standard) -> Set<String> {
        if let allowlist = MacNodeConfigFile.systemRunAllowlistStrings() {
            return Set(allowlist)
        }
        if let legacy = defaults.stringArray(forKey: systemRunAllowlistKey), !legacy.isEmpty {
            MacNodeConfigFile.setSystemRunAllowlistStrings(legacy)
            return Set(legacy)
        }
        return []
    }
}
