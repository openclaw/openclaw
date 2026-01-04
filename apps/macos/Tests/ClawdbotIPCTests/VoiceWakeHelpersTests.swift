import Testing
@testable import Clawdbot

struct VoiceWakeHelpersTests {
    @Test func sanitizeTriggersTrimsAndDropsEmpty() {
        let cleaned = sanitizeVoiceWakeTriggers(["  hi  ", " ", "\n", "there"])
        #expect(cleaned == ["hi", "there"])
    }

    @Test func sanitizeTriggersFallsBackToDefaults() {
        let cleaned = sanitizeVoiceWakeTriggers(["   ", ""])
        #expect(cleaned == defaultVoiceWakeTriggers)
    }

    @Test func normalizeLocaleStripsCollation() {
        #expect(normalizeLocaleIdentifier("en_US@collation=phonebook") == "en_US")
    }

    @Test func normalizeLocaleStripsUnicodeExtensions() {
        #expect(normalizeLocaleIdentifier("de-DE-u-co-phonebk") == "de-DE")
        #expect(normalizeLocaleIdentifier("ja-JP-t-ja") == "ja-JP")
    }
}
