import Foundation
import SwiftUI

struct SessionEntryRecord: Codable {
    let sessionId: String?
    let updatedAt: Double?
    let systemSent: Bool?
    let abortedLastRun: Bool?
    let thinkingLevel: String?
    let verboseLevel: String?
    let inputTokens: Int?
    let outputTokens: Int?
    let totalTokens: Int?
    let model: String?
    let contextTokens: Int?
}

struct SessionTokenStats {
    let input: Int
    let output: Int
    let total: Int
    let contextTokens: Int

    var contextSummaryShort: String {
        "\(Self.formatKTokens(self.total))/\(Self.formatKTokens(self.contextTokens))"
    }

    var percentUsed: Int? {
        guard self.contextTokens > 0, self.total > 0 else { return nil }
        return min(100, Int(round((Double(self.total) / Double(self.contextTokens)) * 100)))
    }

    var summary: String {
        let parts = ["in \(input)", "out \(output)", "total \(total)"]
        var text = parts.joined(separator: " | ")
        if let percentUsed {
            text += " (\(percentUsed)% of \(self.contextTokens))"
        }
        return text
    }

    static func formatKTokens(_ value: Int) -> String {
        if value < 1000 { return "\(value)" }
        let thousands = Double(value) / 1000
        let decimals = value >= 10000 ? 0 : 1
        return String(format: "%.\(decimals)fk", thousands)
    }
}

struct SessionRow: Identifiable {
    let id: String
    let key: String
    let kind: SessionKind
    let updatedAt: Date?
    let sessionId: String?
    let thinkingLevel: String?
    let verboseLevel: String?
    let systemSent: Bool
    let abortedLastRun: Bool
    let tokens: SessionTokenStats
    let model: String?

    var ageText: String { relativeAge(from: self.updatedAt) }

    var flagLabels: [String] {
        var flags: [String] = []
        if let thinkingLevel { flags.append("think \(thinkingLevel)") }
        if let verboseLevel { flags.append("verbose \(verboseLevel)") }
        if self.systemSent { flags.append("system sent") }
        if self.abortedLastRun { flags.append("aborted") }
        return flags
    }
}

enum SessionKind {
    case direct, group, global, unknown

    static func from(key: String) -> SessionKind {
        if key == "global" { return .global }
        if key.hasPrefix("group:") { return .group }
        if key == "unknown" { return .unknown }
        return .direct
    }

    var label: String {
        switch self {
        case .direct: "Direct"
        case .group: "Group"
        case .global: "Global"
        case .unknown: "Unknown"
        }
    }

    var tint: Color {
        switch self {
        case .direct: .accentColor
        case .group: .orange
        case .global: .purple
        case .unknown: .gray
        }
    }
}

struct SessionDefaults {
    let model: String
    let contextTokens: Int
}

extension SessionRow {
    static var previewRows: [SessionRow] {
        [
            SessionRow(
                id: "direct-1",
                key: "user@example.com",
                kind: .direct,
                updatedAt: Date().addingTimeInterval(-90),
                sessionId: "sess-direct-1234",
                thinkingLevel: "low",
                verboseLevel: "info",
                systemSent: false,
                abortedLastRun: false,
                tokens: SessionTokenStats(input: 320, output: 680, total: 1000, contextTokens: 200_000),
                model: "claude-3.5-sonnet"),
            SessionRow(
                id: "group-1",
                key: "group:engineering",
                kind: .group,
                updatedAt: Date().addingTimeInterval(-3600),
                sessionId: "sess-group-4321",
                thinkingLevel: "medium",
                verboseLevel: nil,
                systemSent: true,
                abortedLastRun: true,
                tokens: SessionTokenStats(input: 5000, output: 1200, total: 6200, contextTokens: 200_000),
                model: "claude-opus-4-5"),
            SessionRow(
                id: "global",
                key: "global",
                kind: .global,
                updatedAt: Date().addingTimeInterval(-86400),
                sessionId: nil,
                thinkingLevel: nil,
                verboseLevel: nil,
                systemSent: false,
                abortedLastRun: false,
                tokens: SessionTokenStats(input: 150, output: 220, total: 370, contextTokens: 200_000),
                model: "gpt-4.1-mini"),
        ]
    }
}

struct ModelChoice: Identifiable, Hashable {
    let id: String
    let name: String
    let provider: String
    let contextWindow: Int?
}

