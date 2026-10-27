import Foundation
import Testing
@testable import OpenClaw

struct VoiceWakePreferencesTests {
    @Test func `sanitize trigger words trims and drops empty`() {
        #expect(VoiceWakePreferences.sanitizeTriggerWords([" openclaw ", "", " \nclaude\t"]) == ["openclaw", "claude"])
    }

    @Test func `sanitize trigger words falls back to defaults when empty`() {
        #expect(VoiceWakePreferences.sanitizeTriggerWords(["", "  "]) == VoiceWakePreferences.defaultTriggerWords)
    }

    @Test func `sanitize trigger words limits word length`() {
        let long = String(repeating: "x", count: VoiceWakePreferences.maxWordLength + 5)
        let cleaned = VoiceWakePreferences.sanitizeTriggerWords(["ok", long])
        #expect(cleaned[1].count == VoiceWakePreferences.maxWordLength)
    }

    @Test func `sanitize trigger words limits word count`() {
        let words = (1...VoiceWakePreferences.maxWords + 3).map { "w\($0)" }
        let cleaned = VoiceWakePreferences.sanitizeTriggerWords(words)
        #expect(cleaned.count == VoiceWakePreferences.maxWords)
    }

    @Test func `load and save trigger words round trip`() throws {
        let suiteName = "VoiceWakePreferencesTests.\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suiteName))

        #expect(VoiceWakePreferences.loadTriggerWords(defaults: defaults) == VoiceWakePreferences.defaultTriggerWords)
        VoiceWakePreferences.saveTriggerWords(["computer"], defaults: defaults)
        #expect(VoiceWakePreferences.loadTriggerWords(defaults: defaults) == ["computer"])
    }
}
