import Foundation
import OpenClawKit
import Speech
import Testing
@testable import OpenClaw

/// Opt-in native startup proof in a disposable Mac with Speech services but no usable audio input.
/// Recognition startup selects its real recognizer and timing before rejecting missing hardware.
/// This neither records speech nor replaces full-app Gateway/agent/model proof.
@Suite(.serialized)
@MainActor
struct TalkModeRuntimeNativeLocaleProofTests {
    @Test(
        .enabled(if: ProcessInfo.processInfo.environment["OPENCLAW_TALK_NATIVE_SETUP_PROOF"] == "1"),
        arguments: [("ja-JP", "en-US", 2.0), ("en-US", "ko-KR", 0.7)])
    func `native startup applies the actual recognizer language pause`(
        speechLocale: String,
        voiceWakeLocale: String,
        expectedWindow: Double) async throws
    {
        let hasInput = AudioInputDeviceObserver.hasUsableDefaultInputDevice()
        try #require(
            !hasInput,
            "Run only in a disposable Mac without a usable input device")
        try #require(SFSpeechRecognizer.supportedLocales().contains { $0.identifier == speechLocale })
        try await TestIsolation.withIsolatedState(defaults: [
            swabbleEnabledKey: false,
            talkEnabledKey: false,
            voiceWakeLocaleKey: voiceWakeLocale,
        ]) {
            let state = AppState(preview: true)
            state.voiceWakeLocaleID = voiceWakeLocale
            state.voiceWakeMicID = ""
            let snapshot = TalkConfigSnapshot(
                [
                    "speechLocale": AnyCodable(speechLocale),
                    "silenceTimeoutMs": AnyCodable(700),
                ],
                defaultProvider: "system",
                defaultSilenceTimeoutMs: 700)
            let config = TalkModeGatewayConfigState(
                snapshot: snapshot,
                voiceId: nil,
                modelId: nil,
                outputFormat: nil,
                apiKey: nil,
                referenceAudioPath: nil,
                referenceText: nil)
            let live = TalkModeRuntime.Dependencies.live
            let runtime = TalkModeRuntime(
                state: { state },
                controller: { nil },
                dependencies: .init(
                    permissions: live.permissions,
                    audioCapture: live.audioCapture,
                    pcmPlayer: live.pcmPlayer,
                    selectedSession: { nil },
                    stopPCM: { nil },
                    stopMP3: { nil },
                    stopBuffered: { nil },
                    stopSystem: {},
                    stopMLX: {}))
            await runtime.applyTalkConfig(config)
            let generation = await runtime._test_prepareEnabledLifecycle()
            do {
                let started = await runtime.startRecognition(lifecycleGeneration: generation)
                let observed = try await Self.recognitionSetup(runtime)
                try #require(observed.isAvailable, "Apple Speech is unavailable in this worker")
                #expect(!started)
                #expect(observed.locale == speechLocale)
                #expect(observed.window == expectedWindow)
            } catch {
                await runtime.setEnabled(false)
                throw error
            }
            await runtime.setEnabled(false)
        }
    }

    /// Observe the runtime's applied state without exposing a production-only-for-tests accessor.
    private static func recognitionSetup(
        _ runtime: isolated TalkModeRuntime) throws -> (locale: String, isAvailable: Bool, window: Double)
    {
        let fields = Mirror(reflecting: runtime).children
        let cache = try #require(fields.first { $0.label == "recognizerCache" }?.value)
        let recognizer = try #require(
            Mirror(reflecting: cache).children.first { $0.label == "cached" }?.value as? SFSpeechRecognizer)
        let window = try #require(fields.first { $0.label == "silenceWindow" }?.value as? Double)
        return (recognizer.locale.identifier, recognizer.isAvailable, window)
    }
}
