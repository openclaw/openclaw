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

    func testDisplayTextStripsSystemEventsBeforeTalkMode() {
        let prompt = """
        System: [2026-03-31 13:10:45 PDT] Node: Young의 MacBook Pro (172.30.1.66) · reason launch
        System: [2026-03-31 13:10:45 PDT] reason connect

        Talk Mode active. Reply in a concise, spoken tone.
        You may optionally prefix the response with JSON (first line) to set ElevenLabs voice (id or alias), e.g. {"voice":"<id>","once":true}.

        Hey what's up?
        """
        let display = TalkPromptBuilder.displayText(fromPrompt: prompt)
        XCTAssertEqual(display, "Hey what's up?")
        XCTAssertFalse(display.contains("System:"))
        XCTAssertFalse(display.contains("Talk Mode active"))
    }
}
