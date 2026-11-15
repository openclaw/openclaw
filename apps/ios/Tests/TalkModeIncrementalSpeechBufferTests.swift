import Testing
@testable import OpenClaw

@MainActor
struct TalkModeIncrementalSpeechBufferTests {
    @Test func `emits soft boundary before terminal punctuation`() {
        let manager = TalkModeManager(allowSimulatorCapture: true)

        let partial =
            "We start speaking earlier by splitting this long stream chunk at a whitespace boundary before punctuation arrives"
        let segments = manager._test_incrementalIngest(partial, isFinal: false)

        #expect(segments.count == 1)
        #expect(segments[0].count >= 72)
        #expect(segments[0].count < partial.count)
    }

    @Test func `keeps short chunk buffered without punctuation`() {
        let manager = TalkModeManager(allowSimulatorCapture: true)

        let short = "short chunk without punctuation"
        let segments = manager._test_incrementalIngest(short, isFinal: false)

        #expect(segments.isEmpty)
    }

    @Test func `strips voice directive from every cumulative snapshot`() {
        let manager = TalkModeManager(allowSimulatorCapture: true)
        let directive = "{\"voice\":\"synthetic-voice\"}\n"

        #expect(manager._test_incrementalIngest(directive + "First sentence.", isFinal: false) == ["First sentence."])
        #expect(manager._test_incrementalIngest(
            directive + "First sentence. Second sentence.",
            isFinal: false) == ["Second sentence."])
        #expect(manager._test_incrementalIngest(
            directive + "First sentence. Second sentence. Final words",
            isFinal: true) == ["Final words"])
    }
}
