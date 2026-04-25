import Testing
@testable import OpenClawKit

struct TalkPromptBuilderTests {
    @Test func buildIncludesTranscript() {
        let prompt = TalkPromptBuilder.build(transcript: "Hello", interruptedAtSeconds: nil)
        #expect(prompt.contains("Talk Mode active."))
        #expect(prompt.hasSuffix("\n\nHello"))
    }

    @Test func buildIncludesInterruptionLineWhenProvided() {
        let prompt = TalkPromptBuilder.build(transcript: "Hi", interruptedAtSeconds: 1.234)
        #expect(prompt.contains("Assistant speech interrupted at 1.2s."))
    }

    @Test func buildIncludesVoiceDirectiveHintByDefault() {
        let prompt = TalkPromptBuilder.build(transcript: "Hello", interruptedAtSeconds: nil)
        #expect(prompt.contains("ElevenLabs voice"))
    }

    @Test func buildExcludesVoiceDirectiveHintWhenDisabled() {
        let prompt = TalkPromptBuilder.build(
            transcript: "Hello",
            interruptedAtSeconds: nil,
            includeVoiceDirectiveHint: false)
        #expect(!prompt.contains("ElevenLabs voice"))
        #expect(prompt.contains("Talk Mode active."))
    }
}
