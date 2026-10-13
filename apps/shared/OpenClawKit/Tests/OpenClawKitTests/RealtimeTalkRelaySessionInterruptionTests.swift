import Foundation
import OpenClawProtocol
import Testing
@testable import OpenClawKit

@MainActor
struct RealtimeTalkRelaySessionInterruptionTests {
    @Test(arguments: [false, true], ["provider", "denied", "denied-idle", "denied-applied"])
    func `provider-owned interruptions keep microphone and playback open until explicit stop`(
        suppressesInputDuringOutput: Bool,
        catalogScenario: String) async throws
    {
        let requests = RealtimeRelayStartupRequestLog()
        let events = AsyncStream<EventFrame>.makeStream()
        let speaking = RealtimeRelayTestSignal<Bool>()
        let terminated = RealtimeRelayTestSignal<RealtimeTalkRelayTermination>()
        let capture = TestRealtimeTalkAudioCapture()
        capture.suppressesInputDuringOutput = suppressesInputDuringOutput
        let player = StalledPCMStreamingAudioPlayer()
        let resolvedModel = suppressesInputDuringOutput ? nil : "resolved-model"
        let resultData = try JSONEncoder().encode(TalkSessionCreateResult(
            sessionid: "talk-session",
            provider: "test-provider",
            mode: AnyCodable("realtime"),
            transport: AnyCodable("gateway-relay"),
            brain: AnyCodable("agent-consult"),
            relaysessionid: "relay-1",
            model: resolvedModel))
        let session = RealtimeTalkRelaySession(
            transport: RealtimeTalkRelayTransport(
                subscribeServerEvents: { _ in events.stream },
                request: { method, params, _ in
                    await requests.record(method: method, params: params)
                    switch method {
                    case "talk.session.create":
                        events.continuation.yield(EventFrame(
                            type: "event",
                            event: "talk.event",
                            payload: AnyCodable(["relaySessionId": "relay-1", "type": "ready"]),
                            seq: nil,
                            stateversion: nil))
                        return resultData
                    case "talk.catalog":
                        guard catalogScenario == "provider" else { throw URLError(.userAuthenticationRequired) }
                        return try realtimeRelayCatalogData(supportsBargeIn: false)
                    case "talk.session.cancelOutput":
                        if catalogScenario == "denied-idle" {
                            return Data(#"{"ok":true,"status":"idle"}"#.utf8)
                        }
                        events.continuation.yield(outputClearEvent(turnId: "continuous-turn"))
                        if catalogScenario != "denied-applied" {
                            events.continuation.yield(EventFrame(
                                type: "event",
                                event: "talk.event",
                                payload: AnyCodable([
                                    "relaySessionId": "relay-1", "type": "close", "reason": "completed",
                                    "talkEvent": [
                                        "type": "session.closed",
                                        "payload": ["reason": "output-cancelled"],
                                    ],
                                ]),
                                seq: nil,
                                stateversion: nil))
                        }
                        return Data(#"{"ok":true,"status":"applied","turnId":"continuous-turn"}"#.utf8)
                    default:
                        return Data(#"{"ok":true}"#.utf8)
                    }
                }),
            options: .init(
                sessionKey: "main", provider: "test-alias", model: "configured-model", voice: nil),
            audioCapture: capture,
            pcmPlayer: player,
            onStatus: { _ in },
            onTermination: { terminated.send($0) },
            onSpeakingChanged: { speaking.send($0) })
        defer {
            session.stop()
            events.continuation.finish()
        }
        try await session.start()
        events.continuation.yield(outputAudioEvent(
            turnId: "continuous-turn", data: Data(repeating: 1, count: 960)))
        #expect(try await speaking.next("continuous playback") == true)
        try await player.waitForPlaybackCount(1)

        capture.emit(RealtimeTalkAudioFrame(
            data: Data([1, 2]),
            timestampMs: ProcessInfo.processInfo.systemUptime * 1000 + 1000,
            rms: 0.5))
        try await requests.waitForRequestCount(3)
        let activeRequests = await requests.snapshot()
        #expect(activeRequests.map(\.method) == [
            "talk.session.create", "talk.catalog", "talk.session.appendAudio",
        ])
        #expect(activeRequests[1].params?["provider"]?.stringValue == "test-provider")
        #expect(activeRequests[1].params?["model"]?.stringValue == (resolvedModel ?? "configured-model"))
        #expect(activeRequests[2].params?["audioBase64"]?.stringValue == Data([1, 2]).base64EncodedString())
        #expect(!session.cancelOutput(reason: "barge-in"))
        #expect(capture.isStarted)
        #expect(player.stopCount == 0)

        // Provider clear starts another segment of the same continuous turn, without audioDone.
        events.continuation.yield(outputClearEvent(turnId: "continuous-turn", talkEventType: "output.clear"))
        #expect(try await speaking.next("provider clear") == false)
        events.continuation.yield(outputAudioEvent(
            turnId: "continuous-turn", data: Data(repeating: 2, count: 960)))
        #expect(try await speaking.next("playback after clear") == true)
        try await player.waitForPlaybackCount(2)
        #expect(session.cancelOutput(reason: "user"))
        let cancellation = try #require(session._test_outputCancellationTask())
        await cancellation.value
        let preservesConnection = catalogScenario == "denied-idle" || catalogScenario == "denied-applied"
        if preservesConnection {
            // Neither idle nor applied GA cancellation ends the session. A later disconnection
            // before the next audio turn must keep ordinary recovery, including when catalog access failed.
            events.continuation.yield(EventFrame(
                type: "event",
                event: "talk.event",
                payload: AnyCodable([
                    "relaySessionId": "relay-1", "type": "close", "reason": "completed",
                    "talkEvent": ["type": "session.closed", "payload": ["reason": "completed"]],
                ]),
                seq: nil,
                stateversion: nil))
        }
        #expect(try await terminated.next("relay close") == (preservesConnection
                ? .remoteClose(reason: "completed")
                : .outputCancelled(reason: "user")))
        #expect(!capture.isStarted)
        #expect(await requests.snapshot().map(\.method) == [
            "talk.session.create", "talk.catalog", "talk.session.appendAudio", "talk.session.cancelOutput",
        ])
    }
}
