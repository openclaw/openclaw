import XCTest
@testable import OpenClawKit

final class TalkPromptBuilderTests: XCTestCase {
    func testBuildTurnKeepsVisibleMessageClean() {
        let turn = TalkPromptBuilder.buildTurn(transcript: "Hello", interruptedAtSeconds: nil)
        XCTAssertEqual(turn.message, "Hello")
        XCTAssertNotNil(turn.runtimePromptContext)
        XCTAssertTrue(turn.runtimePromptContext?.contains("Talk Mode active.") ?? false)
        XCTAssertFalse(turn.message.contains("Talk Mode active."))
    }

    func testBuildTurnIncludesInterruptionInRuntimeContext() {
        let turn = TalkPromptBuilder.buildTurn(transcript: "Hi", interruptedAtSeconds: 1.234)
        XCTAssertEqual(turn.message, "Hi")
        XCTAssertTrue(turn.runtimePromptContext?.contains("Assistant speech interrupted at 1.2s.") ?? false)
    }

    func testBuildIncludesTranscript() {
        let prompt = TalkPromptBuilder.build(transcript: "Hello", interruptedAtSeconds: nil)
        XCTAssertTrue(prompt.contains("Talk Mode active."))
        XCTAssertTrue(prompt.hasSuffix("\n\nHello"))
    }

    func testBuildIncludesInterruptionLineWhenProvided() {
        let prompt = TalkPromptBuilder.build(transcript: "Hi", interruptedAtSeconds: 1.234)
        XCTAssertTrue(prompt.contains("Assistant speech interrupted at 1.2s."))
    }

    func testBuildIncludesVoiceDirectiveHintByDefault() {
        let prompt = TalkPromptBuilder.build(transcript: "Hello", interruptedAtSeconds: nil)
        XCTAssertTrue(prompt.contains("ElevenLabs voice"))
    }

    func testBuildExcludesVoiceDirectiveHintWhenDisabled() {
        let prompt = TalkPromptBuilder.build(
            transcript: "Hello",
            interruptedAtSeconds: nil,
            includeVoiceDirectiveHint: false)
        XCTAssertFalse(prompt.contains("ElevenLabs voice"))
        XCTAssertTrue(prompt.contains("Talk Mode active."))
    }
}
