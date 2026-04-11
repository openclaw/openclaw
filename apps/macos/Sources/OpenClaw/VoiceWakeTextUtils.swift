import Foundation
import SwabbleKit

enum VoiceWakeTextUtils {
    private static let whitespaceAndPunctuation = CharacterSet.whitespacesAndNewlines
        .union(.punctuationCharacters)
    typealias TrimWake = (String, [String]) -> String

    static func normalizeToken(_ token: String) -> String {
        token
            .trimmingCharacters(in: self.whitespaceAndPunctuation)
            .lowercased()
    }

    static func startsWithTrigger(transcript: String, triggers: [String]) -> Bool {
        let tokens = transcript
            .split(whereSeparator: { $0.isWhitespace })
            .map { self.normalizeToken(String($0)) }
            .filter { !$0.isEmpty }
        guard !tokens.isEmpty else { return false }
        for trigger in triggers {
            let triggerTokens = trigger
                .split(whereSeparator: { $0.isWhitespace })
                .map { self.normalizeToken(String($0)) }
                .filter { !$0.isEmpty }
            guard !triggerTokens.isEmpty, tokens.count >= triggerTokens.count else { continue }
            if zip(triggerTokens, tokens.prefix(triggerTokens.count)).allSatisfy({ $0 == $1 }) {
                return true
            }
            // Prefix match for CJK: "莱财在不在" starts with trigger "莱财".
            if triggerTokens.count == 1,
               triggerTokens[0].unicodeScalars.contains(where: { Self.isCJKScalar($0) }),
               tokens[0].hasPrefix(triggerTokens[0]) {
                return true
            }
        }
        return false
    }

    private static func isCJKScalar(_ scalar: Unicode.Scalar) -> Bool {
        (scalar.value >= 0x4E00 && scalar.value <= 0x9FFF)   // CJK Unified
        || (scalar.value >= 0x3040 && scalar.value <= 0x30FF) // Hiragana/Katakana
        || (scalar.value >= 0xAC00 && scalar.value <= 0xD7AF) // Hangul
    }

    static func textOnlyCommand(
        transcript: String,
        triggers: [String],
        minCommandLength: Int,
        trimWake: TrimWake) -> String?
    {
        guard !transcript.isEmpty else { return nil }
        guard !self.normalizeToken(transcript).isEmpty else { return nil }
        guard WakeWordGate.matchesTextOnly(text: transcript, triggers: triggers) else { return nil }
        guard self.startsWithTrigger(transcript: transcript, triggers: triggers) else { return nil }
        let trimmed = trimWake(transcript, triggers)
        guard trimmed.count >= minCommandLength else { return nil }
        return trimmed
    }
}
