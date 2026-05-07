import XCTest
@testable import OpenClawKit

final class TalkPromptBuilderTests: XCTestCase {
    func testBuildIncludesTranscript() {
        let prompt = TalkPromptBuilder.build(transcript: "Hello", interruptedAtSeconds: nil)
        XCTAssertEqual(prompt, "Hello")
        XCTAssertFalse(prompt.contains("Talk Mode active."))
    }

    func testBuildIncludesInterruptionLineWhenProvided() {
        let prompt = TalkPromptBuilder.build(transcript: "Hi", interruptedAtSeconds: 1.234)
        XCTAssertTrue(prompt.contains("Assistant speech interrupted at 1.2s."))
    }

    func testBuildExcludesVoiceDirectiveHintByDefault() {
        let prompt = TalkPromptBuilder.build(transcript: "Hello", interruptedAtSeconds: nil)
        XCTAssertFalse(prompt.contains("ElevenLabs voice"))
    }

    func testBuildExcludesVoiceDirectiveHintWhenDisabled() {
        let prompt = TalkPromptBuilder.build(
            transcript: "Hello",
            interruptedAtSeconds: nil,
            includeVoiceDirectiveHint: false)
        XCTAssertFalse(prompt.contains("ElevenLabs voice"))
        XCTAssertFalse(prompt.contains("Talk Mode active."))
    }
}
