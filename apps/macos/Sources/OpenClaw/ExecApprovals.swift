import CryptoKit
import Foundation
import OSLog
import Security

enum ExecSecurity: String, CaseIterable, Codable, Identifiable {
    case deny
    case allowlist
    case full

    var id: String {
        self.rawValue
    }

    var title: String {
        switch self {
        case .deny: "Deny"
        case .allowlist: "Allowlist"
        case .full: "Always Allow"
        }
    }
}

enum ExecApprovalQuickMode: String, CaseIterable, Identifiable {
    case deny
    case ask
    case allow

    var id: String {
        self.rawValue
    }

    var title: String {
        switch self {
        case .deny: "Deny"
        case .ask: "Always Ask"
        case .allow: "Always Allow"
        }
    }

    var security: ExecSecurity {
        switch self {
        case .deny: .deny
        case .ask: .allowlist
        case .allow: .full
        }
    }

    var ask: ExecAsk {
        switch self {
        case .deny: .off
        case .ask: .onMiss
        case .allow: .off
        }
    }

    static func from(security: ExecSecurity, ask: ExecAsk) -> ExecApprovalQuickMode {
        switch security {
        case .deny:
            .deny
        case .full:
            .allow
        case .allowlist:
            .ask
        }
    }
}

enum ExecAsk: String, CaseIterable, Codable, Identifiable {
    case off
    case onMiss = "on-miss"
    case always

    var id: String {
        self.rawValue
    }

    var title: String {
        switch self {
        case .off: "Never Ask"
        case .onMiss: "Ask on Allowlist Miss"
        case .always: "Always Ask"
        }
    }
}

enum ExecApprovalDecision: String, Codable, Sendable {
    case allowOnce = "allow-once"
    case allowAlways = "allow-always"
    case deny
}

struct ExecAllowlistEntry: Codable, Hashable, Identifiable {
    var id: UUID
    var pattern: String
    var lastUsedAt: Double?
    var lastUsedCommand: String?
    var lastResolvedPath: String?

    init(
        id: UUID = UUID(),
        pattern: String,
        lastUsedAt: Double? = nil,
        lastUsedCommand: String? = nil,
        lastResolvedPath: String? = nil)
    {
        self.id = id
        self.pattern = pattern
        self.lastUsedAt = lastUsedAt
        self.lastUsedCommand = lastUsedCommand
        self.lastResolvedPath = lastResolvedPath
    }

    private enum CodingKeys: String, CodingKey {
        case id
        case pattern
        case lastUsedAt
        case lastUsedCommand
        case lastResolvedPath
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        self.id = try container.decodeIfPresent(UUID.self, forKey: .id) ?? UUID()
        self.pattern = try container.decode(String.self, forKey: .pattern)
        self.lastUsedAt = try container.decodeIfPresent(Double.self, forKey: .lastUsedAt)
        self.lastUsedCommand = try container.decodeIfPresent(String.self, forKey: .lastUsedCommand)
        self.lastResolvedPath = try container.decodeIfPresent(String.self, forKey: .lastResolvedPath)
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(self.id, forKey: .id)
        try container.encode(self.pattern, forKey: .pattern)
        try container.encodeIfPresent(self.lastUsedAt, forKey: .lastUsedAt)
        try container.encodeIfPresent(self.lastUsedCommand, forKey: .lastUsedCommand)
        try container.encodeIfPresent(self.lastResolvedPath, forKey: .lastResolvedPath)
    }
}

struct ExecApprovalsDefaults: Codable {
    var security: ExecSecurity?
    var ask: ExecAsk?
    var askFallback: ExecSecurity?
    var autoAllowSkills: Bool?
}

struct ExecApprovalsAgent: Codable {
    var security: ExecSecurity?
    var ask: ExecAsk?
    var askFallback: ExecSecurity?
    var autoAllowSkills: Bool?
    var allowlist: [ExecAllowlistEntry]?

    var isEmpty: Bool {
        self.security == nil && self.ask == nil && self.askFallback == nil && self
            .autoAllowSkills == nil && (self.allowlist?.isEmpty ?? true)
    }
}

struct ExecApprovalsSocketConfig: Codable {
    var path: String?
    var token: String?
}

struct ExecApprovalsFile: Codable {
    var version: Int
    var socket: ExecApprovalsSocketConfig?
    var defaults: ExecApprovalsDefaults?
    var agents: [String: ExecApprovalsAgent]?
}

