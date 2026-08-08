import Foundation
import OpenClawProtocol
import Speech
import Testing
@testable import OpenClaw
@testable import OpenClawKit

private enum RuntimeTestAudioCaptureError: Error {
    case inputUnavailable
}

@MainActor
private final class RuntimeTestAudioCapture: RealtimeTalkAudioCapturing {
    let suppressesInputDuringOutput = false
    var startError: Error?

    func start(
        targetSampleRate: Double,
        onAudio: @escaping @Sendable (RealtimeTalkAudioFrame) -> Void,
        onFailure: @escaping @MainActor (String) -> Void) throws
    {
        if let startError = self.startError {
            throw startError
        }
    }

    func stop() {}
}

private actor RuntimeTestRelayRequestLog {
    private var methods: [String] = []
    private var sessionIds: [String?] = []

    func record(method: String, params: [String: AnyCodable]?) {
        self.methods.append(method)
        self.sessionIds.append(params?["sessionId"]?.stringValue)
    }

    func snapshot() -> (methods: [String], sessionIds: [String?]) {
        (self.methods, self.sessionIds)
    }
}

/// Relay whose close RPC is observable, so runtime termination paths can be proven to release the
/// server-side session instead of only dropping their local reference.
@MainActor
private func makeRecordingRelaySession(
    requests: RuntimeTestRelayRequestLog,
    audioCapture: RuntimeTestAudioCapture) -> RealtimeTalkRelaySession
{
    let session = RealtimeTalkRelaySession(
        transport: RealtimeTalkRelayTransport(
            subscribeServerEvents: { _ in AsyncStream { $0.finish() } },
            request: { method, params, _ in
                await requests.record(method: method, params: params)
                return Data("{\"ok\":true}".utf8)
            }),
        options: .init(sessionKey: "main", provider: "openai", model: "gpt-realtime-2", voice: nil),
        audioCapture: audioCapture,
        pcmPlayer: RuntimeTestPCMPlayer(),
        onStatus: { _ in },
        onSpeakingChanged: { _ in })
    session._test_setRelaySessionId("relay-1")
    return session
}

private func waitForRelayClose(_ requests: RuntimeTestRelayRequestLog) async -> [String] {
    for _ in 0..<50 {
        let recorded = await requests.snapshot()
        if !recorded.methods.isEmpty { return recorded.methods }
        await Task.yield()
    }
    return await requests.snapshot().methods
}

@MainActor
private final class RuntimeTestPCMPlayer: PCMStreamingAudioPlaying {
    func play(
        stream: AsyncThrowingStream<Data, Error>,
        sampleRate: Double) async -> StreamingPlaybackResult
    {
        fatalError("Playback is not used by this test")
    }

    func stop() -> Double? {
        nil
    }
}

struct TalkModeRuntimeSpeechTests {
    @Test func `speech request uses dictation defaults`() {
        let request = SFSpeechAudioBufferRecognitionRequest()

        TalkModeRuntime.configureRecognitionRequest(request)

        #expect(request.shouldReportPartialResults)
        #expect(request.taskHint == .dictation)
        #expect(!request.requiresOnDeviceRecognition)
    }

