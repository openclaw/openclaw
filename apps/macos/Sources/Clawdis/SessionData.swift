import Foundation
import SwiftUI

struct SessionEntryRecord: Decodable {
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
        try await Task.detached(priority: .utility) {
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

            return decoded.map { key, entry in
                let updated = entry.updatedAt.map { Date(timeIntervalSince1970: $0 / 1000) }
                let input = entry.inputTokens ?? 0
                let output = entry.outputTokens ?? 0
                let total = entry.totalTokens ?? input + output
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
