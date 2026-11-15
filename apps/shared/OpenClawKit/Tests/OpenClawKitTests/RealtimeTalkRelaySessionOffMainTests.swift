#if Talk && canImport(ElevenLabsKit) && (os(iOS) || os(macOS))
import Foundation
import OpenClawProtocol
import Testing
@testable import OpenClawKit

/// A fake audio device, not an actor: records the actual scheduleBuffer boundary.
private final class OffMainPlaybackProbe: @unchecked Sendable {
    private let lock = NSLock()
    private var frames: [Data] = []
    private var scheduledOnMain = false
    private let expectedFrames: Int
    /// Signalled from the audio boundary itself, so a blocked main thread can wait on it.
    private let allScheduled = DispatchSemaphore(value: 0)

    init(expectedFrames: Int = .max) {
        self.expectedFrames = expectedFrames
    }

    func schedule(_ data: Data, sampleRate _: Double, completion _: @escaping @Sendable () -> Void) {
        let reachedExpected = self.lock.withLock {
            self.frames.append(data)
            self.scheduledOnMain = self.scheduledOnMain || Thread.isMainThread
            return self.frames.count == self.expectedFrames
        }
        if reachedExpected { self.allScheduled.signal() }
    }

    /// Synchronous on purpose: the caller's thread stays blocked, it never suspends or yields.
    func blockUntilAllScheduled(timeoutSeconds: Double) -> Bool {
        self.allScheduled.wait(timeout: .now() + timeoutSeconds) == .success
    }

    func snapshot() -> (frames: [Data], scheduledOnMain: Bool) {
        self.lock.withLock { (self.frames, self.scheduledOnMain) }
    }
}

@MainActor
struct RealtimeTalkRelaySessionOffMainTests {
    @Test func `buffered startup clear acknowledges its playback mark`() async throws {
        let events = AsyncStream<EventFrame>.makeStream()
        let createBarrier = RealtimeRelayStartupBarrier()
        let acknowledged = RealtimeRelayTestSignal<[String: AnyCodable]>()
        let created = try JSONEncoder().encode(TalkSessionCreateResult(
            sessionid: "relay-1",
            mode: AnyCodable("realtime"),
            transport: AnyCodable("gateway-relay"),
            brain: AnyCodable("agent-consult"),
            relaysessionid: "relay-1"))
        let session = RealtimeTalkRelaySession(
            transport: RealtimeTalkRelayTransport(
                subscribeServerEvents: { _ in events.stream },
                request: { method, params, _ in
                    if method == "talk.session.create" {
                        await createBarrier.suspend()
                        return created
                    }
                    if method == "talk.catalog" {
                        return try realtimeRelayCatalogData()
                    }
                    if method == "talk.session.acknowledgeMark", let params {
                        acknowledged.send(params)
                    }
                    return Data("{\"ok\":true}".utf8)
                }),
            options: .init(sessionKey: "main", provider: nil, model: nil, voice: nil),
            audioCapture: TestRealtimeTalkAudioCapture(),
            pcmPlayer: DrainingPCMStreamingAudioPlayer(),
            onStatus: { _ in },
            onSpeakingChanged: { _ in })
        defer { session.stop()
            events.continuation.finish()
        }
        let starting = Task { try await session.start() }
        try await createBarrier.waitUntilEntered()
        // Drive the same main startup consumer deterministically while creation is suspended.
        await session._test_handleGatewayEvent(outputAudioEvent(turnId: "startup", data: Data([1, 1])))
        await session._test_handleGatewayEvent(EventFrame(
            type: "event", event: "talk.event",
            payload: AnyCodable([
                "relaySessionId": "relay-1", "type": "mark", "markName": "startup-mark",
            ])))
        await session._test_handleGatewayEvent(outputClearEvent(turnId: "startup"))
        await session._test_handleGatewayEvent(EventFrame(
            type: "event", event: "talk.event",
            payload: AnyCodable(["relaySessionId": "relay-1", "type": "ready"])))
        await createBarrier.release()
        try await starting.value
        let params = try await AsyncTimeout.withTimeout(
            seconds: 2,
            onTimeout: { RealtimeRelayTestTimeout(operation: "startup mark acknowledgment") },
            operation: { try await acknowledged.next("startup mark acknowledgment") })
        #expect(params["sessionId"]?.stringValue == "relay-1")
        #expect(params["markName"]?.stringValue == "startup-mark")
    }