    @Test func `playback plan routes unsupported local providers through gateway speak`() {
        let elevenLabsPlan = TalkModeRuntime.playbackPlan(
            provider: "elevenlabs",
            apiKey: "key",
            voiceId: "voice")
        let missingKeyPlan = TalkModeRuntime.playbackPlan(
            provider: "elevenlabs",
            apiKey: nil,
            voiceId: "voice")
        let missingVoicePlan = TalkModeRuntime.playbackPlan(
            provider: "elevenlabs",
            apiKey: "key",
            voiceId: nil)
        let blankKeyPlan = TalkModeRuntime.playbackPlan(
            provider: "elevenlabs",
            apiKey: "",
            voiceId: "voice")
        let openAIPlan = TalkModeRuntime.playbackPlan(provider: "openai", apiKey: nil, voiceId: "onyx")
        let customPlan = TalkModeRuntime.playbackPlan(provider: "acme-speech", apiKey: nil, voiceId: nil)
        let mlxPlan = TalkModeRuntime.playbackPlan(provider: "mlx", apiKey: nil, voiceId: nil)
        let systemPlan = TalkModeRuntime.playbackPlan(provider: "system", apiKey: nil, voiceId: nil)

        #expect(elevenLabsPlan == .elevenLabsThenSystemVoice(apiKey: "key", voiceId: "voice"))
        #expect(missingKeyPlan == .systemVoiceOnly)
        #expect(missingVoicePlan == .systemVoiceOnly)
        #expect(blankKeyPlan == .systemVoiceOnly)
        #expect(openAIPlan == .gatewayTalkSpeakThenSystemVoice)
        #expect(customPlan == .gatewayTalkSpeakThenSystemVoice)
        #expect(mlxPlan == .mlxThenSystemVoice)
        #expect(systemPlan == .systemVoiceOnly)
    }

