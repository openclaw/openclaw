import Foundation
import OpenClawKit

extension AppState {
    /// Keeps a non-empty identifier only if it's installed and still matches `languageID`,
    /// otherwise System Default — the picker's own option list is locale-filtered too.
    static func resolvedSystemVoiceID(_ voiceID: String, matchingLanguageID languageID: String) -> String {
        guard !voiceID.isEmpty else { return voiceID }
        let candidates = TalkSystemVoiceCatalog.voices(
            matchingLanguageID: languageID,
            in: TalkSystemVoiceCatalog.availableVoices())
        return TalkSystemVoiceCatalog.voice(identifier: voiceID, in: candidates) != nil ? voiceID : ""
    }
}
