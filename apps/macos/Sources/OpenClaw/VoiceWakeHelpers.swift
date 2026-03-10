import Foundation

/// A trigger word with an optional agent routing target.
/// When `agentId` is nil the default agent (typically "main") is used.
struct TriggerWordEntry: Codable, Equatable, Hashable, Sendable {
    var word: String
    var agentId: String?

    /// Convenience initializer for plain word (no agent routing).
    init(word: String, agentId: String? = nil) {
        self.word = word
        self.agentId = agentId
    }
}

func sanitizeVoiceWakeTriggers(_ words: [String]) -> [String] {
    let cleaned = words
        .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
        .filter { !$0.isEmpty }
        .prefix(voiceWakeMaxWords)
        .map { String($0.prefix(voiceWakeMaxWordLength)) }
    return cleaned.isEmpty ? defaultVoiceWakeTriggers : cleaned
}

func sanitizeVoiceWakeTriggerEntries(_ entries: [TriggerWordEntry]) -> [TriggerWordEntry] {
    let cleaned = entries
        .map { entry in
            TriggerWordEntry(
                word: String(entry.word.trimmingCharacters(in: .whitespacesAndNewlines)
                    .prefix(voiceWakeMaxWordLength)),
                agentId: entry.agentId?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false
                    ? entry.agentId?.trimmingCharacters(in: .whitespacesAndNewlines) : nil)
        }
        .filter { !$0.word.isEmpty }
        .prefix(voiceWakeMaxWords)
    if cleaned.isEmpty {
        return defaultVoiceWakeTriggers.map { TriggerWordEntry(word: $0) }
    }
    return Array(cleaned)
}

/// Find the agentId for a matched trigger word from a list of entries.
func agentIdForTrigger(_ matchedTrigger: String, in entries: [TriggerWordEntry]) -> String? {
    let normalized = matchedTrigger.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    return entries.first { $0.word.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() == normalized }?.agentId
}

/// Find the matching trigger word and its agentId from a transcript.
func matchTriggerEntry(transcript: String, entries: [TriggerWordEntry]) -> TriggerWordEntry? {
    let lower = transcript.lowercased()
    let sorted = entries.sorted { $0.word.count > $1.word.count }
    for entry in sorted {
        let trigger = entry.word.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trigger.isEmpty else { continue }
        if lower.range(of: trigger.lowercased(), options: [.diacriticInsensitive, .widthInsensitive]) != nil {
            return entry
        }
    }
    return nil
}

func normalizeLocaleIdentifier(_ raw: String) -> String {
    var trimmed = raw
    if let at = trimmed.firstIndex(of: "@") {
        trimmed = String(trimmed[..<at])
    }
    if let u = trimmed.range(of: "-u-") {
        trimmed = String(trimmed[..<u.lowerBound])
    }
    if let t = trimmed.range(of: "-t-") {
        trimmed = String(trimmed[..<t.lowerBound])
    }
    return trimmed
}