struct ExecApprovalsSnapshot: Codable {
    var path: String
    var exists: Bool
    var hash: String
    var file: ExecApprovalsFile
}

struct ExecApprovalsResolved {
    let url: URL
    let socketPath: String
    let token: String
    let defaults: ExecApprovalsResolvedDefaults
    let agent: ExecApprovalsResolvedDefaults
    let allowlist: [ExecAllowlistEntry]
    var file: ExecApprovalsFile
}

struct ExecApprovalsResolvedDefaults {
    var security: ExecSecurity
    var ask: ExecAsk
    var askFallback: ExecSecurity
    var autoAllowSkills: Bool
}

enum ExecApprovalsStore {
    private static let logger = Logger(subsystem: "ai.openclaw", category: "exec-approvals")
    private static let defaultAgentId = "main"
    private static let defaultSecurity: ExecSecurity = .deny
    private static let defaultAsk: ExecAsk = .onMiss
    private static let defaultAskFallback: ExecSecurity = .deny
    private static let defaultAutoAllowSkills = false

    static func fileURL() -> URL {
        OpenClawPaths.stateDirURL.appendingPathComponent("exec-approvals.json")
    }

    static func socketPath() -> String {
        OpenClawPaths.stateDirURL.appendingPathComponent("exec-approvals.sock").path
    }

    static func normalizeIncoming(_ file: ExecApprovalsFile) -> ExecApprovalsFile {
        let socketPath = file.socket?.path?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let token = file.socket?.token?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        var agents = file.agents ?? [:]
        if let legacyDefault = agents["default"] {
            if let main = agents[self.defaultAgentId] {
                agents[self.defaultAgentId] = self.mergeAgents(current: main, legacy: legacyDefault)
            } else {
                agents[self.defaultAgentId] = legacyDefault
            }
            agents.removeValue(forKey: "default")
        }
        return ExecApprovalsFile(
            version: 1,
            socket: ExecApprovalsSocketConfig(
                path: socketPath.isEmpty ? nil : socketPath,
                token: token.isEmpty ? nil : token),
            defaults: file.defaults,
            agents: agents)
    }

    static func readSnapshot() -> ExecApprovalsSnapshot {
        let url = self.fileURL()
        guard FileManager().fileExists(atPath: url.path) else {
            return ExecApprovalsSnapshot(
                path: url.path,
                exists: false,
                hash: self.hashRaw(nil),
                file: ExecApprovalsFile(version: 1, socket: nil, defaults: nil, agents: [:]))
        }
        let raw = try? String(contentsOf: url, encoding: .utf8)
        let data = raw.flatMap { $0.data(using: .utf8) }
        let decoded: ExecApprovalsFile = {
            if let data, let file = try? JSONDecoder().decode(ExecApprovalsFile.self, from: data), file.version == 1 {
                return file
            }
            return ExecApprovalsFile(version: 1, socket: nil, defaults: nil, agents: [:])
        }()
        return ExecApprovalsSnapshot(
            path: url.path,
            exists: true,
            hash: self.hashRaw(raw),
            file: decoded)
    }

    static func redactForSnapshot(_ file: ExecApprovalsFile) -> ExecApprovalsFile {
        let socketPath = file.socket?.path?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if socketPath.isEmpty {
            return ExecApprovalsFile(
                version: file.version,
                socket: nil,
                defaults: file.defaults,
                agents: file.agents)
        }
        return ExecApprovalsFile(
            version: file.version,
            socket: ExecApprovalsSocketConfig(path: socketPath, token: nil),
            defaults: file.defaults,
            agents: file.agents)
    }

    static func loadFile() -> ExecApprovalsFile {
        let url = self.fileURL()
        guard FileManager().fileExists(atPath: url.path) else {
            return ExecApprovalsFile(version: 1, socket: nil, defaults: nil, agents: [:])
        }
        do {
            let data = try Data(contentsOf: url)
            let decoded = try JSONDecoder().decode(ExecApprovalsFile.self, from: data)
            if decoded.version != 1 {
                return ExecApprovalsFile(version: 1, socket: nil, defaults: nil, agents: [:])
            }
            return decoded
        } catch {
            self.logger.warning("exec approvals load failed: \(error.localizedDescription, privacy: .public)")
            return ExecApprovalsFile(version: 1, socket: nil, defaults: nil, agents: [:])
        }
    }

