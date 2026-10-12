#if Talk && canImport(ElevenLabsKit) && (os(iOS) || os(macOS))
import Foundation
import Testing
@testable import OpenClawKit

private struct RealtimePCMPlaybackWaitTimeout: Error {
    let label: String
}

private struct RealtimePCMPlaybackFailure: Error {}

private let realtimePCMPlaybackWaitTimeoutSeconds = 15.0

private final class RealtimePCMPlaybackBackend: @unchecked Sendable {
    private let lock = NSRecursiveLock()
    private struct Waiter {
        let count: Int
        let continuation: CheckedContinuation<Void, any Error>
    }

    private var storedScheduledFrames: [Data] = []
    private var storedCompletions: [@Sendable () -> Void] = []
    private var storedActiveCount = 0
    private var storedMaxActiveCount = 0
    private var completedCallbacks = 0
    private var scheduledWaiters: [UUID: Waiter] = [:]
    private var completionWaiters: [UUID: Waiter] = [:]

    var scheduledFrames: [Data] {
        self.lock.withLock { self.storedScheduledFrames }
    }

    var completions: [@Sendable () -> Void] {
        self.lock.withLock { self.storedCompletions }
    }

    var activeCount: Int {
        self.lock.withLock { self.storedActiveCount }
    }

    var maxActiveCount: Int {
        self.lock.withLock { self.storedMaxActiveCount }
    }

    func prepare(sampleRate _: Double) throws {
        self.lock.withLock {}
    }

    func schedule(
        data: Data,
        sampleRate _: Double,
        completion: @escaping @Sendable () -> Void) throws
    {
        self.lock.withLock {
            self.storedScheduledFrames.append(data)
            self.storedActiveCount += 1
            self.storedMaxActiveCount = max(self.storedMaxActiveCount, self.storedActiveCount)
            self.resumeScheduledWaiters()
            self.storedCompletions.append { [weak self] in
                self?.lock.withLock {
                    self?.storedActiveCount -= 1
                    self?.completedCallbacks += 1
                    self?.resumeCompletionWaiters()
                }
                completion()
            }
        }
    }

    func stop() {
        self.lock.withLock {
            self.storedActiveCount = 0
        }
    }

    func complete(at index: Int = 0) {
        self.lock.withLock {
            self.storedCompletions.remove(at: index)()
        }
    }

    func takeCompletion(at index: Int = 0) -> @Sendable () -> Void {
        self.lock.withLock {
            self.storedCompletions.remove(at: index)
        }
    }

    func waitForScheduledFrames(_ count: Int) async throws {
        if self.lock.withLock({ self.storedScheduledFrames.count >= count }) {
            return
        }
        try await AsyncTimeout.withTimeout(
            seconds: realtimePCMPlaybackWaitTimeoutSeconds,
            onTimeout: { RealtimePCMPlaybackWaitTimeout(label: "scheduled frames \(count)") },
            operation: { try await self.waitForScheduledFramesWithoutDeadline(count) })
    }

    func waitForCompletionCallbacks(_ count: Int) async throws {
        if self.lock.withLock({ self.completedCallbacks >= count }) {
            return
        }
        try await AsyncTimeout.withTimeout(
            seconds: realtimePCMPlaybackWaitTimeoutSeconds,
            onTimeout: { RealtimePCMPlaybackWaitTimeout(label: "completion callbacks \(count)") },
            operation: { try await self.waitForCompletionCallbacksWithoutDeadline(count) })
    }

