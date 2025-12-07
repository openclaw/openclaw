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
}
