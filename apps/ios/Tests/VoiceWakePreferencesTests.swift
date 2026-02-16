import Foundation
import Testing
@testable import SmartAgentNeo

@Suite struct VoiceWakePreferencesTests {
    @Test func sanitizeTriggerWordsTrimsAndDropsEmpty() {
        #expect(VoiceWakePreferences.sanitizeTriggerWords([" smart-agent-neo ", "", " \nclaude\t"]) == ["smart-agent-neo", "claude"])
    }

    @Test func sanitizeTriggerWordsFallsBackToDefaultsWhenEmpty() {
        #expect(VoiceWakePreferences.sanitizeTriggerWords(["", "  "]) == VoiceWakePreferences.defaultTriggerWords)
    }

    @Test func sanitizeTriggerWordsLimitsWordLength() {
        let long = String(repeating: "x", count: VoiceWakePreferences.maxWordLength + 5)
        let cleaned = VoiceWakePreferences.sanitizeTriggerWords(["ok", long])
        #expect(cleaned[1].count == VoiceWakePreferences.maxWordLength)
    }

    @Test func sanitizeTriggerWordsLimitsWordCount() {
        let words = (1...VoiceWakePreferences.maxWords + 3).map { "w\($0)" }
        let cleaned = VoiceWakePreferences.sanitizeTriggerWords(words)
        #expect(cleaned.count == VoiceWakePreferences.maxWords)
    }

    @Test func displayStringUsesSanitizedWords() {
        #expect(VoiceWakePreferences.displayString(for: ["", " "]) == "smart-agent-neo, claude")
    }

    @Test func loadAndSaveTriggerWordsRoundTrip() {
        let suiteName = "VoiceWakePreferencesTests.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suiteName)!

        #expect(VoiceWakePreferences.loadTriggerWords(defaults: defaults) == VoiceWakePreferences.defaultTriggerWords)
        VoiceWakePreferences.saveTriggerWords(["computer"], defaults: defaults)
        #expect(VoiceWakePreferences.loadTriggerWords(defaults: defaults) == ["computer"])
    }
}