    static func saveFile(_ file: ExecApprovalsFile) {
        do {
            let encoder = JSONEncoder()
            encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
            let data = try encoder.encode(file)
            let url = self.fileURL()
            try FileManager().createDirectory(
                at: url.deletingLastPathComponent(),
                withIntermediateDirectories: true)
            try data.write(to: url, options: [.atomic])
            try? FileManager().setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
        } catch {
            self.logger.error("exec approvals save failed: \(error.localizedDescription, privacy: .public)")
        }
    }

    static func ensureFile() -> ExecApprovalsFile {
        var file = self.loadFile()
        if file.socket == nil { file.socket = ExecApprovalsSocketConfig(path: nil, token: nil) }
        let path = file.socket?.path?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if path.isEmpty {
            file.socket?.path = self.socketPath()
        }
        let token = file.socket?.token?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if token.isEmpty {
            file.socket?.token = self.generateToken()
        }
        if file.agents == nil { file.agents = [:] }
        self.saveFile(file)
        return file
    }

    static func resolve(agentId: String?) -> ExecApprovalsResolved {
        let file = self.ensureFile()
        let defaults = file.defaults ?? ExecApprovalsDefaults()
        let resolvedDefaults = ExecApprovalsResolvedDefaults(
            security: defaults.security ?? self.defaultSecurity,
            ask: defaults.ask ?? self.defaultAsk,
            askFallback: defaults.askFallback ?? self.defaultAskFallback,
            autoAllowSkills: defaults.autoAllowSkills ?? self.defaultAutoAllowSkills)
        let key = self.agentKey(agentId)
        let agentEntry = file.agents?[key] ?? ExecApprovalsAgent()
        let wildcardEntry = file.agents?["*"] ?? ExecApprovalsAgent()
        let resolvedAgent = ExecApprovalsResolvedDefaults(
            security: agentEntry.security ?? wildcardEntry.security ?? resolvedDefaults.security,
            ask: agentEntry.ask ?? wildcardEntry.ask ?? resolvedDefaults.ask,
            askFallback: agentEntry.askFallback ?? wildcardEntry.askFallback
                ?? resolvedDefaults.askFallback,
            autoAllowSkills: agentEntry.autoAllowSkills ?? wildcardEntry.autoAllowSkills
                ?? resolvedDefaults.autoAllowSkills)
        let allowlist = ((wildcardEntry.allowlist ?? []) + (agentEntry.allowlist ?? []))
            .map { entry in
                ExecAllowlistEntry(
                    id: entry.id,
                    pattern: entry.pattern.trimmingCharacters(in: .whitespacesAndNewlines),
                    lastUsedAt: entry.lastUsedAt,
                    lastUsedCommand: entry.lastUsedCommand,
                    lastResolvedPath: entry.lastResolvedPath)
            }
            .filter { !$0.pattern.isEmpty }
        let socketPath = self.expandPath(file.socket?.path ?? self.socketPath())
        let token = file.socket?.token ?? ""
        return ExecApprovalsResolved(
            url: self.fileURL(),
            socketPath: socketPath,
            token: token,
            defaults: resolvedDefaults,
            agent: resolvedAgent,
            allowlist: allowlist,
            file: file)
    }

    static func resolveDefaults() -> ExecApprovalsResolvedDefaults {
        let file = self.ensureFile()
        let defaults = file.defaults ?? ExecApprovalsDefaults()
        return ExecApprovalsResolvedDefaults(
            security: defaults.security ?? self.defaultSecurity,
            ask: defaults.ask ?? self.defaultAsk,
            askFallback: defaults.askFallback ?? self.defaultAskFallback,
            autoAllowSkills: defaults.autoAllowSkills ?? self.defaultAutoAllowSkills)
    }

    static func saveDefaults(_ defaults: ExecApprovalsDefaults) {
        self.updateFile { file in
            file.defaults = defaults
        }
    }

    static func updateDefaults(_ mutate: (inout ExecApprovalsDefaults) -> Void) {
        self.updateFile { file in
            var defaults = file.defaults ?? ExecApprovalsDefaults()
            mutate(&defaults)
            file.defaults = defaults
        }
    }

