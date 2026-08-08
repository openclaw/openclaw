import AVFoundation
import Foundation
import OpenClawKit

enum TalkSystemVoiceSelection {
    static let storageKey = "talk.systemVoiceSelection"
    static let automaticID = ""

    struct Option: Identifiable {
        let id: String
        let label: String
    }

    static func options(
        languageID: String?,
        allVoices: [TalkSystemVoiceCatalog.Voice] = TalkSystemVoiceCatalog.availableVoices()) -> [Option]
    {
        let filtered = TalkSystemVoiceCatalog.voices(matchingLanguageID: languageID, in: allVoices)
        let dynamic = filtered.map { Option(id: $0.id, label: TalkSystemVoiceCatalog.label(for: $0)) }
        return [Option(id: Self.automaticID, label: String(localized: "System Default"))] + dynamic
    }

    /// A previously-picked voice the user later deletes must gracefully fall back to System
    /// Default rather than silently failing, since speechVoices() changes over time.
    static func resolvedOverride(
        _ raw: String?,
        isVoiceInstalled: (String) -> Bool = TalkSystemVoiceSelection.isInstalled) -> String?
    {
        let trimmed = (raw ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        return isVoiceInstalled(trimmed) ? trimmed : nil
    }

    static func isInstalled(_ identifier: String) -> Bool {
        AVSpeechSynthesisVoice(identifier: identifier) != nil
    }

    static func label(
        for identifier: String,
        allVoices: [TalkSystemVoiceCatalog.Voice] = TalkSystemVoiceCatalog.availableVoices()) -> String?
    {
        TalkSystemVoiceCatalog.voice(identifier: identifier, in: allVoices).map(TalkSystemVoiceCatalog.label(for:))
    }
}
