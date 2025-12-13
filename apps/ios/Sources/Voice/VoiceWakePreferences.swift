import Foundation

enum VoiceWakePreferences {
    static let enabledKey = "voiceWake.enabled"
    static let triggerWordsKey = "voiceWake.triggerWords"

    // Keep defaults aligned with the mac app.
    static let defaultTriggerWords: [String] = ["clawd", "claude"]

    static func loadTriggerWords(defaults: UserDefaults = .standard) -> [String] {
        defaults.stringArray(forKey: self.triggerWordsKey) ?? self.defaultTriggerWords
    }

    static func saveTriggerWords(_ words: [String], defaults: UserDefaults = .standard) {
        defaults.set(words, forKey: self.triggerWordsKey)
    }

    static func sanitizeTriggerWords(_ words: [String]) -> [String] {
        let cleaned = words
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
        return cleaned.isEmpty ? Self.defaultTriggerWords : cleaned
    }

    static func displayString(for words: [String]) -> String {
        let sanitized = self.sanitizeTriggerWords(words)
        return sanitized.joined(separator: ", ")
    }
}
