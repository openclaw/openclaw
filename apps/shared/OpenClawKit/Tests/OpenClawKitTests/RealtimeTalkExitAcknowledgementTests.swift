import Foundation
import OpenClawProtocol
import Testing
@testable import OpenClawKit

@MainActor
struct RealtimeTalkExitAcknowledgementTests {
    @Test(arguments: ["Okay.", "OK!", " okay "])
    func `only a brief acknowledgement qualifies`(_ text: String) {
        #expect(RealtimeTalkExitAcknowledgement.isSuitable(text))
    }

    @Test(arguments: ["Okay, here is the answer", "not okay", "stop talking", "", "OK\nnow"])
    func `ordinary content does not qualify`(_ text: String) {
        #expect(!RealtimeTalkExitAcknowledgement.isSuitable(text))
    }

    @Test func `exit buffers only until suitable final transcript then awaits device drain`() async throws {
        let fixture = try await Fixture()
        defer { fixture.stop() }
        let exit = Task { await fixture.session.finishSpokenExitAcknowledgement() }
        try await fixture.capture.retired.next("input delivery retirement")
        #expect(fixture.session._test_exitAcknowledgementPending)
        #expect(fixture.session._test_enqueueMicrophoneFrame(Data([0, 0])) == nil)
        #expect(fixture.capture.stopCount == 1) // startup only; output engine survives exit
        await fixture.send("audio", ["audioBase64": Data(repeating: 0, count: 960).base64EncodedString()])
        await fixture.send("audioDone")
        #expect(fixture.player.activePlaybackIndexes.isEmpty)
        await fixture.send("transcript", ["role": "assistant", "text": "Okay.", "final": true])
        try await fixture.player.waitForPlayback(0)
        #expect(fixture.session._test_exitAcknowledgementPending)
        fixture.player.complete(0)
        #expect(await exit.value)
        #expect(!fixture.session._test_exitAcknowledgementPending)
        // Late same-turn audio cannot restart the terminal output.
        await fixture.send("audio", ["audioBase64": Data([0, 0]).base64EncodedString()])
        #expect(fixture.player.activePlaybackIndexes.isEmpty)
    }