    private func waitForScheduledFramesWithoutDeadline(_ count: Int) async throws {
        let id = UUID()
        try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in
                self.lock.withLock {
                    if self.storedScheduledFrames.count >= count {
                        continuation.resume()
                    } else {
                        self.scheduledWaiters[id] = Waiter(count: count, continuation: continuation)
                    }
                }
            }
        } onCancel: {
            self.cancelScheduledWaiter(id)
        }
    }

    private func waitForCompletionCallbacksWithoutDeadline(_ count: Int) async throws {
        let id = UUID()
        try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in
                self.lock.withLock {
                    if self.completedCallbacks >= count {
                        continuation.resume()
                    } else {
                        self.completionWaiters[id] = Waiter(count: count, continuation: continuation)
                    }
                }
            }
        } onCancel: {
            self.cancelCompletionWaiter(id)
        }
    }

    private func cancelScheduledWaiter(_ id: UUID) {
        self.lock.withLock {
            self.scheduledWaiters.removeValue(forKey: id)?.continuation.resume(throwing: CancellationError())
        }
    }

    private func cancelCompletionWaiter(_ id: UUID) {
        self.lock.withLock {
            self.completionWaiters.removeValue(forKey: id)?.continuation.resume(throwing: CancellationError())
        }
    }

    private func resumeScheduledWaiters() {
        self.lock.withLock {
            let ready = self.scheduledWaiters.filter { self.storedScheduledFrames.count >= $0.value.count }
            for (id, waiter) in ready {
                self.scheduledWaiters.removeValue(forKey: id)
                waiter.continuation.resume()
            }
        }
    }

    private func resumeCompletionWaiters() {
        self.lock.withLock {
            let ready = self.completionWaiters.filter { self.completedCallbacks >= $0.value.count }
            for (id, waiter) in ready {
                self.completionWaiters.removeValue(forKey: id)
                waiter.continuation.resume()
            }
        }
    }
}

@MainActor
private final class RealtimePCMPlaybackResultProbe {
    private(set) var results: [StreamingPlaybackResult] = []

    func record(_ result: StreamingPlaybackResult) {
        self.results.append(result)
    }
}

private final class RealtimePCMStartCounter: @unchecked Sendable {
    private let lock = NSLock()
    private var storedCount = 0
    var count: Int {
        self.lock.withLock { self.storedCount }
    }

    func increment() {
        self.lock.withLock { self.storedCount += 1 }
    }
}

@MainActor
private func makeRealtimePCMPlayer(
    backend: RealtimePCMPlaybackBackend) -> RealtimePCMStreamingAudioPlayer
{
    RealtimePCMStreamingAudioPlayer(
        preparePlayback: backend.prepare,
        scheduleFrame: backend.schedule,
        stopPlayback: backend.stop,
        playbackTime: { nil })
}

private func waitForPlayback(_ task: Task<Void, Never>, label: String) async throws {
    try await AsyncTimeout.withTimeout(
        seconds: realtimePCMPlaybackWaitTimeoutSeconds,
        onTimeout: { RealtimePCMPlaybackWaitTimeout(label: label) },
        operation: { await task.value })
}

@MainActor
struct RealtimePCMStreamingAudioPlayerTests {
    private let sampleRate = 8000.0
    private var frameBytes: Int {
        Int(self.sampleRate * RealtimePCMStreamingAudioPlayer.frameDurationSeconds) * 2
    }

    @Test func `prepare failure returns unfinished playback`() async {
        let player = RealtimePCMStreamingAudioPlayer(
            preparePlayback: { _ in throw RealtimePCMPlaybackFailure() },
            scheduleFrame: { _, _, _ in },
            stopPlayback: {},
            playbackTime: { nil })
        let (stream, continuation) = AsyncThrowingStream<Data, Error>.makeStream()
        continuation.finish()

        let result = await player.play(stream: stream, sampleRate: self.sampleRate)

        #expect(!result.finished)
        #expect(result.interruptedAt == nil)
    }

    @Test func `schedule failure returns unfinished playback`() async throws {
        let player = RealtimePCMStreamingAudioPlayer(
            preparePlayback: { _ in },
            scheduleFrame: { _, _, _ in throw RealtimePCMPlaybackFailure() },
            stopPlayback: {},
            playbackTime: { nil })
        let (stream, continuation) = AsyncThrowingStream<Data, Error>.makeStream()
        let playback = Task {
            await player.play(stream: stream, sampleRate: self.sampleRate)
        }
        continuation.yield(Data(repeating: 1, count: self.frameBytes))
        continuation.finish()

        let probe = RealtimePCMPlaybackResultProbe()
        let observed = Task {
            await probe.record(playback.value)
        }
        try await waitForPlayback(observed, label: "schedule failure")

        #expect(probe.results.count == 1)
        #expect(probe.results.first?.finished == false)
        #expect(probe.results.first?.interruptedAt == nil)
    }

