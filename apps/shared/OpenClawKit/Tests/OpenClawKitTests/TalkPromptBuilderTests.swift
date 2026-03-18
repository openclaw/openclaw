import XCTest
@testable import OpenClawKit

final class TalkPromptBuilderTests: XCTestCase {
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

    func testBuildDoesNotIncludeSttBackendInPrompt() {
        let prompt = TalkPromptBuilder.build(
            transcript: "Hi",
            interruptedAtSeconds: nil,
            sttBackendName: "ExecuTorch Parakeet-TDT")
        XCTAssertFalse(prompt.contains("ExecuTorch"), "STT backend must not appear in prompt so the model does not mention it")
        XCTAssertTrue(prompt.hasSuffix("\n\nHi"))
    }

    func testDisplayTextStripsTalkModePrefix() {
        let fullPrompt = TalkPromptBuilder.build(
            transcript: "Hello, can you hear me?",
            interruptedAtSeconds: nil,
            includeVoiceDirectiveHint: true)
        let display = TalkPromptBuilder.displayText(fromPrompt: fullPrompt)
        XCTAssertEqual(display, "Hello, can you hear me?")
        XCTAssertFalse(display.contains("Talk Mode active"))
        XCTAssertFalse(display.contains("ElevenLabs"))
    }

    func testDisplayTextReturnsOriginalWhenNotTalkModePrompt() {
        let plain = "Just a normal user message."
        XCTAssertEqual(TalkPromptBuilder.displayText(fromPrompt: plain), plain)
    }
}