    @Test func `mlx cancellation stops while failures preserve system fallback`() {
        #expect(TalkModeRuntime.mlxFailureDisposition(
            TalkMLXSpeechSynthesizer.SynthesizeError.canceled) == .canceled)
        #expect(TalkModeRuntime.mlxFailureDisposition(
            TalkMLXSpeechSynthesizer.SynthesizeError.audioGenerationFailed) == .fallback)
        #expect(TalkModeRuntime.mlxFailureDisposition(
            TalkMLXSpeechSynthesizer.SynthesizeError.modelLoadFailed("missing")) == .fallback)
    }

    @Test func `realtime recovery uses the iOS retry budget`() {
        #expect(TalkModeRuntime.realtimeRestartAttempt(
            previousRapidRestarts: 1,
            activeDuration: 5) == 2)
        #expect(TalkModeRuntime.realtimeRestartAttempt(
            previousRapidRestarts: 2,
            activeDuration: 31) == 1)
        #expect(TalkModeRuntime.realtimeRestartDelayNanoseconds(attempt: 1) == 500_000_000)
        #expect(TalkModeRuntime.realtimeRestartDelayNanoseconds(attempt: 2) == 2_000_000_000)
        #expect(TalkModeRuntime.realtimeRestartDelayNanoseconds(attempt: 3) == nil)
    }

    @Test @MainActor func `ready then audio failure clears relay owner and schedules bounded recovery`() async {
        let runtime = TalkModeRuntime()
        let session = RealtimeTalkRelaySession(
            transport: RealtimeTalkRelayTransport(
                subscribeServerEvents: { _ in AsyncStream { $0.finish() } },
                request: { _, _, _ in throw CancellationError() }),
            options: .init(sessionKey: "main", provider: "openai", model: "gpt-realtime-2", voice: nil),
            audioCapture: RuntimeTestAudioCapture(),
            pcmPlayer: RuntimeTestPCMPlayer(),
            onStatus: { _ in },
            onSpeakingChanged: { _ in })
        let relayGeneration = await runtime._test_prepareEnabledRealtimeSessionForClose(session)

        _ = await runtime._test_handleRealtimeTermination(
            .remoteClose(reason: "stale"),
            relayGeneration: relayGeneration &- 1)
        #expect(await runtime._test_realtimeSessionIsActive())

        await runtime._test_handleRealtimeStatus(
            "Listening (Realtime)",
            relayGeneration: relayGeneration)
        let recoveryScheduled = await runtime._test_handleRealtimeTermination(
            .audioCaptureFailed(message: "microphone unavailable"),
            relayGeneration: relayGeneration)

        #expect(await !(runtime._test_realtimeSessionIsActive()))
        #expect(await runtime._test_rapidRealtimeRestartCount() == 1)
        #expect(recoveryScheduled)

        await runtime._test_cancelRealtimeRecovery()
        session.stop()
    }

    @Test @MainActor func `selected microphone restart failure closes relay and schedules recovery`() async {
        let runtime = TalkModeRuntime()
        let requests = RuntimeTestRelayRequestLog()
        let session = makeRecordingRelaySession(
            requests: requests,
            audioCapture: RuntimeTestAudioCapture())
        let relayGeneration = await runtime._test_prepareEnabledRealtimeSessionForClose(session)

        let recoveryScheduled = await runtime._test_handleRealtimeInputRestartFailure(
            "selected microphone unavailable",
            relayGeneration: relayGeneration)

        #expect(await !(runtime._test_realtimeSessionIsActive()))
        #expect(await runtime._test_rapidRealtimeRestartCount() == 1)
        #expect(recoveryScheduled)

        // Ownership must not be dropped while the server relay stays live; recovery would then
        // run a second session against the same gateway lease.
        let recorded = await waitForRelayClose(requests)
        #expect(recorded == ["talk.session.close"])
        #expect(await requests.snapshot().sessionIds == ["relay-1"])

        await runtime._test_cancelRealtimeRecovery()
        session.stop()
    }

    @Test @MainActor func `unpause that cannot restart capture closes relay and schedules recovery`() async {
        let runtime = TalkModeRuntime()
        let requests = RuntimeTestRelayRequestLog()
        let audioCapture = RuntimeTestAudioCapture()
        let session = makeRecordingRelaySession(requests: requests, audioCapture: audioCapture)
        _ = await runtime._test_prepareEnabledRealtimeSessionForClose(session)

        await runtime.setPaused(true)
        audioCapture.startError = RuntimeTestAudioCaptureError.inputUnavailable
        let recoveryScheduled = await runtime._test_setPausedAndHasPendingRealtimeRestart(false)

        // Talk must never stay enabled with no microphone and no route back: the failed unpause
        // has to reach the same bounded recovery / native-speech fallback as any other capture loss.
        #expect(await !(runtime._test_realtimeSessionIsActive()))
        #expect(await runtime._test_rapidRealtimeRestartCount() == 1)
        #expect(recoveryScheduled)

        let recorded = await waitForRelayClose(requests)
        #expect(recorded == ["talk.session.close"])

        await runtime._test_cancelRealtimeRecovery()
        session.stop()
    }

    @Test func `talk speak params carry resolved voice and directive overrides`() {
        let params = TalkModeRuntime.makeTalkSpeakParams(
            text: "hello",
            voiceId: "voice-123",
            modelId: "eleven_v3",
            outputFormat: "mp3_44100_128",
            directive: TalkDirective(
                modelId: "eleven_turbo_v2_5",
                speed: 1.1,
                rateWPM: 180,
                stability: 0.4,
                similarity: 0.7,
                style: 0.2,
                speakerBoost: true,
                seed: 42,
                normalize: "auto",
                language: "en",
                outputFormat: "mp3_44100_128",
                latencyTier: 3))

        #expect(params["text"]?.value as? String == "hello")
        #expect(params["voiceId"]?.value as? String == "voice-123")
        #expect(params["modelId"]?.value as? String == "eleven_turbo_v2_5")
        #expect(params["outputFormat"]?.value as? String == "mp3_44100_128")
        #expect(params["speed"]?.value as? Double == 1.1)
        #expect(params["rateWpm"]?.value as? Int == 180)
        #expect(params["stability"]?.value as? Double == 0.4)
        #expect(params["similarity"]?.value as? Double == 0.7)
        #expect(params["style"]?.value as? Double == 0.2)
        #expect(params["speakerBoost"]?.value as? Bool == true)
        #expect(params["seed"]?.value as? Int == 42)
        #expect(params["normalize"]?.value as? String == "auto")
        #expect(params["language"]?.value as? String == "en")
        #expect(params["latencyTier"]?.value as? Int == 3)
    }
}
