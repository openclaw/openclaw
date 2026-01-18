import Foundation

enum SystemRunAllowlistMatchKind: String {
    case glob
    case argv
}

enum SystemRunAllowlistSource: String {
    case manual
    case skill
}

struct SystemRunAllowlistEntry: Identifiable, Hashable {
    let id: String
    var pattern: String
    var enabled: Bool
    var matchKind: SystemRunAllowlistMatchKind
    var source: SystemRunAllowlistSource?
    var skillId: String?
    var lastUsedAt: Date?
    var lastUsedCommand: String?
    var lastUsedPath: String?

    init(
        id: String = UUID().uuidString,
        pattern: String,
        enabled: Bool = true,
        matchKind: SystemRunAllowlistMatchKind = .glob,
        source: SystemRunAllowlistSource? = .manual,
        skillId: String? = nil,
        lastUsedAt: Date? = nil,
        lastUsedCommand: String? = nil,
        lastUsedPath: String? = nil)
    {
        self.id = id
        self.pattern = pattern
        self.enabled = enabled
        self.matchKind = matchKind
        self.source = source
        self.skillId = skillId
        self.lastUsedAt = lastUsedAt
        self.lastUsedCommand = lastUsedCommand
        self.lastUsedPath = lastUsedPath
    }

    init?(dict: [String: Any]) {
        let id = dict["id"] as? String ?? UUID().uuidString
        let pattern = (dict["pattern"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if pattern.isEmpty { return nil }
        let enabled = dict["enabled"] as? Bool ?? true
        let matchRaw = dict["matchKind"] as? String
        let matchKind = SystemRunAllowlistMatchKind(rawValue: matchRaw ?? "") ?? .glob
        let sourceRaw = dict["source"] as? String
        let source = SystemRunAllowlistSource(rawValue: sourceRaw ?? "")
        let skillId = (dict["skillId"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines)
        let lastUsedAt = (dict["lastUsedAt"] as? Double).map { Date(timeIntervalSince1970: $0) }
        let lastUsedCommand = dict["lastUsedCommand"] as? String
        let lastUsedPath = dict["lastUsedPath"] as? String

        self.init(
            id: id,
            pattern: pattern,
            enabled: enabled,
            matchKind: matchKind,
            source: source,
            skillId: skillId?.isEmpty == true ? nil : skillId,
            lastUsedAt: lastUsedAt,
            lastUsedCommand: lastUsedCommand,
            lastUsedPath: lastUsedPath)
    }

    func asDict() -> [String: Any] {
        var dict: [String: Any] = [
            "id": self.id,
            "pattern": self.pattern,
            "enabled": self.enabled,
            "matchKind": self.matchKind.rawValue,
        ]
        if let source = self.source { dict["source"] = source.rawValue }
        if let skillId = self.skillId { dict["skillId"] = skillId }
        if let lastUsedAt = self.lastUsedAt { dict["lastUsedAt"] = lastUsedAt.timeIntervalSince1970 }
        if let lastUsedCommand = self.lastUsedCommand { dict["lastUsedCommand"] = lastUsedCommand }
        if let lastUsedPath = self.lastUsedPath { dict["lastUsedPath"] = lastUsedPath }
        return dict
    }
}

struct SystemRunCommandResolution: Sendable {
    let rawExecutable: String
    let resolvedPath: String?
    let executableName: String
    let cwd: String?

    static func resolve(command: [String], cwd: String?) -> SystemRunCommandResolution? {
        guard let raw = command.first?.trimmingCharacters(in: .whitespacesAndNewlines), !raw.isEmpty else {
            return nil
        }
        let expanded = raw.hasPrefix("~") ? (raw as NSString).expandingTildeInPath : raw
        let hasPathSeparator = expanded.contains("/")
        let resolvedPath: String? = {
            if hasPathSeparator {
                if expanded.hasPrefix("/") {
                    return expanded
                }
                let base = cwd?.trimmingCharacters(in: .whitespacesAndNewlines)
                let root = (base?.isEmpty == false) ? base! : FileManager.default.currentDirectoryPath
                return URL(fileURLWithPath: root).appendingPathComponent(expanded).path
            }
            return CommandResolver.findExecutable(named: expanded)
        }()
        let name = resolvedPath.map { URL(fileURLWithPath: $0).lastPathComponent } ?? expanded
        return SystemRunCommandResolution(rawExecutable: expanded, resolvedPath: resolvedPath, executableName: name, cwd: cwd)
    }
}

enum SystemRunAllowlistStore {
    static func load(agentId: String?) -> [SystemRunAllowlistEntry] {
        if let entries = MacNodeConfigFile.systemRunAllowlist(agentId: agentId) {
            return entries
        }
        return []
    }

    static func save(_ entries: [SystemRunAllowlistEntry], agentId: String?) {
        MacNodeConfigFile.setSystemRunAllowlist(entries, agentId: agentId)
    }

    static func add(pattern: String, agentId: String?, source: SystemRunAllowlistSource = .manual) -> SystemRunAllowlistEntry {
        var entries = self.load(agentId: agentId)
        let entry = SystemRunAllowlistEntry(pattern: pattern, enabled: true, matchKind: .glob, source: source)
        entries.append(entry)
        self.save(entries, agentId: agentId)
        return entry
    }

    static func update(_ entry: SystemRunAllowlistEntry, agentId: String?) {
        var entries = self.load(agentId: agentId)
        guard let index = entries.firstIndex(where: { $0.id == entry.id }) else { return }
        entries[index] = entry
        self.save(entries, agentId: agentId)
    }

    static func remove(entryId: String, agentId: String?) {
        let entries = self.load(agentId: agentId).filter { $0.id != entryId }
        self.save(entries, agentId: agentId)
    }

    static func markUsed(entryId: String, command: [String], resolvedPath: String?, agentId: String?) {
        var entries = self.load(agentId: agentId)
        guard let index = entries.firstIndex(where: { $0.id == entryId }) else { return }
        entries[index].lastUsedAt = Date()
        entries[index].lastUsedCommand = SystemRunAllowlist.displayString(for: command)
        entries[index].lastUsedPath = resolvedPath
        self.save(entries, agentId: agentId)
    }

    static func match(
        command: [String],
        resolution: SystemRunCommandResolution?,
        entries: [SystemRunAllowlistEntry]) -> SystemRunAllowlistEntry?
    {
        guard !entries.isEmpty else { return nil }
        let argvKey = SystemRunAllowlist.legacyKey(for: command)
        let resolvedPath = resolution?.resolvedPath
        let executableName = resolution?.executableName
        let rawExecutable = resolution?.rawExecutable

        for entry in entries {
            guard entry.enabled else { continue }
            switch entry.matchKind {
            case .argv:
                if argvKey == entry.pattern { return entry }
            case .glob:
                let pattern = entry.pattern.trimmingCharacters(in: .whitespacesAndNewlines)
                if pattern.isEmpty { continue }
                let hasPath = pattern.contains("/") || pattern.contains("~")
                if hasPath {
                    let target = resolvedPath ?? rawExecutable
                    if let target, SystemRunGlob.matches(pattern: pattern, target: target) {
                        return entry
                    }
                } else if let name = executableName, SystemRunGlob.matches(pattern: pattern, target: name) {
                    return entry
                }
            }
        }
        return nil
    }
}

enum SystemRunGlob {
    static func matches(pattern rawPattern: String, target: String) -> Bool {
        let trimmed = rawPattern.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return false }
        let expanded = trimmed.hasPrefix("~") ? (trimmed as NSString).expandingTildeInPath : trimmed
        guard let regex = self.regex(for: expanded) else { return false }
        let range = NSRange(location: 0, length: target.utf16.count)
        return regex.firstMatch(in: target, options: [], range: range) != nil
    }

    private static func regex(for pattern: String) -> NSRegularExpression? {
        var regex = "^"
        var idx = pattern.startIndex
        while idx < pattern.endIndex {
            let ch = pattern[idx]
            if ch == "*" {
                let next = pattern.index(after: idx)
                if next < pattern.endIndex, pattern[next] == "*" {
                    regex += ".*"
                    idx = pattern.index(after: next)
                } else {
                    regex += "[^/]*"
                    idx = next
                }
                continue
            }
            if ch == "?" {
                regex += "."
                idx = pattern.index(after: idx)
                continue
            }
            regex += NSRegularExpression.escapedPattern(for: String(ch))
            idx = pattern.index(after: idx)
        }
        regex += "$"
        return try? NSRegularExpression(pattern: regex)
    }
}

actor SkillBinsCache {
    static let shared = SkillBinsCache()

    private var bins: Set<String> = []
    private var lastRefresh: Date?
    private let refreshInterval: TimeInterval = 90

    func currentBins(force: Bool = false) async -> Set<String> {
        if force || self.isStale() {
            await self.refresh()
        }
        return self.bins
    }

    func refresh() async {
        do {
            let report = try await GatewayConnection.shared.skillsStatus()
            var next = Set<String>()
            for skill in report.skills {
                for bin in skill.requirements.bins {
                    let trimmed = bin.trimmingCharacters(in: .whitespacesAndNewlines)
                    if !trimmed.isEmpty { next.insert(trimmed) }
                }
            }
            self.bins = next
            self.lastRefresh = Date()
        } catch {
            if self.lastRefresh == nil {
                self.bins = []
            }
        }
    }

    private func isStale() -> Bool {
        guard let lastRefresh else { return true }
        return Date().timeIntervalSince(lastRefresh) > self.refreshInterval
    }
}
