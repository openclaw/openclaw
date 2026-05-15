import Foundation

struct AmbientCommandRegistry {
    static let `default` = AmbientCommandRegistry(commands: [
        AmbientCommandSpec(
            name: "help",
            aliases: ["?"],
            group: .core,
            description: "Show available commands",
            argumentHint: nil),
        AmbientCommandSpec(
            name: "clear",
            aliases: [],
            group: .core,
            description: "Clear the composer result",
            argumentHint: nil),
        AmbientCommandSpec(
            name: "dismiss",
            aliases: ["close"],
            group: .core,
            description: "Dismiss Ambient Overlay",
            argumentHint: nil),
        AmbientCommandSpec(
            name: "status",
            aliases: [],
            group: .core,
            description: "Show gateway and session status",
            argumentHint: nil),
        AmbientCommandSpec(
            name: "canvas",
            aliases: [],
            group: .surfaces,
            description: "Open or close Canvas",
            argumentHint: nil),
        AmbientCommandSpec(
            name: "chat",
            aliases: ["webui"],
            group: .surfaces,
            description: "Open Chat",
            argumentHint: nil),
        AmbientCommandSpec(
            name: "dashboard",
            aliases: [],
            group: .surfaces,
            description: "Open Dashboard",
            argumentHint: nil),
        AmbientCommandSpec(
            name: "settings",
            aliases: ["prefs"],
            group: .surfaces,
            description: "Open Settings",
            argumentHint: nil),
        AmbientCommandSpec(
            name: "agent-events",
            aliases: ["events"],
            group: .surfaces,
            description: "Open Agent Events",
            argumentHint: nil),
        AmbientCommandSpec(
            name: "talk",
            aliases: [],
            group: .voice,
            description: "Toggle Talk Mode",
            argumentHint: nil),
        AmbientCommandSpec(
            name: "voice-wake",
            aliases: ["wake"],
            group: .voice,
            description: "Toggle Voice Wake",
            argumentHint: nil),
        AmbientCommandSpec(
            name: "mic",
            aliases: [],
            group: .voice,
            description: "Open microphone settings",
            argumentHint: nil),
        AmbientCommandSpec(
            name: "health",
            aliases: [],
            group: .gateway,
            description: "Run a health check",
            argumentHint: nil),
        AmbientCommandSpec(
            name: "restart-gateway",
            aliases: ["restart"],
            group: .gateway,
            description: "Restart the gateway",
            argumentHint: nil),
        AmbientCommandSpec(
            name: "reset-tunnel",
            aliases: ["tunnel"],
            group: .gateway,
            description: "Reset the remote tunnel",
            argumentHint: nil),
        AmbientCommandSpec(
            name: "logs",
            aliases: ["log"],
            group: .gateway,
            description: "Open current log file",
            argumentHint: nil),
        AmbientCommandSpec(
            name: "config",
            aliases: [],
            group: .gateway,
            description: "Open config folder",
            argumentHint: nil),
        AmbientCommandSpec(
            name: "session-store",
            aliases: ["store"],
            group: .gateway,
            description: "Open session store",
            argumentHint: nil),
        AmbientCommandSpec(
            name: "sessions",
            aliases: [],
            group: .sessions,
            description: "Open session settings",
            argumentHint: nil),
        AmbientCommandSpec(
            name: "main",
            aliases: [],
            group: .sessions,
            description: "Use the main session",
            argumentHint: nil),
        AmbientCommandSpec(
            name: "new",
            aliases: [],
            group: .sessions,
            description: "Open Chat for a new session",
            argumentHint: nil),
        AmbientCommandSpec(
            name: "compact",
            aliases: [],
            group: .sessions,
            description: "Compact the active session",
            argumentHint: nil),
        AmbientCommandSpec(
            name: "reset-session",
            aliases: [],
            group: .sessions,
            description: "Reset the active session",
            argumentHint: nil),
        AmbientCommandSpec(
            name: "approvals",
            aliases: [],
            group: .modes,
            description: "Open approval settings",
            argumentHint: nil),
        AmbientCommandSpec(
            name: "browser",
            aliases: [],
            group: .modes,
            description: "Toggle browser control",
            argumentHint: nil),
        AmbientCommandSpec(
            name: "camera",
            aliases: [],
            group: .modes,
            description: "Toggle camera access",
            argumentHint: nil),
        AmbientCommandSpec(
            name: "ambient",
            aliases: [],
            group: .modes,
            description: "Toggle Ambient Overlay",
            argumentHint: nil),
        AmbientCommandSpec(
            name: "display",
            aliases: [],
            group: .modes,
            description: "Set display scope",
            argumentHint: "current|all"),
        AmbientCommandSpec(
            name: "intensity",
            aliases: [],
            group: .modes,
            description: "Set overlay intensity",
            argumentHint: "10-100"),
        AmbientCommandSpec(
            name: "cron",
            aliases: [],
            group: .automation,
            description: "Open cron settings",
            argumentHint: nil),
        AmbientCommandSpec(
            name: "actions",
            aliases: [],
            group: .automation,
            description: "Show queued actions",
            argumentHint: nil),
        AmbientCommandSpec(
            name: "skills",
            aliases: [],
            group: .automation,
            description: "Open skills settings",
            argumentHint: nil),
        AmbientCommandSpec(
            name: "nodes",
            aliases: [],
            group: .automation,
            description: "Open nodes/instances",
            argumentHint: nil),
    ])