    static func saveAgent(_ agent: ExecApprovalsAgent, agentId: String?) {
        self.updateFile { file in
            var agents = file.agents ?? [:]
            let key = self.agentKey(agentId)
            if agent.isEmpty {
                agents.removeValue(forKey: key)
            } else {
                agents[key] = agent
            }
            file.agents = agents.isEmpty ? nil : agents
        }
    }

    static func addAllowlistEntry(agentId: String?, pattern: String) {
        let trimmed = pattern.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        self.updateFile { file in
            let key = self.agentKey(agentId)
            var agents = file.agents ?? [:]
            var entry = agents[key] ?? ExecApprovalsAgent()
            var allowlist = entry.allowlist ?? []
            if allowlist.contains(where: { $0.pattern == trimmed }) { return }
            allowlist.append(ExecAllowlistEntry(pattern: trimmed, lastUsedAt: Date().timeIntervalSince1970 * 1000))
            entry.allowlist = allowlist
            agents[key] = entry
            file.agents = agents
        }
    }

    static func recordAllowlistUse(
        agentId: String?,
        pattern: String,
        command: String,
        resolvedPath: String?)
    {
        self.updateFile { file in
            let key = self.agentKey(agentId)
            var agents = file.agents ?? [:]
            var entry = agents[key] ?? ExecApprovalsAgent()
            let allowlist = (entry.allowlist ?? []).map { item -> ExecAllowlistEntry in
                guard item.pattern == pattern else { return item }
                return ExecAllowlistEntry(
                    id: item.id,
                    pattern: item.pattern,
                    lastUsedAt: Date().timeIntervalSince1970 * 1000,
                    lastUsedCommand: command,
                    lastResolvedPath: resolvedPath)
            }
            entry.allowlist = allowlist
            agents[key] = entry
            file.agents = agents
        }
    }

    static func updateAllowlist(agentId: String?, allowlist: [ExecAllowlistEntry]) {
        self.updateFile { file in
            let key = self.agentKey(agentId)
            var agents = file.agents ?? [:]
            var entry = agents[key] ?? ExecApprovalsAgent()
            let cleaned = allowlist
                .map { item in
                    ExecAllowlistEntry(
                        id: item.id,
                        pattern: item.pattern.trimmingCharacters(in: .whitespacesAndNewlines),
                        lastUsedAt: item.lastUsedAt,
                        lastUsedCommand: item.lastUsedCommand,
                        lastResolvedPath: item.lastResolvedPath)
                }
                .filter { !$0.pattern.isEmpty }
            entry.allowlist = cleaned
            agents[key] = entry
            file.agents = agents
        }
    }

    static func updateAgentSettings(agentId: String?, mutate: (inout ExecApprovalsAgent) -> Void) {
        self.updateFile { file in
            let key = self.agentKey(agentId)
            var agents = file.agents ?? [:]
            var entry = agents[key] ?? ExecApprovalsAgent()
            mutate(&entry)
            if entry.isEmpty {
                agents.removeValue(forKey: key)
            } else {
                agents[key] = entry
            }
            file.agents = agents.isEmpty ? nil : agents
        }
    }

    private static func updateFile(_ mutate: (inout ExecApprovalsFile) -> Void) {
        var file = self.ensureFile()
        mutate(&file)
        self.saveFile(file)
    }

    private static func generateToken() -> String {
        var bytes = [UInt8](repeating: 0, count: 24)
        let status = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
        if status == errSecSuccess {
            return Data(bytes)
                .base64EncodedString()
                .replacingOccurrences(of: "+", with: "-")
                .replacingOccurrences(of: "/", with: "_")
                .replacingOccurrences(of: "=", with: "")
        }
        return UUID().uuidString
    }

    private static func hashRaw(_ raw: String?) -> String {
        let data = Data((raw ?? "").utf8)
        let digest = SHA256.hash(data: data)
        return digest.map { String(format: "%02x", $0) }.joined()
    }

    private static func expandPath(_ raw: String) -> String {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed == "~" {
            return FileManager().homeDirectoryForCurrentUser.path
        }
        if trimmed.hasPrefix("~/") {
            let suffix = trimmed.dropFirst(2)
            return FileManager().homeDirectoryForCurrentUser
                .appendingPathComponent(String(suffix)).path
        }
        return trimmed
    }

    private static func agentKey(_ agentId: String?) -> String {
        let trimmed = agentId?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return trimmed.isEmpty ? self.defaultAgentId : trimmed
    }

    private static func normalizedPattern(_ pattern: String?) -> String? {
        let trimmed = pattern?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return trimmed.isEmpty ? nil : trimmed.lowercased()
    }

