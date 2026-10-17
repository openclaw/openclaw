import Testing
@testable import OpenClaw

/// Simulator capture has no Speech task; these tests deliver its results.
@Suite(.serialized) @MainActor struct TalkPushToTalkReleaseTests {
    @Test func `release keeps words Speech finalizes after the microphone closes`() async throws {
        let talkMode = TalkModeManager(allowSimulatorCapture: true)
        defer { talkMode.stop() }
        let start = try await talkMode.beginPushToTalk(transcriptionOnly: true)
        await talkMode._test_handlePushToTalkTranscript(
            "remind me to call the dentist",
            isFinal: false,
            captureId: start.captureId)

        let release = Task { @MainActor in await talkMode.endPushToTalk(captureId: start.captureId) }
        await waitUntil { !talkMode.isPushToTalkActive }
        await talkMode._test_handlePushToTalkTranscript(
            "remind me to call the dentist about the appointment",
            isFinal: true,
            captureId: start.captureId)

        let stopped = await release.value
        #expect(stopped.status == "transcribed")
        #expect(stopped.transcript == "remind me to call the dentist about the appointment")
        #expect(talkMode._test_activePushToTalkCaptureId() == nil)
    }

    @Test func `cancel while Speech settles a release discards the transcript`() async throws {
        let talkMode = TalkModeManager(allowSimulatorCapture: true)
        defer { talkMode.stop() }
        let start = try await talkMode.beginPushToTalk(transcriptionOnly: true)
        await talkMode._test_handlePushToTalkTranscript(
            "discard after release",
            isFinal: false,
            captureId: start.captureId)

        let release = Task { @MainActor in await talkMode.endPushToTalk(captureId: start.captureId) }
        await waitUntil { !talkMode.isPushToTalkActive }
        #expect(talkMode.cancelPushToTalk(captureId: start.captureId).status == "cancelled")

        let stopped = await release.value
        #expect(stopped.status == "cancelled")
        #expect(stopped.transcript == nil)
        #expect(talkMode._test_pushToTalkCaptureIsIdle())
        let replacement = try await talkMode.beginPushToTalk(transcriptionOnly: true)
        #expect(talkMode.cancelPushToTalk(captureId: replacement.captureId).status == "cancelled")
    }
}

@MainActor
private func waitUntil(_ condition: @MainActor () -> Bool) async {
    for _ in 0..<2000 {
        if condition() {
            return
        }
        try? await Task.sleep(nanoseconds: 1_000_000)
    }
    Issue.record("Timed out waiting for push-to-talk state")
}
