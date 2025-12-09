import Testing
@testable import Clawdis

@Suite struct VoiceWakeRuntimeTests {
    @Test func matchesIsCaseInsensitive() {
        let triggers = ["ClAwD", "buddy"]
        #expect(VoiceWakeRuntime._testMatches(text: "hey clawd are you there", triggers: triggers))
        #expect(!VoiceWakeRuntime._testMatches(text: "nothing to see", triggers: triggers))
    }

    @Test func matchesIgnoresWhitespace() {
        let triggers = ["  claude  "]
        #expect(VoiceWakeRuntime._testMatches(text: "hello claude!", triggers: triggers))
    }

    @Test func matchesSkipsEmptyTriggers() {
        let triggers = ["   ", ""]
        #expect(!VoiceWakeRuntime._testMatches(text: "hello", triggers: triggers))
    }

    @Test func trimsAfterTriggerKeepsPostSpeech() {
        let triggers = ["claude", "clawd"]
        let text = "hey Claude how are you"
        #expect(VoiceWakeRuntime._testTrimmedAfterTrigger(text, triggers: triggers) == "how are you")
    }

    @Test func trimsAfterTriggerReturnsOriginalWhenNoTrigger() {
        let triggers = ["claude"]
        let text = "good morning friend"
        #expect(VoiceWakeRuntime._testTrimmedAfterTrigger(text, triggers: triggers) == text)
    }

    @Test func trimsAfterFirstMatchingTrigger() {
        let triggers = ["buddy", "claude"]
        let text = "hello buddy this is after trigger claude also here"
        #expect(VoiceWakeRuntime
            ._testTrimmedAfterTrigger(text, triggers: triggers) == "this is after trigger claude also here")
    }

    @Test func hasContentAfterTriggerFalseWhenOnlyTrigger() {
        let triggers = ["clawd"]
        let text = "hey clawd"
        #expect(!VoiceWakeRuntime._testHasContentAfterTrigger(text, triggers: triggers))
    }

    @Test func hasContentAfterTriggerTrueWhenSpeechContinues() {
        let triggers = ["claude"]
        let text = "claude write a note"
        #expect(VoiceWakeRuntime._testHasContentAfterTrigger(text, triggers: triggers))
    }
}