    private static func mergeAgents(
        current: ExecApprovalsAgent,
        legacy: ExecApprovalsAgent) -> ExecApprovalsAgent
    {
        var seen = Set<String>()
        var allowlist: [ExecAllowlistEntry] = []
        func append(_ entry: ExecAllowlistEntry) {
            guard let key = self.normalizedPattern(entry.pattern), !seen.contains(key) else {
                return
            }
            seen.insert(key)
            allowlist.append(entry)
        }
        for entry in current.allowlist ?? [] {
            append(entry)
        }
        for entry in legacy.allowlist ?? [] {
            append(entry)
        }

        return ExecApprovalsAgent(
            security: current.security ?? legacy.security,
            ask: current.ask ?? legacy.ask,
            askFallback: current.askFallback ?? legacy.askFallback,
            autoAllowSkills: current.autoAllowSkills ?? legacy.autoAllowSkills,
            allowlist: allowlist.isEmpty ? nil : allowlist)
    }
}

struct ExecCommandResolution: Sendable {
    let rawExecutable: String
    let resolvedPath: String?
    let executableName: String
    let cwd: String?

    static func resolve(
        command: [String],
        rawCommand: String?,
        cwd: String?,
        env: [String: String]?) -> ExecCommandResolution?
    {
        let trimmedRaw = rawCommand?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if !trimmedRaw.isEmpty, let token = self.parseFirstToken(trimmedRaw) {
            return self.resolveExecutable(rawExecutable: token, cwd: cwd, env: env)
        }
        return self.resolve(command: command, cwd: cwd, env: env)
    }

    static func resolveForAllowlist(
        command: [String],
        rawCommand: String?,
        cwd: String?,
        env: [String: String]?) -> [ExecCommandResolution]
    {
        let shell = self.extractShellCommandFromArgv(command: command, rawCommand: rawCommand)
        if shell.isWrapper {
            guard let shellCommand = shell.command,
                  let segments = self.splitShellCommandChain(shellCommand)
            else {
                // Fail closed: if we cannot safely parse a shell wrapper payload,
                // treat this as an allowlist miss and require approval.
                return []
            }
            var resolutions: [ExecCommandResolution] = []
            resolutions.reserveCapacity(segments.count)
            for segment in segments {
                guard let token = self.parseFirstToken(segment),
                      let resolution = self.resolveExecutable(rawExecutable: token, cwd: cwd, env: env)
                else {
                    return []
                }
                resolutions.append(resolution)
            }
            return resolutions
        }

        guard let resolution = self.resolve(command: command, rawCommand: rawCommand, cwd: cwd, env: env) else {
            return []
        }
        return [resolution]
    }

    static func resolve(command: [String], cwd: String?, env: [String: String]?) -> ExecCommandResolution? {
        guard let raw = command.first?.trimmingCharacters(in: .whitespacesAndNewlines), !raw.isEmpty else {
            return nil
        }
        return self.resolveExecutable(rawExecutable: raw, cwd: cwd, env: env)
    }

    private static func resolveExecutable(
        rawExecutable: String,
        cwd: String?,
        env: [String: String]?) -> ExecCommandResolution?
    {
        let expanded = rawExecutable.hasPrefix("~") ? (rawExecutable as NSString).expandingTildeInPath : rawExecutable
        let hasPathSeparator = expanded.contains("/") || expanded.contains("\\")
        let resolvedPath: String? = {
            if hasPathSeparator {
                if expanded.hasPrefix("/") {
                    return expanded
                }
                let base = cwd?.trimmingCharacters(in: .whitespacesAndNewlines)
                let root = (base?.isEmpty == false) ? base! : FileManager().currentDirectoryPath
                return URL(fileURLWithPath: root).appendingPathComponent(expanded).path
            }
            let searchPaths = self.searchPaths(from: env)
            return CommandResolver.findExecutable(named: expanded, searchPaths: searchPaths)
        }()
        let name = resolvedPath.map { URL(fileURLWithPath: $0).lastPathComponent } ?? expanded
        return ExecCommandResolution(
            rawExecutable: expanded,
            resolvedPath: resolvedPath,
            executableName: name,
            cwd: cwd)
    }

