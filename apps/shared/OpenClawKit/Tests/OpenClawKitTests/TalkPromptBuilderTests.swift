import XCTest
@testable import OpenClawKit

final class TalkPromptBuilderTests: XCTestCase {
    func testBuildPreservesDefaultPrompt() {
        let prompt = TalkPromptBuilder.build(transcript: "Hello", interruptedAtSeconds: nil)
        XCTAssertEqual(prompt, """
        Talk Mode active. Reply in a concise, spoken tone.
        You may optionally prefix the response with JSON (first line) to set ElevenLabs voice \
        (id or alias), e.g. {"voice":"<id>","once":true}.

        Hello
        """)
    }

    func testBuildIncludesInterruptionLineWhenProvided() {
        let prompt = TalkPromptBuilder.build(transcript: "Hi", interruptedAtSeconds: 1.234)
        XCTAssertTrue(prompt.contains("Assistant speech interrupted at 1.2s."))
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
