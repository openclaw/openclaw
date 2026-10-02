#if Talk && canImport(ElevenLabsKit) && (os(iOS) || os(macOS))
import Foundation
import OpenClawProtocol
import Testing
@testable import OpenClawKit

/// Exercises the production player, including backend operations and withheld device drains.
final class RealtimeRelayDevice: @unchecked Sendable {
    private let lock = NSLock()
    private var storedFrames: [Data] = []
    private var callbacks: [@Sendable () -> Void] = []
    private var storedStops = 0
    let scheduled = RealtimeRelayTestSignal<Int>(timeoutSeconds: 5)
    let prepared = RealtimeRelayTestSignal<Void>(timeoutSeconds: 5)
    let stopped = RealtimeRelayTestSignal<Int>(timeoutSeconds: 5)
    let prepareGate: DispatchSemaphore?
    let frameGate: DispatchSemaphore?

    init(prepareGate: DispatchSemaphore? = nil, frameGate: DispatchSemaphore? = nil) {
        self.prepareGate = prepareGate
        self.frameGate = frameGate
    }

    var frames: [Data] {
        self.lock.withLock { self.storedFrames }
    }

    var stopCount: Int {
        self.lock.withLock { self.storedStops }
    }

    func prepare(_: Double) {
        self.prepared.send(())
        if let prepareGate { _ = prepareGate.wait(timeout: .now() + 2) }
    }

    func schedule(_ data: Data, _: Double, completion: @escaping @Sendable () -> Void) {
        let count = self.lock.withLock {
            self.storedFrames.append(data)
            self.callbacks.append(completion)
            return self.storedFrames.count
        }
        self.scheduled.send(count)
        if let frameGate { _ = frameGate.wait(timeout: .now() + 2) }
    }

    func stop() {
        let count = self.lock.withLock {
            self.storedStops += 1
            return self.storedStops
        }
        self.stopped.send(count)
    }

    func completion(at index: Int) -> @Sendable () -> Void {
        self.lock.withLock { self.callbacks[index] }
    }

    func waitForFrames(_ count: Int) async throws {
        while self.frames.count < count {
            _ = try await self.scheduled.next("device frames")
        }
    }
}

@MainActor
final class RealtimeRelayProductionFixture {
    let events = AsyncStream<EventFrame>.makeStream()
    let requests = RealtimeRelayStartupRequestLog()
    let capture = TestRealtimeTalkAudioCapture()
    let device: RealtimeRelayDevice
    let player: RealtimePCMStreamingAudioPlayer
    let speaking = RealtimeRelayTestSignal<Bool>(timeoutSeconds: 5)
    let levels = RealtimeRelayTestSignal<Double?>(timeoutSeconds: 5)
    let terminated = RealtimeRelayTestSignal<RealtimeTalkRelayTermination>(timeoutSeconds: 5)
    var session: RealtimeTalkRelaySession!

    init(
        device: RealtimeRelayDevice = RealtimeRelayDevice(),
        supportsBargeIn: Bool = true,
        onSpeaking: @escaping (Bool) -> Void = { _ in }) throws
    {
        self.device = device
        let created = try JSONEncoder().encode(TalkSessionCreateResult(
            sessionid: "relay-1", mode: AnyCodable("realtime"), transport: AnyCodable("gateway-relay"),
            brain: AnyCodable("agent-consult"), relaysessionid: "relay-1"))
        self.player = RealtimePCMStreamingAudioPlayer(
            preparePlayback: device.prepare, scheduleFrame: device.schedule,
            stopPlayback: device.stop, playbackTime: { nil })
        self.session = RealtimeTalkRelaySession(
            transport: RealtimeTalkRelayTransport(
                subscribeServerEvents: { [events] _ in events.stream },
                request: { [requests, events] method, params, _ in
                    await requests.record(method: method, params: params)
                    switch method {
                    case "talk.session.create":
                        events.continuation.yield(EventFrame(
                            type: "event",
                            event: "talk.event",
                            payload: AnyCodable([
                                "relaySessionId": "relay-1",
                                "type": "ready",
                            ])))
                        return created
                    case "talk.catalog": return try realtimeRelayCatalogData(supportsBargeIn: supportsBargeIn)
                    case "talk.session.cancelOutput": return Data(#"{"ok":true,"status":"applied"}"#.utf8)
                    default: return Data(#"{"ok":true}"#.utf8)
                    }
                }),
            options: .init(sessionKey: "main", provider: nil, model: nil, voice: nil),
            audioCapture: self.capture, pcmPlayer: self.player, onStatus: { _ in },
            onTermination: { [terminated] in terminated.send($0) },
            onSpeakingChanged: { [speaking] in speaking.send($0)
                onSpeaking($0)
            },
            onOutputLevel: { [levels] in levels.send($0) })
    }

    func start() async throws {
        try await self.session.start()
    }

    func send(_ event: EventFrame) {
        self.events.continuation.yield(event)
    }

    func close() {
        self.session?.stop()
        self.events.continuation.finish()
    }
}

extension RealtimeTalkRelaySessionPlaybackTests {
    @Test func `production identity switch ignores stale completion and acknowledges marks only after drain`() async throws {
        let f = try RealtimeRelayProductionFixture()
        defer { f.close() }
        try await f.start()
        f.send(outputAudioEvent(turnId: "a", data: Data(repeating: 1, count: 960 * 20)))
        try await f.device.waitForFrames(20)
        f.send(playbackMarkEvent("a-mark"))
        f.send(outputAudioEvent(turnId: "b", data: Data(repeating: 2, count: 960 * 20)))
        f.send(playbackMarkEvent("b-mark"))
        f.send(outputAudioDoneEvent(turnId: "b"))
        try await f.device.waitForFrames(40)
        try await f.requests.waitForRequestCount(3)
        #expect(await f.requests.snapshot().filter { $0.method == "talk.session.acknowledgeMark" }
            .map { $0.params?["markName"]?.stringValue } == ["a-mark"])
        for index in 0..<20 {
            f.device.completion(at: index)()
        }
        #expect(f.session._test_isOutputPlaying())
        for index in 20..<40 {
            f.device.completion(at: index)()
        }
        try await f.requests.waitForRequestCount(4)
        #expect(await f.requests.snapshot().filter { $0.method == "talk.session.acknowledgeMark" }
            .map { $0.params?["markName"]?.stringValue } == ["a-mark", "b-mark"])
        #expect(!f.session._test_isOutputPlaying())
        #expect(f.device.frames == Array(repeating: Data(repeating: 1, count: 960), count: 20)
            + Array(repeating: Data(repeating: 2, count: 960), count: 20))
    }
}

