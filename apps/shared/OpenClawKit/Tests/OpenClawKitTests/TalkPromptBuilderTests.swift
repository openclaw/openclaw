import XCTest
@testable import OpenClawKit

final class TalkPromptBuilderTests: XCTestCase {
    func testBuildIncludesTranscript() {
        let prompt = TalkPromptBuilder.build(transcript: "Hello", interruptedAtSeconds: nil)
        XCTAssertEqual(prompt, "Hello")
    }

    func testBuildIncludesInterruptionLineWhenProvided() {
        let prompt = TalkPromptBuilder.build(transcript: "Hi", interruptedAtSeconds: 1.234)
        XCTAssertEqual(prompt, "Assistant speech interrupted at 1.2s.\n\nHi")
    }

    func testBuildDoesNotInjectTalkModeInstructions() {
        let prompt = TalkPromptBuilder.build(transcript: "Hello", interruptedAtSeconds: nil)
        XCTAssertFalse(prompt.contains("Talk Mode active."))
        XCTAssertFalse(prompt.contains("ElevenLabs voice"))
    }

    func testVoiceDirectiveHintFlagDoesNotChangeUserMessage() {
        let prompt = TalkPromptBuilder.build(
            transcript: "Hello",
            interruptedAtSeconds: nil,
            includeVoiceDirectiveHint: false)
        XCTAssertEqual(prompt, "Hello")
    }
}
