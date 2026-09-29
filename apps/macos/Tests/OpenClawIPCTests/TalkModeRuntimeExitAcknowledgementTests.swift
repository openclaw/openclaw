import Foundation
import Testing
@testable import OpenClaw
@testable import OpenClawKit

@MainActor
private final class ExitAcknowledgementCapture: RealtimeTalkAudioCapturing {
    let suppressesInputDuringOutput = false
    private(set) var inputRetirementCount = 0
    let retired = AsyncStream<Void>.makeStream()

    func start(
        targetSampleRate: Double,
        onAudio: @escaping @Sendable (RealtimeTalkAudioFrame) -> Void,
        onFailure: @escaping @MainActor (String) -> Void) throws {}

    /// Startup retires the previous microphone pump before starting this capture.
    func stop() {}

    func stopInputPreservingPlayback() -> Bool {
        self.inputRetirementCount += 1
        self.retired.continuation.yield(())
        return true
    }

    func waitForInputRetirement() async throws {
        let stream = self.retired.stream
        let observed = try await AsyncTimeout.withTimeout(
            seconds: 5,
            onTimeout: { CancellationError() },
            operation: {
                var iterator = stream.makeAsyncIterator()
                return await iterator.next() != nil
            })
        try #require(observed)
    }
}

extension TalkModeRuntimeSpeechTests {
    @Test(arguments: [false, true]) @MainActor
    func `duplicate final command does not bypass pending acknowledgement`(pauseBeforeCompletion: Bool) async throws {
        try #require(AppStateStore.shared.isPreview)
        let previousSpoken = AppStateStore.shared.talkSpokenExitAcknowledgementEnabled
        AppStateStore.shared.talkSpokenExitAcknowledgementEnabled = true
        let previousEnabled = AppStateStore.shared.talkEnabled
        let previousPhrases = AppStateStore.shared.talkStopPhrases
        AppStateStore.shared.talkEnabled = true
        AppStateStore.shared.talkStopPhrases = ["end talking"]
        defer {
            AppStateStore.shared.talkSpokenExitAcknowledgementEnabled = previousSpoken
            AppStateStore.shared.talkEnabled = previousEnabled
            AppStateStore.shared.talkStopPhrases = previousPhrases
        }
        let requests = RuntimeTestRelayRequestLog()
        let bootstrap = try makeRuntimeTestBootstrap(requests: requests, exitAcknowledgementSupported: true)
        let runtime = TalkModeRuntime(realtimeTalkBootstrapProvider: { bootstrap })
        let capture = ExitAcknowledgementCapture()
        defer { capture.retired.continuation.finish() }
        await runtime._test_setRealtimeAudioCaptureProvider { capture }
        let lifecycle = await runtime._test_prepareEnabledLifecycle()
        await runtime._test_enableRealtimeRelaySelection()
        do {
            try await runtime.startRealtimeRelay(generation: lifecycle)
            let session = try #require(await runtime.realtimeSession)
            let command = Task {
                await runtime.handleLocalTalkExitCommand(
                    "end talking", isFinal: true, lifecycleGeneration: lifecycle)
            }
            do {
                try await capture.waitForInputRetirement()
                #expect(session._test_exitAcknowledgementPending)
                #expect(await runtime.handleLocalTalkExitCommand(
                    "end talking", isFinal: true, lifecycleGeneration: lifecycle))
                #expect(await runtime.isEnabled)
                #expect(AppStateStore.shared.talkEnabled)
                #expect(capture.inputRetirementCount == 1)
                #expect(await requests.snapshot().methods.contains("talk.session.close") == false)
                if pauseBeforeCompletion { await runtime.setPaused(true) }
                // Advance only the machine failure deadline; no wall-clock sleep or audio device.
                session._test_expireExitAcknowledgement()
                #expect(await command.value)
                #expect(await runtime.isEnabled == false)
                #expect(!AppStateStore.shared.talkEnabled)
                #expect(await runtime.realtimeSession == nil)
                #expect(await requests.snapshot().methods.filter { $0 == "talk.session.close" }.count == 1)
            } catch {
                session.stop()
                _ = await command.value
                throw error
            }
        } catch {
            await runtime.setEnabled(false)
            throw error
        }
        await runtime.setEnabled(false)
    }

    @Test(arguments: ["manual disable", "reconfiguration"])
    @MainActor
    func `retired acknowledgement cannot disable a successor`(replacement: String) async throws {
        try #require(AppStateStore.shared.isPreview)
        let previousSpoken = AppStateStore.shared.talkSpokenExitAcknowledgementEnabled
        AppStateStore.shared.talkSpokenExitAcknowledgementEnabled = true
        let previousEnabled = AppStateStore.shared.talkEnabled
        let previousPhrases = AppStateStore.shared.talkStopPhrases
        AppStateStore.shared.talkEnabled = true
        AppStateStore.shared.talkStopPhrases = ["stop talking"]
        defer {
            AppStateStore.shared.talkSpokenExitAcknowledgementEnabled = previousSpoken
            AppStateStore.shared.talkEnabled = previousEnabled
            AppStateStore.shared.talkStopPhrases = previousPhrases
        }
        let bootstrap = try makeRuntimeTestBootstrap(exitAcknowledgementSupported: true)
        let runtime = TalkModeRuntime(realtimeTalkBootstrapProvider: { bootstrap })
        let capture = ExitAcknowledgementCapture()
        defer { capture.retired.continuation.finish() }
        await runtime._test_setRealtimeAudioCaptureProvider { capture }
        let lifecycle = await runtime._test_prepareEnabledLifecycle()
        await runtime._test_enableRealtimeRelaySelection()
        do {
            try await runtime.startRealtimeRelay(generation: lifecycle)
            let session = try #require(await runtime.realtimeSession)
            let command = Task {
                await runtime.handleLocalTalkExitCommand(
                    "stop talking", isFinal: true, lifecycleGeneration: lifecycle)
            }
            do {
                try await capture.waitForInputRetirement()
                #expect(session._test_exitAcknowledgementPending)
                let successor: Int
                if replacement == "manual disable" {
                    await runtime.setEnabled(false)
                    successor = await runtime._test_prepareEnabledLifecycle()
                } else {
                    successor = await runtime.beginRealtimeReconfiguration().lifecycleGeneration
                    session._test_expireExitAcknowledgement()
                }
                #expect(await command.value)
                #expect(await runtime.isCurrent(successor))
                #expect(AppStateStore.shared.talkEnabled)
            } catch {
                session.stop()
                _ = await command.value
                throw error
            }
        } catch {
            await runtime.setEnabled(false)
            throw error
        }
        await runtime.setEnabled(false)
    }

    @Test @MainActor
    func `disabled spoken acknowledgement ignores gateway capability and exits immediately`() async throws {
        try #require(AppStateStore.shared.isPreview)
        let previousSpoken = AppStateStore.shared.talkSpokenExitAcknowledgementEnabled
        let previousEnabled = AppStateStore.shared.talkEnabled
        let previousPhrases = AppStateStore.shared.talkStopPhrases
        AppStateStore.shared.talkSpokenExitAcknowledgementEnabled = false
        AppStateStore.shared.talkEnabled = true
        AppStateStore.shared.talkStopPhrases = ["end talking"]
        defer {
            AppStateStore.shared.talkSpokenExitAcknowledgementEnabled = previousSpoken
            AppStateStore.shared.talkEnabled = previousEnabled
            AppStateStore.shared.talkStopPhrases = previousPhrases
        }
        let requests = RuntimeTestRelayRequestLog()
        let bootstrap = try makeRuntimeTestBootstrap(requests: requests, exitAcknowledgementSupported: true)
        let runtime = TalkModeRuntime(realtimeTalkBootstrapProvider: { bootstrap })
        let capture = ExitAcknowledgementCapture()
        defer { capture.retired.continuation.finish() }
        await runtime._test_setRealtimeAudioCaptureProvider { capture }
        let lifecycle = await runtime._test_prepareEnabledLifecycle()
        await runtime._test_enableRealtimeRelaySelection()
        do {
            try await runtime.startRealtimeRelay(generation: lifecycle)
            let session = try #require(await runtime.realtimeSession)
            #expect(await runtime.handleLocalTalkExitCommand(
                "end talking", isFinal: true, lifecycleGeneration: lifecycle))
            #expect(capture.inputRetirementCount == 0)
            #expect(!session._test_exitAcknowledgementPending)
            #expect(await runtime.isEnabled == false)
            #expect(!AppStateStore.shared.talkEnabled)
            #expect(await requests.snapshot().methods.filter { $0 == "talk.session.close" }.count == 1)
        } catch {
            await runtime.setEnabled(false)
            throw error
        }
        await runtime.setEnabled(false)
    }
}