@MainActor
@Suite(.serialized)
struct RealtimeTalkRelaySessionReviewTests {
    @Test func `production overflow stops the device exactly once`() async throws {
        let gate = DispatchSemaphore(value: 0)
        let f = try RealtimeRelayProductionFixture(device: RealtimeRelayDevice(prepareGate: gate))
        defer { gate.signal()
            f.close()
        }
        try await f.start()
        f.send(outputAudioEvent(turnId: "a", data: Data(repeating: 1, count: 960)))
        _ = try await f.device.prepared.next("prepare entered")
        // Preparation must not prevent admission/overflow fencing of a single provider burst.
        f.send(outputAudioEvent(turnId: "a", data: Data(
            repeating: 1,
            count: 960 *
                (RealtimeTalkRelaySession.maxBufferedOutputChunks * 3 + 1))))
        #expect(try await f.terminated.next("overflow") == .outputPlaybackOverflow)
        gate.signal()
        _ = try await f.device.stopped.next("overflow device stop")
        #expect(f.device.stopCount == 1)
        #expect(f.device.frames.isEmpty)
    }

    @Test func `production stop mid-frame promptly fences remaining frames`() async throws {
        let gate = DispatchSemaphore(value: 0)
        let f = try RealtimeRelayProductionFixture(device: RealtimeRelayDevice(frameGate: gate))
        defer { gate.signal()
            f.close()
        }
        try await f.start()
        f.send(outputAudioEvent(turnId: "a", data: Data(repeating: 1, count: 960 * 10)))
        _ = try await f.device.scheduled.next("schedule entered")
        let started = ProcessInfo.processInfo.systemUptime
        f.session.stop()
        #expect(ProcessInfo.processInfo.systemUptime - started < 0.25)
        gate.signal()
        _ = try await f.device.stopped.next("device stop")
        #expect(f.device.frames.count == 1)
        #expect(!f.session._test_isOutputPlaying())
    }
}

extension RealtimeTalkRelaySessionCancellationTests {
    @Test(arguments: ["user", "barge-in"])
    func `production cancellation fences late audio through response and clear`(reason: String) async throws {
        let f = try RealtimeRelayProductionFixture()
        defer { f.close() }
        try await f.start()
        f.send(outputAudioEvent(turnId: "a", data: Data(repeating: 1, count: 960)))
        try await f.device.waitForFrames(1)
        if reason == "barge-in" {
            f.capture.emit(RealtimeTalkAudioFrame(
                data: Data([1, 2]),
                timestampMs: ProcessInfo.processInfo.systemUptime * 1000 + 1000,
                rms: 0.5))
        } else { #expect(f.session.cancelOutput()) }
        try await f.requests.waitForRequestCount(3)
        let cancel = try #require(await f.requests.snapshot().last)
        #expect(cancel.method == "talk.session.cancelOutput")
        #expect(cancel.params?["turnId"]?.stringValue == "a")
        #expect(cancel.params?["reason"]?.stringValue == reason)
        let task = f.session._test_outputCancellationTask()
        await task?.value
        f.send(outputAudioEvent(turnId: "a", data: Data(repeating: 3, count: 960)))
        f.send(outputAudioEvent(turnId: "b", data: Data(repeating: 3, count: 960)))
        f.send(outputClearEvent(turnId: "a"))
        f.send(outputAudioEvent(turnId: "a", data: Data(repeating: 3, count: 960)))
        f.send(outputAudioEvent(turnId: "b", data: Data(repeating: 2, count: 960)))
        try await f.device.waitForFrames(2)
        #expect(f.device.frames == [Data(repeating: 1, count: 960), Data(repeating: 2, count: 960)])
    }
}

extension RealtimeTalkRelaySessionReviewTests {
    @Test func `production barge-in callbacks do not hold the output lock`() async throws {
        var session: RealtimeTalkRelaySession?
        let f = try RealtimeRelayProductionFixture(onSpeaking: { speaking in
            guard !speaking, let session else { return }
            let done = DispatchSemaphore(value: 0)
            DispatchQueue.global(qos: .userInitiated).async {
                _ = session._test_isOutputPlaying()
                done.signal()
            }
            #expect(
                done.wait(timeout: .now() + 0.25) == .success,
                "app callback must leave the audio owner accessible off-main")
        })
        session = f.session
        defer { f.close() }
        try await f.start()
        f.send(outputAudioEvent(turnId: "a", data: Data(repeating: 1, count: 960)))
        try await f.device.waitForFrames(1)
        f.capture.emit(RealtimeTalkAudioFrame(
            data: Data([1, 2]),
            timestampMs: ProcessInfo.processInfo.systemUptime * 1000 + 1000,
            rms: 0.5))
        try await f.requests.waitForRequestCount(3)
    }
}

