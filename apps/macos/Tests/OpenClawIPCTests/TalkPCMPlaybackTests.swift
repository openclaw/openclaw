import Foundation
import OpenClawKit
import Testing
@testable import OpenClaw

private struct TalkPCMPlaybackTimeout: Error {}

@MainActor
private final class TalkPCMBackend {
    private(set) var frames: [Data] = []
    private(set) var stops = 0
    private(set) var levels: [Double?] = []
    let scheduled = AsyncStream<Void>.makeStream()
    let drained = AsyncStream<@Sendable () -> Void>.makeStream()

    func makePlayback(consumeFrames: Bool = true) -> TalkPCMPlayback {
        let player = RealtimePCMStreamingAudioPlayer(
            preparePlayback: { _ in },
            scheduleFrame: { [self] data, _, consumed in
                self.frames.append(data)
                self.scheduled.continuation.yield(())
                if consumeFrames { consumed() }
            },
            scheduleDrain: { [self] _, completion in self.drained.continuation.yield(completion) },
            stopPlayback: { [self] in self.stops += 1 },
            playbackTime: { nil })
        return TalkPCMPlayback(player: player, onLevel: { [self] in self.levels.append($0) })
    }
}

private func nextPCMEvent<Value: Sendable>(_ stream: AsyncStream<Value>) async throws -> Value {
    try await AsyncTimeout.withTimeout(
        seconds: 10,
        onTimeout: { TalkPCMPlaybackTimeout() },
        operation: {
            for await event in stream {
                return event
            }
            throw TalkPCMPlaybackTimeout()
        })
}

@MainActor
struct TalkPCMPlaybackTests {
    @Test(arguments: [false, true], [false, true])
    func `stop and caller cancellation retire the upstream stream and meter`(
        cancelCaller: Bool,
        saturated: Bool) async throws
    {
        let backend = TalkPCMBackend()
        let player = backend.makePlayback(consumeFrames: !saturated)
        let source = AsyncThrowingStream<Data, Error>.makeStream()
        let terminated = AsyncStream<Void>.makeStream()
        source.continuation.onTermination = { _ in terminated.continuation.yield(()) }
        let playback = Task { await player.play(stream: source.stream, sampleRate: 24000) }
        defer { player.stop()
            source.continuation.finish()
        }
        // The fourth frame suspends on the three-slot budget instead of
        // AsyncStream.next(), exercising cancellation at both suspension points.
        let scheduledFrameCount = saturated ? 3 : 1
        source.continuation.yield(Data(repeating: 1, count: 960 * (saturated ? 4 : 1)))
        for _ in 0..<scheduledFrameCount {
            _ = try await nextPCMEvent(backend.scheduled.stream)
        }
        #expect(backend.frames.count == scheduledFrameCount)

        if cancelCaller { playback.cancel() } else { player.stop() }
        _ = try await nextPCMEvent(terminated.stream)
        let result = await playback.value
        #expect(!result.finished)
        #expect(backend.levels.last == .some(nil))
        if case .terminated = source.continuation.yield(Data(repeating: 2, count: 960)) {} else {
            Issue.record("retired producer still accepts late audio")
        }
        #expect(backend.frames == Array(repeating: Data(repeating: 1, count: 960), count: scheduledFrameCount))
    }

    @Test(arguments: [8000.0, 24000.0, 44100.0, 48000.0])
    func `short classic PCM waits for audible drain and preserves its trailing samples`(
        sampleRate: Double) async throws
    {
        let backend = TalkPCMBackend()
        let player = backend.makePlayback()
        let source = AsyncThrowingStream<Data, Error>.makeStream()
        let resultSignal = AsyncStream<StreamingPlaybackResult>.makeStream()
        let playback = Task {
            _ = await resultSignal.continuation.yield(player.play(stream: source.stream, sampleRate: sampleRate))
        }
        defer { player.stop()
            source.continuation.finish()
        }
        let audio = Data([0x34, 0x12, 0x78, 0x56])
        source.continuation.yield(audio)
        source.continuation.finish()
        let drain = try await nextPCMEvent(backend.drained.stream)
        let frame = try #require(backend.frames.first)
        #expect(frame.prefix(audio.count) == audio)
        #expect(frame.count == Int((sampleRate * 0.02).rounded()) * 2)
        #expect(frame.dropFirst(audio.count).allSatisfy { $0 == 0 })
        let stopsBeforeDrain = backend.stops
        drain()
        let result = try await nextPCMEvent(resultSignal.stream)
        await playback.value
        #expect(result.finished)
        #expect(backend.stops == stopsBeforeDrain + 1)
        #expect(backend.levels.last == .some(nil))
    }

    @Test func `a retired drain cannot finish or clear the successor playback`() async throws {
        let backend = TalkPCMBackend()
        let player = backend.makePlayback()
        let first = AsyncThrowingStream<Data, Error>.makeStream()
        let firstPlayback = Task { await player.play(stream: first.stream, sampleRate: 24000) }
        first.continuation.yield(Data(repeating: 1, count: 960))
        first.continuation.finish()
        let oldDrain = try await nextPCMEvent(backend.drained.stream)
        let second = AsyncThrowingStream<Data, Error>.makeStream()
        let secondPlayback = Task { await player.play(stream: second.stream, sampleRate: 24000) }
        defer { player.stop()
            second.continuation.finish()
        }
        second.continuation.yield(Data(repeating: 2, count: 960))
        second.continuation.finish()
        let newDrain = try await nextPCMEvent(backend.drained.stream)
        #expect(await firstPlayback.value.finished == false)
        let stopsBeforeOldDrain = backend.stops
        let levelsBeforeOldDrain = backend.levels.count
        oldDrain()
        // The new drain is also scheduled through MainActor, fencing observation
        // after the old completion's callback has been processed.
        newDrain()
        #expect(await secondPlayback.value.finished)
        #expect(backend.stops == stopsBeforeOldDrain + 1)
        #expect(backend.levels.count == levelsBeforeOldDrain + 1)
        #expect(backend.frames == [Data(repeating: 1, count: 960), Data(repeating: 2, count: 960)])
        #expect(backend.levels.last == .some(nil))
    }
}