    @Test func `playback starts after the prebuffer or at end of a short reply`() async throws {
        for (frames, finish, expectedStarts) in [
            (RealtimePCMStreamingAudioPlayer.prebufferFrames - 1, false, 0),
            (RealtimePCMStreamingAudioPlayer.prebufferFrames, false, 1),
            (2, true, 1),
        ] {
            let backend = RealtimePCMPlaybackBackend()
            let starts = RealtimePCMStartCounter()
            let started = RealtimeRelayTestSignal<Void>(timeoutSeconds: 5)
            let player = RealtimePCMStreamingAudioPlayer(
                preparePlayback: backend.prepare,
                scheduleFrame: backend.schedule,
                startPlayback: {
                    starts.increment()
                    started.send(())
                },
                stopPlayback: backend.stop,
                playbackTime: { nil })
            let (stream, continuation) = AsyncThrowingStream<Data, Error>.makeStream()
            let playback = Task { _ = await player.play(stream: stream, sampleRate: self.sampleRate) }
            continuation.yield(Data(repeating: 1, count: self.frameBytes * frames))
            if finish {
                continuation.finish()
            }
            try await backend.waitForScheduledFrames(frames)
            if expectedStarts > 0 {
                // The prebuffer start and the end-of-input start both run after scheduling returns.
                _ = try await started.next("playback start frames=\(frames) finish=\(finish)")
            }
            // Every start decision runs on the backend queue; drain it so no decision is still pending.
            await player._test_waitForBackendOperations()
            #expect(starts.count == expectedStarts, "frames=\(frames) finish=\(finish)")
            _ = player.stop()
            continuation.finish()
            await playback.value
        }
    }

    @Test func `withheld completions cap scheduling and one completion admits one frame`() async throws {
        let cap = RealtimePCMStreamingAudioPlayer.maxScheduledBuffers
        let backend = RealtimePCMPlaybackBackend()
        let player = makeRealtimePCMPlayer(backend: backend)
        let probe = RealtimePCMPlaybackResultProbe()
        let (stream, continuation) = AsyncThrowingStream<Data, Error>.makeStream()
        let playback = Task {
            let result = await player.play(stream: stream, sampleRate: self.sampleRate)
            probe.record(result)
        }

        continuation.yield(Data(repeating: 1, count: self.frameBytes * (cap + 2)))
        continuation.finish()
        try await backend.waitForScheduledFrames(cap)
        #expect(backend.scheduledFrames.count == cap)
        #expect(backend.maxActiveCount == cap)
        #expect(probe.results.isEmpty)

        backend.complete()
        try await backend.waitForScheduledFrames(cap + 1)
        #expect(backend.scheduledFrames.count == cap + 1)
        #expect(backend.maxActiveCount == cap)
        #expect(probe.results.isEmpty)

        backend.complete()
        try await backend.waitForScheduledFrames(cap + 2)
        for _ in 0..<cap {
            backend.complete()
        }
        try await waitForPlayback(playback, label: "cap-plus-two-frame playback")
        #expect(probe.results.count == 1)
        #expect(probe.results.first?.finished == true)
        #expect(probe.results.first?.interruptedAt == nil)
        #expect(backend.scheduledFrames.count == cap + 2)
        #expect(backend.scheduledFrames.allSatisfy { $0.count == self.frameBytes })
    }

    @Test func `playback finishes only after input and every scheduled frame complete`() async throws {
        let backend = RealtimePCMPlaybackBackend()
        let player = makeRealtimePCMPlayer(backend: backend)
        let probe = RealtimePCMPlaybackResultProbe()
        let (stream, continuation) = AsyncThrowingStream<Data, Error>.makeStream()
        let playback = Task {
            let result = await player.play(stream: stream, sampleRate: self.sampleRate)
            probe.record(result)
        }

        continuation.yield(Data(repeating: 1, count: self.frameBytes * 2))
        continuation.finish()
        try await backend.waitForScheduledFrames(2)
        #expect(backend.completions.count == 2)
        #expect(probe.results.isEmpty)

        backend.complete()
        #expect(backend.completions.count == 1)
        #expect(probe.results.isEmpty)
        backend.complete()
        try await waitForPlayback(playback, label: "completed input playback")
        #expect(probe.results.count == 1)
        #expect(probe.results.first?.finished == true)
        #expect(probe.results.first?.interruptedAt == nil)
    }

