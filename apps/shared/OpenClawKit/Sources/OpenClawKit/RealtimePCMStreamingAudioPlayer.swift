#if Talk && canImport(ElevenLabsKit) && (os(iOS) || os(macOS))
import AVFAudio
import Foundation

@MainActor
public final class RealtimePCMStreamingAudioPlayer: PCMStreamingAudioPlaying {
    static let frameDurationSeconds = 0.020
    static let maxScheduledBuffers = 3

    public typealias Completion = @Sendable () -> Void
    private let preparePlayback: (Double) throws -> Void
    private let scheduleFrame: (Data, Double, @escaping Completion) throws -> Void
    private let scheduleDrain: (Double, @escaping Completion) throws -> Void
    private let stopPlayback: () -> Void
    private let playbackTime: () -> Double?

    private var generation: UInt64 = 0
    private var nextBufferID: UInt64 = 0
    private var scheduledBufferIDs: Set<UInt64> = []
    private var slotWaiters: [CheckedContinuation<Bool, Never>] = []
    private var playbackContinuation: CheckedContinuation<StreamingPlaybackResult, Never>?
    private var inputTask: Task<Void, Never>?

    public convenience init() {
        let engine = AVAudioEngine()
        let node = AVAudioPlayerNode()
        engine.attach(node)
        var format: AVAudioFormat?
        func schedule(
            _ data: Data,
            callbackType: AVAudioPlayerNodeCompletionCallbackType,
            completion: @escaping Completion) throws
        {
            guard let format else {
                throw NSError(domain: "RealtimePCMStreamingAudioPlayer", code: 2)
            }
            let frames = AVAudioFrameCount(data.count / MemoryLayout<Int16>.size)
            guard let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: frames),
                  let channel = buffer.int16ChannelData?[0]
            else {
                throw NSError(domain: "RealtimePCMStreamingAudioPlayer", code: 3)
            }
            buffer.frameLength = frames
            data.copyBytes(
                to: UnsafeMutableRawBufferPointer(
                    start: channel,
                    count: data.count))
            node.scheduleBuffer(
                buffer,
                completionCallbackType: callbackType)
            { _ in completion() }
        }
        self.init(
            preparePlayback: { sampleRate in
                node.stop()
                engine.stop()
                engine.disconnectNodeOutput(node)
                guard let nextFormat = AVAudioFormat(
                    commonFormat: .pcmFormatInt16,
                    sampleRate: sampleRate,
                    channels: 1,
                    interleaved: false)
                else {
                    throw NSError(domain: "RealtimePCMStreamingAudioPlayer", code: 1)
                }
                format = nextFormat
                engine.connect(node, to: engine.mainMixerNode, format: nextFormat)
                engine.prepare()
                try engine.start()
                node.play()
            },
            scheduleFrame: { data, _, completion in
                try schedule(data, callbackType: .dataConsumed, completion: completion)
            },
            scheduleDrain: { _, completion in
                try schedule(
                    Data(repeating: 0, count: MemoryLayout<Int16>.size),
                    callbackType: .dataPlayedBack,
                    completion: completion)
            },
            stopPlayback: {
                node.stop()
                engine.stop()
            },
            playbackTime: {
                guard let renderTime = node.lastRenderTime,
                      let playerTime = node.playerTime(forNodeTime: renderTime)
                else { return nil }
                return Double(playerTime.sampleTime) / playerTime.sampleRate
            })
    }

    /// A duplex audio owner can supply playback on its capture engine. Ending a
    /// response must then stop only its player node, not the shared I/O engine.
    /// Frame completion releases consumed data; drain completion must acknowledge
    /// audible playback of all previously scheduled frames.
    public init(
        preparePlayback: @escaping (Double) throws -> Void,
        scheduleFrame: @escaping (Data, Double, @escaping Completion) throws -> Void,
        scheduleDrain: @escaping (Double, @escaping Completion) throws -> Void,
        stopPlayback: @escaping () -> Void,
        playbackTime: @escaping () -> Double?)
    {
        self.preparePlayback = preparePlayback
        self.scheduleFrame = scheduleFrame
        self.scheduleDrain = scheduleDrain
        self.stopPlayback = stopPlayback
        self.playbackTime = playbackTime
    }

    public func play(
        stream: AsyncThrowingStream<Data, Error>,
        sampleRate: Double) async -> StreamingPlaybackResult
    {
        _ = self.stop()
        guard sampleRate > 0 else {
            return StreamingPlaybackResult(finished: false, interruptedAt: nil)
        }
        self.generation &+= 1
        let generation = self.generation
        do {
            try self.preparePlayback(sampleRate)
        } catch {
            return StreamingPlaybackResult(finished: false, interruptedAt: nil)
        }
        return await withCheckedContinuation { continuation in
            self.playbackContinuation = continuation
            self.inputTask = Task { @MainActor [weak self] in
                await self?.consume(stream: stream, sampleRate: sampleRate, generation: generation)
            }
        }
    }

    public func stop() -> Double? {
        let interruptedAt = self.playbackTime()
        self.generation &+= 1
        self.inputTask?.cancel()
        self.inputTask = nil
        self.scheduledBufferIDs.removeAll()
        let waiters = self.slotWaiters
        self.slotWaiters.removeAll()
        for waiter in waiters {
            waiter.resume(returning: false)
        }
        let continuation = self.playbackContinuation
        self.playbackContinuation = nil
        self.stopPlayback()
        continuation?.resume(returning: StreamingPlaybackResult(
            finished: false,
            interruptedAt: interruptedAt))
        return interruptedAt
    }

    private func consume(
        stream: AsyncThrowingStream<Data, Error>,
        sampleRate: Double,
        generation: UInt64) async
    {
        let frameBytes = max(
            MemoryLayout<Int16>.size,
            Int((sampleRate * Self.frameDurationSeconds).rounded()) * MemoryLayout<Int16>.size)
        var pending = Data()
        var hasAudio = false
        do {
            for try await chunk in stream {
                try Task.checkCancellation()
                hasAudio = hasAudio || !chunk.isEmpty
                pending.append(chunk)
                while pending.count >= frameBytes {
                    let frame = Data(pending.prefix(frameBytes))
                    pending.removeFirst(frameBytes)
                    guard await self.schedule(
                        frame: frame,
                        sampleRate: sampleRate,
                        generation: generation)
                    else { return }
                }
            }
            if !pending.isEmpty {
                pending.append(Data(repeating: 0, count: frameBytes - pending.count))
                guard await self.schedule(
                    frame: pending,
                    sampleRate: sampleRate,
                    generation: generation)
                else { return }
            }
            guard self.generation == generation else { return }
            guard hasAudio else {
                self.finish(generation: generation, finished: true)
                return
            }
            // Refill on consumption, but acknowledge completion only after a
            // terminal silent sample and all preceding audio reach the device.
            try self.scheduleDrain(sampleRate) { [weak self] in
                Task { @MainActor in
                    self?.finish(generation: generation, finished: true)
                }
            }
        } catch {
            self.finish(generation: generation, finished: false)
        }
    }

    private func schedule(frame: Data, sampleRate: Double, generation: UInt64) async -> Bool {
        while self.generation == generation,
              self.scheduledBufferIDs.count >= Self.maxScheduledBuffers
        {
            let admitted = await withCheckedContinuation { continuation in
                self.slotWaiters.append(continuation)
            }
            guard admitted else { return false }
        }
        guard self.generation == generation, !Task.isCancelled else { return false }
        self.nextBufferID &+= 1
        let bufferID = self.nextBufferID
        self.scheduledBufferIDs.insert(bufferID)
        do {
            try self.scheduleFrame(frame, sampleRate) { [weak self] in
                Task { @MainActor in
                    self?.completed(bufferID: bufferID, generation: generation)
                }
            }
            return true
        } catch {
            self.scheduledBufferIDs.remove(bufferID)
            self.finish(generation: generation, finished: false)
            return false
        }
    }

    private func completed(bufferID: UInt64, generation: UInt64) {
        guard self.generation == generation,
              self.scheduledBufferIDs.remove(bufferID) != nil
        else { return }
        if !self.slotWaiters.isEmpty {
            self.slotWaiters.removeFirst().resume(returning: true)
        }
    }

    private func finish(generation: UInt64, finished: Bool) {
        guard self.generation == generation else { return }
        let interruptedAt = finished ? nil : self.playbackTime()
        self.generation &+= 1
        self.scheduledBufferIDs.removeAll()
        let waiters = self.slotWaiters
        self.slotWaiters.removeAll()
        for waiter in waiters {
            waiter.resume(returning: false)
        }
        self.inputTask = nil
        let continuation = self.playbackContinuation
        self.playbackContinuation = nil
        self.stopPlayback()
        continuation?.resume(returning: StreamingPlaybackResult(
            finished: finished,
            interruptedAt: interruptedAt))
    }
}
#endif