    let commands: [AmbientCommandSpec]

    func parse(_ raw: String) -> AmbientParsedInput {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return .empty }
        guard trimmed.hasPrefix("/") else { return .prompt(trimmed) }

        let body = String(trimmed.dropFirst()).trimmingCharacters(in: .whitespacesAndNewlines)
        guard !body.isEmpty else { return .unknown(name: "", suggestions: self.suggestions(for: "/")) }

        let parts = body.split(maxSplits: 1, whereSeparator: { $0.isWhitespace })
        let name = String(parts[0]).lowercased()
        let arguments = parts.count > 1
            ? String(parts[1]).trimmingCharacters(in: .whitespacesAndNewlines)
            : ""

        if self.command(named: name) != nil {
            return .command(name: name, arguments: arguments)
        }

        return .unknown(name: name, suggestions: self.suggestions(for: "/\(name)"))
    }

    func suggestions(for raw: String) -> [AmbientCommandSpec] {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        let prefix = String(trimmed.dropFirst(trimmed.hasPrefix("/") ? 1 : 0)).lowercased()

        let matches = self.commands.filter { spec in
            prefix.isEmpty
                || spec.name.hasPrefix(prefix)
                || spec.aliases.contains(where: { $0.hasPrefix(prefix) })
                || Self.isFuzzyPrefix(prefix, of: spec.name)
                || spec.aliases.contains(where: { Self.isFuzzyPrefix(prefix, of: $0) })
        }

        return matches.sorted { lhs, rhs in
            if lhs.group != rhs.group { return lhs.group.rawValue < rhs.group.rawValue }
            return lhs.name < rhs.name
        }
    }

    func command(named raw: String) -> AmbientCommandSpec? {
        let name = raw.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        return self.commands.first { $0.name == name || $0.aliases.contains(name) }
    }

    private static func isFuzzyPrefix(_ prefix: String, of candidate: String) -> Bool {
        guard prefix.count >= 3 else { return false }
        let candidatePrefix = String(candidate.prefix(prefix.count))
        guard candidatePrefix.first == prefix.first else { return false }
        return Self.levenshtein(prefix, candidatePrefix) <= 2
    }

    private static func levenshtein(_ lhs: String, _ rhs: String) -> Int {
        let a = Array(lhs)
        let b = Array(rhs)
        if a.isEmpty { return b.count }
        if b.isEmpty { return a.count }

        var previous = Array(0...b.count)
        var current = Array(repeating: 0, count: b.count + 1)

        for i in 1...a.count {
            current[0] = i
            for j in 1...b.count {
                let cost = a[i - 1] == b[j - 1] ? 0 : 1
                current[j] = min(
                    previous[j] + 1,
                    current[j - 1] + 1,
                    previous[j - 1] + cost)
            }
            previous = current
        }

        return previous[b.count]
    }
}