    @Test func `installed relay identity does not open startup routing`() {
        let notifications = AsyncStream<Void>.makeStream()
        let output = RealtimeTalkOutput(
            player: DrainingPCMStreamingAudioPlayer(), transport: unusedRealtimeRelayTransport(),
            notification: notifications.continuation)
        output.withLock {
            $0.resetRouting(lifecycleGeneration: 1)
            $0.relaySessionId = "relay-1"
        }
        let event = outputAudioEvent(turnId: "startup", data: Data([1, 1]))
        let buffered = output.route(event, lifecycleGeneration: 1)
        #expect(!buffered.handled && buffered.startup)
        output.withLock { $0.startupRoutingReady = true }
        let behindBuffer = output.route(event, lifecycleGeneration: 1)
        #expect(!behindBuffer.handled && behindBuffer.startup)
        output.withLock {
            $0.mainEventHandled(startup: true, lifecycleGeneration: 1)
            $0.mainEventHandled(startup: true, lifecycleGeneration: 1)
        }
        let live = output.route(event, lifecycleGeneration: 1)
        #expect(live.handled && !live.startup)
        output.withLock { $0.stopOutputPlayback() }
    }

    @Test func `new reply reaches audio device while main actor is stalled`() async throws {
        let events = AsyncStream<EventFrame>.makeStream()
        let created = try JSONEncoder().encode(TalkSessionCreateResult(
            sessionid: "relay-1",
            mode: AnyCodable("realtime"),
            transport: AnyCodable("gateway-relay"),
            brain: AnyCodable("agent-consult"),
            relaysessionid: "relay-1"))
        let probe = OffMainPlaybackProbe(expectedFrames: 81)
        let player = RealtimePCMStreamingAudioPlayer(
            preparePlayback: { _ in },
            scheduleFrame: probe.schedule,
            stopPlayback: {},
            playbackTime: { nil })
        let session = RealtimeTalkRelaySession(
            transport: RealtimeTalkRelayTransport(
                subscribeServerEvents: { _ in events.stream },
                request: { method, _, _ in
                    if method == "talk.session.create" {
                        events.continuation.yield(EventFrame(
                            type: "event",
                            event: "talk.event",
                            payload: AnyCodable(["relaySessionId": "relay-1", "type": "ready"])))
                        return created
                    }
                    if method == "talk.catalog" {
                        return try realtimeRelayCatalogData()
                    }
                    return Data("{\"ok\":true}".utf8)
                }),
            options: .init(sessionKey: "main", provider: nil, model: nil, voice: nil),
            audioCapture: TestRealtimeTalkAudioCapture(),
            pcmPlayer: player,
            onStatus: { _ in },
            onSpeakingChanged: { _ in })
        defer { session.stop()
            events.continuation.finish()
        }
        try await session.start()
        let stallStarted = RealtimeRelayTestSignal<Void>()
        let producer = Task.detached {
            _ = try await stallStarted.next("main actor stall")
            for index in 0..<80 {
                events.continuation.yield(outputAudioEvent(
                    turnId: "brand-new-turn", data: Data(repeating: UInt8(index + 1), count: 960)))
            }
            events.continuation.yield(outputAudioEvent(turnId: "brand-new-turn", data: Data([81, 81])))
            events.continuation.yield(outputAudioDoneEvent(turnId: "brand-new-turn"))
        }
        stallStarted.send(())
        // Block the main thread until the audio boundary reports every frame, bounded so a
        // main-dependent implementation fails instead of hanging. Nothing here yields the main actor.
        let scheduledDuringStall = probe.blockUntilAllScheduled(timeoutSeconds: 10)
        // Snapshot BEFORE releasing the main actor: after-the-stall delivery cannot pass.
        let duringStall = probe.snapshot()
        #expect(scheduledDuringStall, "scheduling must complete while the main actor is blocked")
        #expect(
            duringStall.frames.count == 81,
            "all frames, including the first and partial tail, must schedule DURING stall")
        #expect(duringStall.frames.first == Data(repeating: 1, count: 960), "the start of the reply must survive")
        #expect(!duringStall.scheduledOnMain, "scheduleBuffer must never require main")
        try await producer.value
    }
}
#endif
