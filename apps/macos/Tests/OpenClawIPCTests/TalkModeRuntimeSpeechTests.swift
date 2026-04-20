import Speech
import Testing
@testable import OpenClaw

struct TalkModeRuntimeSpeechTests {
    @Test func `speech request uses dictation defaults`() {
        let request = SFSpeechAudioBufferRecognitionRequest()

        TalkModeRuntime.configureRecognitionRequest(request)

        #expect(request.shouldReportPartialResults)
        #expect(request.taskHint == .dictation)
    }

    @Test func `playback plan falls back only from elevenlabs`() {
        let elevenLabsPlan = TalkModeRuntime.playbackPlan(
            provider: "elevenlabs",
            apiKey: "key",
            voiceId: "voice"
        )
        let missingKeyPlan = TalkModeRuntime.playbackPlan(
            provider: "elevenlabs",
            apiKey: nil,
            voiceId: "voice"
        )
        let missingVoicePlan = TalkModeRuntime.playbackPlan(
            provider: "elevenlabs",
            apiKey: "key",
            voiceId: nil
        )
        let blankKeyPlan = TalkModeRuntime.playbackPlan(
            provider: "elevenlabs",
            apiKey: "",
            voiceId: "voice"
        )
        let mlxPlan = TalkModeRuntime.playbackPlan(provider: "mlx", apiKey: nil, voiceId: nil)
        let systemPlan = TalkModeRuntime.playbackPlan(provider: "system", apiKey: nil, voiceId: nil)

        #expect(elevenLabsPlan == .elevenLabsThenSystemVoice(apiKey: "key", voiceId: "voice"))
        #expect(missingKeyPlan == .systemVoiceOnly)
        #expect(missingVoicePlan == .systemVoiceOnly)
        #expect(blankKeyPlan == .systemVoiceOnly)
        #expect(mlxPlan == .mlxThenSystemVoice)
        #expect(systemPlan == .systemVoiceOnly)
    }
}
