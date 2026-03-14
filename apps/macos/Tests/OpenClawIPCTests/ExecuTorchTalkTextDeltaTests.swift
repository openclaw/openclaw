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

    @Test func `merge promotes complete phrase when tail includes base`() {
        let merged = TalkModeRuntime._testMergeTranscriptForFinalize(
            base: "open the",
            tail: "open the finder")
        #expect(merged == "open the finder")
    }

    @Test func `merge replaces revised full hypothesis instead of concatenating`() {
        let merged = TalkModeRuntime._testMergeTranscriptForFinalize(
            base: "Could you please open it?",
            tail: "Could you please open the fine?")
        #expect(merged == "Could you please open the fine?")
    }

    @Test func `merge keeps longer stable phrase when revision regresses`() {
        let merged = TalkModeRuntime._testMergeTranscriptForFinalize(
            base: "Did you please open the finder?",
            tail: "Open the finder.")
        #expect(merged == "Did you please open the finder?")
    }

    @Test func `merge chain avoids accumulating competing hypotheses`() {
        var merged = TalkModeRuntime._testMergeTranscriptForFinalize(
            base: "Could you please open it?",
            tail: "Could you please open the fine?")
        merged = TalkModeRuntime._testMergeTranscriptForFinalize(
            base: merged,
            tail: "Did you please open the finder?")
        merged = TalkModeRuntime._testMergeTranscriptForFinalize(
            base: merged,
            tail: "Open the finder.")
        #expect(merged == "Did you please open the finder?")
    }

    @Test func `execuTorch silence window enforces safer minimum`() {
        let effective = TalkModeRuntime._testEffectiveSilenceWindow(
            configured: 0.7,
            useExecuTorch: true)
        #expect(effective == 1.2)
    }

    @Test func `non executorch silence window keeps configured value`() {
        let effective = TalkModeRuntime._testEffectiveSilenceWindow(
            configured: 0.7,
            useExecuTorch: false)
        #expect(effective == 0.7)
    }
}