extension String? {
    var isNilOrEmpty: Bool {
        switch self {
        case .none: true
        case let .some(value): value.isEmpty
        }
    }
}

extension [String] {
    fileprivate func dedupedPreserveOrder() -> [String] {
        var seen = Set<String>()
        var result: [String] = []
        for item in self where !seen.contains(item) {
            seen.insert(item)
            result.append(item)
        }
        return result
    }
}

struct SessionConfigHints {
    let storePath: String?
    let model: String?
    let contextTokens: Int?
}

enum SessionLoadError: LocalizedError {
    case missingStore(String)
    case decodeFailed(String)

    var errorDescription: String? {
        switch self {
        case let .missingStore(path):
            "No session store found at \(path) yet. Send or receive a message to create it."

        case let .decodeFailed(reason):
            "Could not read the session store: \(reason)"
        }
    }
}

enum SessionLoader {
    static let fallbackModel = "claude-opus-4-5"
    static let fallbackContextTokens = 200_000

    static let defaultStorePath = standardize(
        FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".clawdis/sessions/sessions.json").path)

    private static let legacyStorePaths: [String] = [
        standardize(FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".clawdis/sessions.json")
            .path),
    ]

    static func configHints() -> SessionConfigHints {
        let configURL = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".clawdis/clawdis.json")
        guard let data = try? Data(contentsOf: configURL) else {
            return SessionConfigHints(storePath: nil, model: nil, contextTokens: nil)
        }
        guard let parsed = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return SessionConfigHints(storePath: nil, model: nil, contextTokens: nil)
        }

        let inbound = parsed["inbound"] as? [String: Any]
        let reply = inbound?["reply"] as? [String: Any]
        let session = reply?["session"] as? [String: Any]
        let agent = reply?["agent"] as? [String: Any]

        let store = session?["store"] as? String
        let model = agent?["model"] as? String
        let contextTokens = (agent?["contextTokens"] as? NSNumber)?.intValue

        return SessionConfigHints(
            storePath: store.map { self.standardize($0) },
            model: model,
            contextTokens: contextTokens)
    }

    static func resolveStorePath(override: String?) -> String {
        let preferred = self.standardize(override ?? self.defaultStorePath)
        let candidates = [preferred] + self.legacyStorePaths
        if let existing = candidates.first(where: { FileManager.default.fileExists(atPath: $0) }) {
            return existing
        }
        return preferred
    }

    static func availableModels(storeOverride: String?) -> [String] {
        let path = self.resolveStorePath(override: storeOverride)
        guard let data = try? Data(contentsOf: URL(fileURLWithPath: path)),
              let decoded = try? JSONDecoder().decode([String: SessionEntryRecord].self, from: data)
        else {
            return [self.fallbackModel]
        }
        let models = decoded.values.compactMap(\.model)
        return ([self.fallbackModel] + models).dedupedPreserveOrder()
    }

    static func loadRows(at path: String, defaults: SessionDefaults) async throws -> [SessionRow] {
        try await Task.detached(priority: .userInitiated) {
            guard FileManager.default.fileExists(atPath: path) else {
                throw SessionLoadError.missingStore(path)
            }

            let data = try Data(contentsOf: URL(fileURLWithPath: path))
            let decoded: [String: SessionEntryRecord]
            do {
                decoded = try JSONDecoder().decode([String: SessionEntryRecord].self, from: data)
            } catch {
                throw SessionLoadError.decodeFailed(error.localizedDescription)
            }

            let storeDir = URL(fileURLWithPath: path).deletingLastPathComponent()

            return decoded.map { key, entry in
                let updated = entry.updatedAt.map { Date(timeIntervalSince1970: $0 / 1000) }
                let input = entry.inputTokens ?? 0
                let output = entry.outputTokens ?? 0
                let fallbackTotal = entry.totalTokens ?? input + output
                let promptTokens = entry.sessionId.flatMap { self.promptTokensFromSessionLog(
                    sessionId: $0,
                    storeDir: storeDir) }
                let total = max(fallbackTotal, promptTokens ?? 0)
                let context = entry.contextTokens ?? defaults.contextTokens
                let model = entry.model ?? defaults.model

                return SessionRow(
                    id: key,
                    key: key,
                    kind: SessionKind.from(key: key),
                    updatedAt: updated,
                    sessionId: entry.sessionId,
                    thinkingLevel: entry.thinkingLevel,
                    verboseLevel: entry.verboseLevel,
                    systemSent: entry.systemSent ?? false,
                    abortedLastRun: entry.abortedLastRun ?? false,
                    tokens: SessionTokenStats(
                        input: input,
                        output: output,
                        total: total,
                        contextTokens: context),
                    model: model)
            }
            .sorted { ($0.updatedAt ?? .distantPast) > ($1.updatedAt ?? .distantPast) }
        }.value
    }

    private static func promptTokensFromSessionLog(sessionId: String, storeDir: URL) -> Int? {
        let trimmed = sessionId.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }

        let candidates: [URL] = [
            storeDir.appendingPathComponent("\(trimmed).jsonl"),
            FileManager.default.homeDirectoryForCurrentUser
                .appendingPathComponent(".pi/agent/sessions")
                .appendingPathComponent("\(trimmed).jsonl"),
            FileManager.default.homeDirectoryForCurrentUser
                .appendingPathComponent(".tau/agent/sessions/clawdis")
                .appendingPathComponent("\(trimmed).jsonl"),
        ]

        guard let logURL = candidates.first(where: { FileManager.default.fileExists(atPath: $0.path) }) else {
            return nil
        }

        guard let lastUsage = self.readLastUsageFromJsonl(logURL) else { return nil }

        let input = self.number(from: lastUsage["input"]) ?? 0
        let output = self.number(from: lastUsage["output"]) ?? 0
        let cacheRead = self.number(from: lastUsage["cacheRead"] ?? lastUsage["cache_read"]) ?? 0
        let cacheWrite = self.number(from: lastUsage["cacheWrite"] ?? lastUsage["cache_write"]) ?? 0
        let totalTokens = self.number(from: lastUsage["totalTokens"] ?? lastUsage["total_tokens"] ?? lastUsage["total"])

        let prompt = input + cacheRead + cacheWrite
        if prompt > 0 { return prompt }
        if let totalTokens, totalTokens > output { return totalTokens - output }
        return nil
    }

    private static func readLastUsageFromJsonl(_ url: URL) -> [String: Any]? {
        // Logs can contain huge toolResult payloads (base64 images). Avoid parsing the whole file:
        // read a tail window and scan backwards for the last JSON line that contains a usage blob.
        let handle: FileHandle
        do {
            handle = try FileHandle(forReadingFrom: url)
        } catch {
            return nil
        }
        defer { try? handle.close() }

        let fileSize: UInt64
        do {
            fileSize = try handle.seekToEnd()
        } catch {
            return nil
        }

        let window: UInt64 = 512 * 1024
        let start = fileSize > window ? fileSize - window : 0
        do {
            try handle.seek(toOffset: start)
        } catch {
            return nil
        }

        let data = (try? handle.readToEnd()) ?? Data()
        guard let text = String(data: data, encoding: .utf8) else { return nil }

        let lines = text.split(whereSeparator: \.isNewline)
        for line in lines.reversed() {
            let trimmedLine = line.trimmingCharacters(in: .whitespacesAndNewlines)
            if trimmedLine.isEmpty { continue }
            // Cheap prefilter before JSON parsing.
            if !trimmedLine.contains("\"usage\"") { continue }
            guard let lineData = trimmedLine.data(using: .utf8) else { continue }
            guard let obj = try? JSONSerialization.jsonObject(with: lineData) as? [String: Any] else { continue }

            if let message = obj["message"] as? [String: Any], let usage = message["usage"] as? [String: Any] {
                return usage
            }
            if let usage = obj["usage"] as? [String: Any] {
                return usage
            }
        }

        return nil
    }

    private static func number(from raw: Any?) -> Int? {
        switch raw {
        case let v as Int: v
        case let v as Double: Int(v)
        case let v as NSNumber: v.intValue
        case let v as String: Int(v)
        default: nil
        }
    }

    private static func standardize(_ path: String) -> String {
        (path as NSString).expandingTildeInPath.replacingOccurrences(of: "//", with: "/")
    }
}

func relativeAge(from date: Date?) -> String {
    guard let date else { return "unknown" }
    let delta = Date().timeIntervalSince(date)
    if delta < 60 { return "just now" }
    let minutes = Int(round(delta / 60))
    if minutes < 60 { return "\(minutes)m ago" }
    let hours = Int(round(Double(minutes) / 60))
    if hours < 48 { return "\(hours)h ago" }
    let days = Int(round(Double(hours) / 24))
    return "\(days)d ago"
}
