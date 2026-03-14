import Testing
@testable import OpenClaw

struct ExecuTorchTalkTextDeltaTests {
    @Test func `delta returns append when current extends previous prefix`() {
        let delta = ExecuTorchSTTBridge._testDeltaSuffix(
            previous: "hello",
            current: "hello there")
        #expect(delta == " there")
    }

    @Test func `delta uses suffix overlap to avoid replaying full transcript`() {
        let delta = ExecuTorchSTTBridge._testDeltaSuffix(
            previous: "the quick brown fox",
            current: "brown fox jumps")
        #expect(delta == " jumps")
    }

    @Test func `delta returns empty when transcript regresses`() {
        let delta = ExecuTorchSTTBridge._testDeltaSuffix(
            previous: "longer transcript",
            current: "longer")
        #expect(delta == "")
    }

    @Test func `merge avoids duplicate suffix when appending tail`() {
        let merged = TalkModeRuntime._testMergeTranscriptForFinalize(
            base: "hello world",
            tail: "world again")
        #expect(merged == "hello world again")
    }

    @Test func `merge appends with space when no overlap exists`() {
        let merged = TalkModeRuntime._testMergeTranscriptForFinalize(
            base: "hello",
            tail: "greetings")
        #expect(merged == "hello greetings")
    }
}