    private static func parseFirstToken(_ command: String) -> String? {
        let trimmed = command.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        guard let first = trimmed.first else { return nil }
        if first == "\"" || first == "'" {
            let rest = trimmed.dropFirst()
            if let end = rest.firstIndex(of: first) {
                return String(rest[..<end])
            }
            return String(rest)
        }
        return trimmed.split(whereSeparator: { $0.isWhitespace }).first.map(String.init)
    }

    private static func basenameLower(_ token: String) -> String {
        let trimmed = token.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return "" }
        let normalized = trimmed.replacingOccurrences(of: "\\", with: "/")
        return normalized.split(separator: "/").last.map { String($0).lowercased() } ?? normalized.lowercased()
    }

    private static func extractShellCommandFromArgv(
        command: [String],
        rawCommand: String?) -> (isWrapper: Bool, command: String?)
    {
        guard let token0 = command.first?.trimmingCharacters(in: .whitespacesAndNewlines), !token0.isEmpty else {
            return (false, nil)
        }
        let base0 = self.basenameLower(token0)
        let trimmedRaw = rawCommand?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let preferredRaw = trimmedRaw.isEmpty ? nil : trimmedRaw

        if ["sh", "bash", "zsh", "dash", "ksh"].contains(base0) {
            let flag = command.count > 1 ? command[1].trimmingCharacters(in: .whitespacesAndNewlines) : ""
            guard flag == "-lc" || flag == "-c" else { return (false, nil) }
            let payload = command.count > 2 ? command[2].trimmingCharacters(in: .whitespacesAndNewlines) : ""
            let normalized = preferredRaw ?? (payload.isEmpty ? nil : payload)
            return (true, normalized)
        }

        if base0 == "cmd.exe" || base0 == "cmd" {
            guard let idx = command
                .firstIndex(where: { $0.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() == "/c" })
            else {
                return (false, nil)
            }
            let tail = command.suffix(from: command.index(after: idx)).joined(separator: " ")
            let payload = tail.trimmingCharacters(in: .whitespacesAndNewlines)
            let normalized = preferredRaw ?? (payload.isEmpty ? nil : payload)
            return (true, normalized)
        }

        return (false, nil)
    }

    private static func splitShellCommandChain(_ command: String) -> [String]? {
        let trimmed = command.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }

        var segments: [String] = []
        var current = ""
        var inSingle = false
        var inDouble = false
        var escaped = false
        let chars = Array(trimmed)
        var idx = 0

        func appendCurrent() -> Bool {
            let segment = current.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !segment.isEmpty else { return false }
            segments.append(segment)
            current.removeAll(keepingCapacity: true)
            return true
        }

        while idx < chars.count {
            let ch = chars[idx]
            let next: Character? = idx + 1 < chars.count ? chars[idx + 1] : nil

            if escaped {
                current.append(ch)
                escaped = false
                idx += 1
                continue
            }

            if ch == "\\", !inSingle {
                current.append(ch)
                escaped = true
                idx += 1
                continue
            }

            if ch == "'", !inDouble {
                inSingle.toggle()
                current.append(ch)
                idx += 1
                continue
            }

            if ch == "\"", !inSingle {
                inDouble.toggle()
                current.append(ch)
                idx += 1
                continue
            }

            if !inSingle, !inDouble {
                if self.shouldFailClosedForUnquotedShell(ch: ch, next: next) {
                    // Fail closed on command/process substitution in allowlist mode.
                    return nil
                }
                let prev: Character? = idx > 0 ? chars[idx - 1] : nil
                if let delimiterStep = self.chainDelimiterStep(ch: ch, prev: prev, next: next) {
                    guard appendCurrent() else { return nil }
                    idx += delimiterStep
                    continue
                }
            }

            current.append(ch)
            idx += 1
        }

        if escaped || inSingle || inDouble { return nil }
        guard appendCurrent() else { return nil }
        return segments
    }

    private static func shouldFailClosedForUnquotedShell(ch: Character, next: Character?) -> Bool {
        if ch == "`" {
            return true
        }
        if ch == "$", next == "(" {
            return true
        }
        if ch == "<" || ch == ">", next == "(" {
            return true
        }
        return false
    }

    private static func chainDelimiterStep(ch: Character, prev: Character?, next: Character?) -> Int? {
        if ch == ";" || ch == "\n" {
            return 1
        }
        if ch == "&" {
            if next == "&" {
                return 2
            }
            // Keep fd redirections like 2>&1 or &>file intact.
            let prevIsRedirect = prev == ">"
            let nextIsRedirect = next == ">"
            return (!prevIsRedirect && !nextIsRedirect) ? 1 : nil
        }
        if ch == "|" {
            if next == "|" || next == "&" {
                return 2
            }
            return 1
        }
        return nil
    }

    private static func searchPaths(from env: [String: String]?) -> [String] {
        let raw = env?["PATH"]
        if let raw, !raw.isEmpty {
            return raw.split(separator: ":").map(String.init)
        }
        return CommandResolver.preferredPaths()
    }
}

