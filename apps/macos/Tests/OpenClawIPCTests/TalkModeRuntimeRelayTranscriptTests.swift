import Foundation
import OpenClawProtocol
import Testing
@testable import OpenClaw
@testable import OpenClawKit

extension TalkModeRuntimeSpeechTests {
    @Test(arguments: ["stop talking", "end talking"])
    @MainActor
    func `gateway transcript events reach the local stop owner`(phrase: String) async throws {
        try #require(AppStateStore.shared.isPreview)
        let previousEnabled = AppStateStore.shared.talkEnabled
        let previousPhrases = AppStateStore.shared.talkStopPhrases
        AppStateStore.shared.talkEnabled = true
        AppStateStore.shared.talkStopPhrases = ["stop talking", "end talking"]
        defer {
            AppStateStore.shared.talkEnabled = previousEnabled
            AppStateStore.shared.talkStopPhrases = previousPhrases
        }
        let events = AsyncStream<EventFrame>.makeStream(bufferingPolicy: .bufferingNewest(8))
        defer { events.continuation.finish() }
        let requests = RuntimeTestRelayRequestLog()
        let bootstrap = try makeRuntimeTestBootstrap(requests: requests, eventChannel: events)
        let runtime = TalkModeRuntime(realtimeTalkBootstrapProvider: { bootstrap })
        await runtime._test_setRealtimeAudioCaptureProvider { RuntimeTestAudioCapture() }
        let lifecycle = await runtime._test_prepareEnabledLifecycle()
        await runtime._test_enableRealtimeRelaySelection()

        func transcript(_ text: String, role: String = "user", final: Bool = true, relay: String = "relay-1")
            -> EventFrame
        {
            EventFrame(
                type: "event",
                event: "talk.event",
                payload: AnyCodable([
                    "relaySessionId": AnyCodable(relay),
                    "type": AnyCodable("transcript"),
                    "role": AnyCodable(role),
                    "text": AnyCodable(text),
                    "final": AnyCodable(final),
                ]),
                seq: nil,
                stateversion: nil)
        }

        do {
            try await runtime.startRealtimeRelay(generation: lifecycle)
            // Exercise the production event pump and callback task, not the runtime handler directly.
            events.continuation.yield(transcript(phrase, final: false))
            try await waitForRuntimeCondition("partial gateway transcript projected") {
                await MainActor.run { TalkModeController.shared.partialTranscript == phrase }
            }
            #expect(await runtime.isEnabled)

            let quoted = "\"\(phrase)\""
            events.continuation.yield(transcript(quoted))
            try await waitForRuntimeCondition("quoted gateway transcript committed") {
                await MainActor.run { TalkModeController.shared.recentTranscripts.last == quoted }
            }
            #expect(await runtime.isEnabled)

            events.continuation.yield(transcript(phrase, role: "assistant"))
            events.continuation.yield(transcript(phrase, relay: "retired-relay"))
            let ordinary = "Please explain this feature."
            events.continuation.yield(transcript(ordinary))
            try await waitForRuntimeCondition("current user transcript after ignored gateway events") {
                await MainActor.run { TalkModeController.shared.recentTranscripts.last == ordinary }
            }
            #expect(await runtime.isEnabled)
            #expect(AppStateStore.shared.talkEnabled)

            events.continuation.yield(transcript(phrase))
            try await waitForRuntimeCondition("gateway command disables Talk") {
                guard await runtime.isEnabled == false, await runtime.realtimeSession == nil else { return false }
                return await MainActor.run { !AppStateStore.shared.talkEnabled }
            }
            try await requests.waitForCount(3)
            #expect(await requests.snapshot().methods == [
                "talk.session.create", "talk.catalog", "talk.session.close",
            ])
            #expect(await runtime.phase == .idle)
        } catch {
            await runtime.setEnabled(false)
            throw error
        }
        await runtime.setEnabled(false)
    }
}