extension RealtimeTalkRelaySessionInterruptionTests {
    @Test(arguments: [false, true])
    func `production provider owned interruption keeps mic open until clear and explicit stop`(
        suppressesInputDuringOutput: Bool) async throws
    {
        let f = try RealtimeRelayProductionFixture(supportsBargeIn: false)
        f.capture.suppressesInputDuringOutput = suppressesInputDuringOutput
        defer { f.close() }
        try await f.start()
        f.send(outputAudioEvent(turnId: "a", data: Data(repeating: 1, count: 960)))
        try await f.device.waitForFrames(1)
        f.capture.emit(RealtimeTalkAudioFrame(
            data: Data([1, 2]),
            timestampMs: ProcessInfo.processInfo.systemUptime * 1000 + 1000,
            rms: 0.5))
        try await f.requests.waitForRequestCount(3)
        #expect(await f.requests.snapshot().last?.method == "talk.session.appendAudio")
        #expect(!f.session.cancelOutput(reason: "barge-in"))
        #expect(f.device.stopCount == 0)
        f.send(outputClearEvent(turnId: "a", talkEventType: "output.clear"))
        f.send(outputAudioEvent(turnId: "a", data: Data(repeating: 2, count: 960)))
        try await f.device.waitForFrames(2)
        #expect(f.session.cancelOutput(reason: "user"))
        try await f.requests.waitForRequestCount(4)
        #expect(await f.requests.snapshot().last?.method == "talk.session.cancelOutput")
    }
}

extension RealtimeTalkRelaySessionReviewTests {
    @Test func `blocked preparation cannot block synchronous relay controls or start retired audio`() async throws {
        let gate = DispatchSemaphore(value: 0)
        let f = try RealtimeRelayProductionFixture(device: RealtimeRelayDevice(prepareGate: gate))
        defer { gate.signal()
            f.close()
        }
        try await f.start()
        f.send(outputAudioEvent(turnId: "a", data: Data(repeating: 1, count: 960)))
        _ = try await f.device.prepared.next("prepare entered")
        let started = ProcessInfo.processInfo.systemUptime
        f.session.setOutputPaused(true)
        #expect(ProcessInfo.processInfo.systemUptime - started < 0.25)
        gate.signal()
        _ = try await f.device.stopped.next("retired generation stopped")
        #expect(f.device.frames.isEmpty)
    }

    @Test func `output levels restart after a mid-reply gap`() async throws {
        let f = try RealtimeRelayProductionFixture()
        defer { f.close() }
        try await f.start()
        let audio = Data(repeating: 0x20, count: 960 * 10)
        f.send(outputAudioEvent(turnId: "a", data: audio))
        try await f.device.waitForFrames(10)
        var sawLevel = false
        while let level = try await f.levels.next("first envelope") {
            sawLevel = sawLevel || level > 0
        }
        #expect(sawLevel)
        f.send(outputAudioEvent(turnId: "a", data: Data(repeating: 0x20, count: 960 * 10)))
        try await f.device.waitForFrames(20)
        var resumed = false
        do {
            while let level = try await f.levels.next("resumed envelope") {
                if level > 0 { resumed = true
                    break
                }
            }
        } catch {}
        #expect(resumed, "same reply must restart level publishing after silence timeout")
    }

    @Test func `deinit cancels transport event subscription`() async throws {
        let f = try RealtimeRelayProductionFixture()
        try await f.start()
        let ended = RealtimeRelayTestSignal<Void>(timeoutSeconds: 2)
        f.events.continuation.onTermination = { _ in ended.send(()) }
        weak var weakSession = f.session
        f.session = nil
        #expect(weakSession == nil)
        var cancelled = false
        do { _ = try await ended.next("subscription cancellation")
            cancelled = true
        } catch {}
        #expect(cancelled)
        f.events.continuation.finish()
    }
}
#endif