enum ExecCommandFormatter {
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

    static func displayString(for argv: [String], rawCommand: String?) -> String {
        let trimmed = rawCommand?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if !trimmed.isEmpty { return trimmed }
        return self.displayString(for: argv)
    }
}

enum ExecApprovalHelpers {
    static func parseDecision(_ raw: String?) -> ExecApprovalDecision? {
        let trimmed = raw?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard !trimmed.isEmpty else { return nil }
        return ExecApprovalDecision(rawValue: trimmed)
    }

    static func requiresAsk(
        ask: ExecAsk,
        security: ExecSecurity,
        allowlistMatch: ExecAllowlistEntry?,
        skillAllow: Bool) -> Bool
    {
        if ask == .always { return true }
        if ask == .onMiss, security == .allowlist, allowlistMatch == nil, !skillAllow { return true }
        return false
    }

    static func allowlistPattern(command: [String], resolution: ExecCommandResolution?) -> String? {
        let pattern = resolution?.resolvedPath ?? resolution?.rawExecutable ?? command.first ?? ""
        return pattern.isEmpty ? nil : pattern
    }
}

enum ExecAllowlistMatcher {
    static func match(entries: [ExecAllowlistEntry], resolution: ExecCommandResolution?) -> ExecAllowlistEntry? {
        guard let resolution, !entries.isEmpty else { return nil }
        let rawExecutable = resolution.rawExecutable
        let resolvedPath = resolution.resolvedPath
        let executableName = resolution.executableName

        for entry in entries {
            let pattern = entry.pattern.trimmingCharacters(in: .whitespacesAndNewlines)
            if pattern.isEmpty { continue }
            let hasPath = pattern.contains("/") || pattern.contains("~") || pattern.contains("\\")
            if hasPath {
                let target = resolvedPath ?? rawExecutable
                if self.matches(pattern: pattern, target: target) { return entry }
            } else if self.matches(pattern: pattern, target: executableName) {
                return entry
            }
        }
        return nil
    }

    static func matchAll(
        entries: [ExecAllowlistEntry],
        resolutions: [ExecCommandResolution]) -> [ExecAllowlistEntry]
    {
        guard !entries.isEmpty, !resolutions.isEmpty else { return [] }
        var matches: [ExecAllowlistEntry] = []
        matches.reserveCapacity(resolutions.count)
        for resolution in resolutions {
            guard let match = self.match(entries: entries, resolution: resolution) else {
                return []
            }
            matches.append(match)
        }
        return matches
    }

    private static func matches(pattern: String, target: String) -> Bool {
        let trimmed = pattern.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return false }
        let expanded = trimmed.hasPrefix("~") ? (trimmed as NSString).expandingTildeInPath : trimmed
        let normalizedPattern = self.normalizeMatchTarget(expanded)
        let normalizedTarget = self.normalizeMatchTarget(target)
        guard let regex = self.regex(for: normalizedPattern) else { return false }
        let range = NSRange(location: 0, length: normalizedTarget.utf16.count)
        return regex.firstMatch(in: normalizedTarget, options: [], range: range) != nil
    }

    private static func normalizeMatchTarget(_ value: String) -> String {
        value.replacingOccurrences(of: "\\\\", with: "/").lowercased()
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
        return try? NSRegularExpression(pattern: regex, options: [.caseInsensitive])
    }
}

struct ExecEventPayload: Codable, Sendable {
    var sessionKey: String
    var runId: String
    var host: String
    var command: String?
    var exitCode: Int?
    var timedOut: Bool?
    var success: Bool?
    var output: String?
    var reason: String?

    static func truncateOutput(_ raw: String, maxChars: Int = 20000) -> String? {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        if trimmed.count <= maxChars { return trimmed }
        let suffix = trimmed.suffix(maxChars)
        return "... (truncated) \(suffix)"
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