    @Test func `stop restart ignores stale buffer completions`() async throws {
        let cap = RealtimePCMStreamingAudioPlayer.maxScheduledBuffers
        let backend = RealtimePCMPlaybackBackend()
        let player = makeRealtimePCMPlayer(backend: backend)
        let (firstStream, firstContinuation) = AsyncThrowingStream<Data, Error>.makeStream()
        let firstProbe = RealtimePCMPlaybackResultProbe()
        let firstPlayback = Task {
            let result = await player.play(stream: firstStream, sampleRate: self.sampleRate)
            firstProbe.record(result)
        }
        firstContinuation.yield(Data(repeating: 1, count: self.frameBytes))
        try await backend.waitForScheduledFrames(1)
        let staleCompletion = backend.takeCompletion()

        _ = player.stop()
        try await waitForPlayback(firstPlayback, label: "stopped A playback")
        #expect(firstProbe.results.map(\.finished) == [false])

        let (secondStream, secondContinuation) = AsyncThrowingStream<Data, Error>.makeStream()
        let probe = RealtimePCMPlaybackResultProbe()
        let secondPlayback = Task {
            let result = await player.play(stream: secondStream, sampleRate: self.sampleRate)
            probe.record(result)
        }
        secondContinuation.yield(Data(repeating: 2, count: self.frameBytes * (cap + 2)))
        secondContinuation.finish()
        try await backend.waitForScheduledFrames(cap + 1)
        #expect(backend.activeCount == cap)
        #expect(probe.results.isEmpty)

        staleCompletion()
        try await backend.waitForCompletionCallbacks(1)
        #expect(backend.scheduledFrames.count == cap + 1)
        #expect(backend.completions.count == cap)
        #expect(firstProbe.results.map(\.finished) == [false])
        #expect(probe.results.isEmpty)
        backend.complete()
        try await backend.waitForScheduledFrames(cap + 2)
        #expect(backend.scheduledFrames.count == cap + 2)
        #expect(probe.results.isEmpty)
        backend.complete()
        try await backend.waitForScheduledFrames(cap + 3)
        #expect(backend.scheduledFrames.count == cap + 3)
        #expect(probe.results.isEmpty)
        for _ in 0..<cap {
            backend.complete()
        }
        try await waitForPlayback(secondPlayback, label: "replacement B playback")
        #expect(probe.results.count == 1)
        #expect(probe.results.first?.finished == true)
        #expect(probe.results.first?.interruptedAt == nil)
    }

    @Test func `stop resumes the active playback exactly once`() async throws {
        let backend = RealtimePCMPlaybackBackend()
        let player = makeRealtimePCMPlayer(backend: backend)
        let probe = RealtimePCMPlaybackResultProbe()
        let (stream, continuation) = AsyncThrowingStream<Data, Error>.makeStream()
        let playback = Task {
            let result = await player.play(stream: stream, sampleRate: self.sampleRate)
            probe.record(result)
        }
        continuation.yield(Data(repeating: 1, count: self.frameBytes * 5))
        try await backend.waitForScheduledFrames(3)

        _ = player.stop()
        _ = player.stop()
        try await waitForPlayback(playback, label: "stopped active playback")

        #expect(probe.results.count == 1)
        #expect(probe.results.first?.finished == false)
    }
}

struct RealtimePCMLoudnessTests {
    private static func frame(_ value: Int16) -> Data {
        [Int16](repeating: value, count: 480).withUnsafeBufferPointer { Data(buffer: $0) }
    }

    private static func samples(_ data: Data) -> [Int16] {
        data.withUnsafeBytes { Array($0.bindMemory(to: Int16.self)) }
    }

    @Test func `quiet speech is lifted and loud frames stay under the ceiling`() {
        var loudness = RealtimePCMLoudness()
        #expect(Self.samples(loudness.apply(to: Self.frame(1000))).allSatisfy { $0 == 2820 })
        #expect(Self.samples(loudness.apply(to: Self.frame(20000))).allSatisfy { $0 == 29204 })
        // Recovery is gradual: the next quiet frame starts at the reduced gain and stays under full gain.
        let after = Self.samples(loudness.apply(to: Self.frame(1000)))
        #expect(after.first == 1460)
        #expect((after.last ?? 0) > 1460 && (after.last ?? 0) < 2820)
    }

    @Test func `one loud sample late in a frame holds the whole frame under the ceiling`() {
        var input = [Int16](repeating: 1000, count: 480)
        input[400] = .min
        var loudness = RealtimePCMLoudness()
        let output = Self.samples(loudness.apply(to: input.withUnsafeBufferPointer { Data(buffer: $0) }))
        #expect(output[400] == -29204)
        #expect(output[0] == 891)
    }
}
#endif
