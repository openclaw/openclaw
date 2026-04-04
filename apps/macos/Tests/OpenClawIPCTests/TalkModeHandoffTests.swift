import Testing
@testable import OpenClaw

@MainActor
struct TalkModeHandoffTests {
    @Test func `wake word sessions route into talk mode`() {
        #expect(VoiceSessionCoordinator.route(for: .wakeWord) == .talkMode)
    }

    @Test func `push to talk sessions keep forward routing`() {
        #expect(VoiceSessionCoordinator.route(for: .pushToTalk) == .forward)
    }

    @Test func `talk runtime blocks wake only while enabled and unpaused`() {
        #expect(TalkModeRuntime._testShouldBlockVoiceWake(isEnabled: true, isPaused: false))
        #expect(!TalkModeRuntime._testShouldBlockVoiceWake(isEnabled: true, isPaused: true))
        #expect(!TalkModeRuntime._testShouldBlockVoiceWake(isEnabled: false, isPaused: false))
    }
}
