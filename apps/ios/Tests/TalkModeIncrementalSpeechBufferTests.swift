import Testing
@testable import OpenClaw

struct TalkModeIncrementalSpeechBufferTests {
    @Test func `emits soft boundary before terminal punctuation`() {
        var buffer = IncrementalSpeechBuffer()

        let partial =
            "We start speaking earlier by splitting this long stream chunk at a whitespace boundary " +
            "before punctuation arrives"
        let segments = buffer.ingest(text: partial, isFinal: false)

        #expect(segments.count == 1)
        #expect(segments[0].count >= 72)
        #expect(segments[0].count < partial.count)
    }

    @Test func `keeps short chunk buffered without punctuation`() {
        var buffer = IncrementalSpeechBuffer()

        let short = "short chunk without punctuation"
        let segments = buffer.ingest(text: short, isFinal: false)

        #expect(segments.isEmpty)
    }

    @Test func `strips voice directive from every cumulative snapshot`() {
        var buffer = IncrementalSpeechBuffer()
        let directive = "{\"voice\":\"synthetic-voice\"}\n"

        #expect(buffer.ingest(text: directive + "First sentence.", isFinal: false) == ["First sentence."])
        #expect(buffer.ingest(
            text: directive + "First sentence. Second sentence.",
            isFinal: false) == ["Second sentence."])
        #expect(buffer.ingest(
            text: directive + "First sentence. Second sentence. Final words",
            isFinal: true) == ["Final words"])
    }
}
