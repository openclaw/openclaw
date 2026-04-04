import Foundation

public enum ShareToAgentSettings {
    private static let suiteName = "group.ai.vericlaw.shared"
    private static let legacySuiteName = "group.ai.openclaw.shared"
    private static let defaultInstructionKey = "share.defaultInstruction"
    private static let fallbackInstruction = "Please verify this, summarize the risk, and suggest the next action."

    private static var defaults: UserDefaults {
        UserDefaults(suiteName: suiteName) ?? .standard
    }

    private static var legacyDefaults: UserDefaults? {
        UserDefaults(suiteName: self.legacySuiteName)
    }

    public static func loadDefaultInstruction() -> String {
        let raw = self.defaults.string(forKey: self.defaultInstructionKey)?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        if let raw, !raw.isEmpty {
            return raw
        }
        let legacy = self.legacyDefaults?.string(forKey: self.defaultInstructionKey)?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        if let legacy, !legacy.isEmpty {
            self.saveDefaultInstruction(legacy)
            self.legacyDefaults?.removeObject(forKey: self.defaultInstructionKey)
            return legacy
        }
        return self.fallbackInstruction
    }

    public static func saveDefaultInstruction(_ value: String?) {
        let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if trimmed.isEmpty {
            self.defaults.removeObject(forKey: self.defaultInstructionKey)
            self.legacyDefaults?.removeObject(forKey: self.defaultInstructionKey)
            return
        }
        self.defaults.set(trimmed, forKey: self.defaultInstructionKey)
        self.legacyDefaults?.removeObject(forKey: self.defaultInstructionKey)
    }
}