    @Test func `known current short reply drains without a second request`() async throws {
        let fixture = try await Fixture()
        defer { fixture.stop() }
        await fixture.send("transcript", ["role": "assistant", "text": "Okay.", "final": true])
        await fixture.send("audio", ["audioBase64": Data(repeating: 0, count: 960).base64EncodedString()])
        try await fixture.player.waitForPlayback(0)
        let exit = Task { await fixture.session.finishSpokenExitAcknowledgement() }
        try await fixture.capture.retired.next("exit started")
        #expect(await fixture.session.finishSpokenExitAcknowledgement() == false)
        #expect(fixture.session._test_exitAcknowledgementPending)
        await fixture.send("audioDone")
        #expect(fixture.session._test_exitAcknowledgementPending)
        fixture.player.complete(0)
        #expect(await exit.value)
        #expect(await fixture.requests.snapshot().allSatisfy {
            ["talk.session.create", "talk.catalog"].contains($0.method)
        })
    }

    @Test func `a completed long reply does not reject the next brief acknowledgement`() async throws {
        let playback = ConsumingPlayer()
        let fixture = try await Fixture(playback: playback)
        defer { fixture.stop() }
        await fixture.send("transcript", ["role": "assistant", "text": "An ordinary answer", "final": true])
        for _ in 0..<61 {
            await fixture.send("audio", ["audioBase64": Data(repeating: 0, count: 960).base64EncodedString()])
            _ = try await playback.consumed.next("ordinary frame consumed")
        }
        await fixture.send("audioDone")
        _ = try await fixture.outputStopped.next("ordinary output drained")
        let exit = Task { await fixture.session.finishSpokenExitAcknowledgement() }
        _ = try await fixture.capture.retired.next("exit started after long reply")
        #expect(fixture.session._test_exitAcknowledgementPending)
        await fixture.send("audio", ["audioBase64": Data(repeating: 0, count: 960).base64EncodedString()], turn: "ack")
        await fixture.send("transcript", ["role": "assistant", "text": "Okay.", "final": true], turn: "ack")
        await fixture.send("audioDone", turn: "ack")
        #expect(await exit.value)
    }

    @Test(arguments: [false, true])
    func `only a freshly drained acknowledgement can skip waiting`(stale: Bool) async throws {
        let fixture = try await Fixture(playback: ConsumingPlayer())
        defer { fixture.stop() }
        await fixture.send("transcript", ["role": "assistant", "text": "Okay.", "final": true])
        await fixture.send("audio", ["audioBase64": Data(repeating: 0, count: 960).base64EncodedString()])
        await fixture.send("audioDone")
        _ = try await fixture.outputStopped.next("acknowledgement drained")
        if stale { fixture.session._test_ageDrainedAcknowledgement() }
        let exit = Task { await fixture.session.finishSpokenExitAcknowledgement() }
        _ = try await fixture.capture.retired.next("exit started")
        if stale {
            #expect(fixture.session._test_exitAcknowledgementPending)
            fixture.session._test_expireExitAcknowledgement()
        }
        #expect(await exit.value == !stale)
    }

    @Test(arguments: ["clear", "stop", "deadline", "long", "unrelated", "failure"])
    func `failure cancellation and unrelated output fall back without hanging`(_ kind: String) async throws {
        let fixture = try await Fixture()
        defer { fixture.stop() }
        let exit = Task { await fixture.session.finishSpokenExitAcknowledgement() }
        try await fixture.capture.retired.next("exit started")
        await fixture.send("audio", ["audioBase64": Data(repeating: 0, count: 960).base64EncodedString()])
        switch kind {
        case "clear": await fixture.send("clear")
        case "stop": fixture.session.stop()
        case "deadline": fixture.session._test_expireExitAcknowledgement()
        case "long":
            await fixture.send("audio", ["audioBase64": Data(repeating: 0, count: 60000).base64EncodedString()])
        case "unrelated":
            await fixture.send("transcript", ["role": "assistant", "text": "Here is a lengthy answer.", "final": true])
        default: await fixture.send("error", ["message": "Synthetic failure"])
        }
        #expect(await exit.value == false)
        #expect(!fixture.session._test_exitAcknowledgementPending)
        #expect(fixture.player.activePlaybackIndexes.isEmpty)
    }

    @Test func `stale turn and completion cannot settle owned acknowledgement`() async throws {
        let fixture = try await Fixture()
        defer { fixture.stop() }
        let exit = Task { await fixture.session.finishSpokenExitAcknowledgement() }
        try await fixture.capture.retired.next("exit started")
        await fixture.send("audio", ["audioBase64": Data(repeating: 0, count: 960).base64EncodedString()])
        await fixture.send("transcript", ["role": "assistant", "text": "Okay.", "final": true], turn: "other")
        await fixture.send("audioDone", turn: "other")
        #expect(fixture.session._test_exitAcknowledgementPending)
        #expect(fixture.player.activePlaybackIndexes.isEmpty)
        fixture.session.stop()
        #expect(await exit.value == false)
        await fixture.send("transcript", ["role": "assistant", "text": "Okay.", "final": true])
        #expect(fixture.player.activePlaybackIndexes.isEmpty)
    }

    @Test(arguments: [false, true])
    func `unsupported gateway or capture retains immediate shutdown`(_ serverSupports: Bool) async throws {
        let fixture = try await Fixture(supported: serverSupports, captureSupports: false)
        defer { fixture.stop() }
        #expect(await fixture.session.finishSpokenExitAcknowledgement() == false)
        #expect(!fixture.session._test_exitAcknowledgementPending)
    }

    @Test(arguments: [nil, false] as [Bool?])
    func `default and disabled options cannot drain even if gateway claims support`(enabled: Bool?) async throws {
        let fixture = try await Fixture(enabled: enabled)
        defer { fixture.stop() }
        #expect(await fixture.session.finishSpokenExitAcknowledgement() == false)
        #expect(!fixture.session._test_exitAcknowledgementPending)
        #expect(fixture.capture.retirementCount == 0)
    }

    @MainActor
    private final class ConsumingPlayer: PCMStreamingAudioPlaying {
        let consumed = RealtimeRelayTestSignal<Void>()
        func play(stream: AsyncThrowingStream<Data, Error>, sampleRate: Double) async -> StreamingPlaybackResult {
            do {
                for try await _ in stream {
                    self.consumed.send(())
                }
                return StreamingPlaybackResult(finished: true, interruptedAt: nil)
            } catch {
                return StreamingPlaybackResult(finished: false, interruptedAt: nil)
            }
        }

        func stop() -> Double? {
            nil
        }
    }

    private final class Capture: RealtimeTalkAudioCapturing {
        var suppressesInputDuringOutput = false
        let retired = RealtimeRelayTestSignal<Void>()
        let supported: Bool
        var stopCount = 0
        var retirementCount = 0
        init(supported: Bool) {
            self.supported = supported
        }

        func start(
            targetSampleRate _: Double,
            onAudio _: @escaping @Sendable (RealtimeTalkAudioFrame) -> Void,
            onFailure _: @escaping @MainActor (String) -> Void) throws {}
        func stop() {
            self.stopCount += 1
        }

        func stopInputPreservingPlayback() -> Bool {
            self.retirementCount += 1
            if self.supported {
                self.retired.send(())
            }
            return self.supported
        }
    }

    @MainActor
    private final class Fixture {
        let session: RealtimeTalkRelaySession
        let capture: Capture
        let player = IndexedPCMStreamingAudioPlayer()
        let requests = RealtimeRelayStartupRequestLog()
        let outputStopped = RealtimeRelayTestSignal<Void>()
        private let events = AsyncStream<EventFrame>.makeStream()

        init(
            supported: Bool = true,
            captureSupports: Bool = true,
            enabled: Bool? = true,
            playback: (any PCMStreamingAudioPlaying)? = nil) async throws
        {
            self.capture = Capture(supported: captureSupports)
            let result = TalkSessionCreateResult(
                localexitacknowledgement: supported,
                sessionid: "relay-1",
                mode: AnyCodable("realtime"),
                transport: AnyCodable("gateway-relay"),
                brain: AnyCodable("agent-consult"),
                relaysessionid: "relay-1")
            let data = try JSONEncoder().encode(result)
            let requests = self.requests
            let events = self.events
            let outputStopped = self.outputStopped
            self.session = RealtimeTalkRelaySession(
                transport: .init(subscribeServerEvents: { _ in events.stream }, request: { method, params, _ in
                    await requests.record(method: method, params: params)
                    if method == "talk.session.create" {
                        events.continuation.yield(EventFrame(
                            type: "event",
                            event: "talk.event",
                            payload: AnyCodable([
                                "relaySessionId": "relay-1",
                                "type": "ready",
                            ])))
                        return data
                    }
                    if method == "talk.catalog" {
                        return try realtimeRelayCatalogData()
                    }
                    return Data("{\"ok\":true}".utf8)
                }),
                options: enabled.map {
                    .init(
                        sessionKey: "test",
                        provider: nil,
                        model: nil,
                        voice: nil,
                        spokenExitAcknowledgementEnabled: $0)
                } ?? .init(sessionKey: "test", provider: nil, model: nil, voice: nil),
                audioCapture: self.capture,
                pcmPlayer: playback ?? self.player,
                onStatus: { _ in },
                onSpeakingChanged: { if !$0 { outputStopped.send(()) } })
            try await self.session.start()
        }

        func send(_ type: String, _ extra: [String: Any] = [:], turn: String = "turn-1") async {
            var payload: [String: Any] = [
                "relaySessionId": "relay-1",
                "type": type,
                "talkEvent": ["turnId": turn],
            ]
            payload.merge(extra) { _, new in new }
            await self.session._test_handleGatewayEvent(EventFrame(
                type: "event",
                event: "talk.event",
                payload: AnyCodable(payload)))
        }

        func stop() {
            self.session.stop()
            self.player.shutdown()
            self.events.continuation.finish()
        }
    }
}
