#if Talk && canImport(ElevenLabsKit) && (os(iOS) || os(macOS))
import AVFAudio
import Foundation

/// The lock guards playback/generation state; backend closures run on backendQueue without it.
/// Completion callbacks are queued, including callbacks invoked synchronously by node.stop.
public final nonisolated class RealtimePCMStreamingAudioPlayer: PCMStreamingAudioPlaying,
    @unchecked Sendable
{
    private let lock = NSLock()
    /// Backend operations never hold the state lock or block a relay control. Ordering on this
    /// queue ensures a retired generation's stop precedes preparation of its replacement.
    private let backendQueue = DispatchQueue(label: "ai.openclaw.realtime-playback", qos: .userInitiated)
    static let frameDurationSeconds = 0.020
    /// Bound scheduled audio to the relay's 60 s reply limit; completions refill off-main.
    static let maxScheduledBuffers = 3000

    typealias Completion = @Sendable () -> Void
    private let preparePlayback: (Double) throws -> Void
    private let scheduleFrame: (Data, Double, @escaping Completion) throws -> Void
    private let startPlayback: () -> Void
    /// Frames queued before the node starts: 300 ms of cushion so the first seconds of a reply,
    /// which arrive while the UI is busy, don't underrun.
    static let prebufferFrames = 15
    private var playbackStarted = false
    private let stopPlayback: () -> Void
    private let playbackTime: () -> Double?

    private var generation: UInt64 = 0
    private var nextBufferID: UInt64 = 0
    private var scheduledBufferIDs: Set<UInt64> = []
    private var slotWaiters: [CheckedContinuation<Bool, Never>] = []
    private var playbackContinuation: AsyncStream<StreamingPlaybackResult>.Continuation?
    private var inputTask: Task<Void, Never>?
    private var inputFinished = false

    public convenience init() {
        self.init(engine: AVAudioEngine(), ownsEngine: true)
    }

    /// Plays through an engine whose I/O another owner runs, such as a voice-processing capture
    /// engine: echo cancellation only removes output rendered by its own I/O unit. That owner
    /// starts and restarts the engine; playback only connects and stops its own node.
    public convenience init(sharedEngine engine: AVAudioEngine) {
        self.init(engine: engine, ownsEngine: false)
    }

    private convenience init(engine: AVAudioEngine, ownsEngine: Bool) {
        let node = AVAudioPlayerNode()
        engine.attach(node)
        // Relay audio arrives as PCM16, but connecting an Int16 player node raises on iOS (on owned
        // and shared voice-processing engines alike), so those render Float32 and convert frames.
        #if os(iOS)
        let commonFormat = AVAudioCommonFormat.pcmFormatFloat32
        #else
        let commonFormat: AVAudioCommonFormat = ownsEngine ? .pcmFormatInt16 : .pcmFormatFloat32
        #endif
        var format: AVAudioFormat?
        self.init(
            preparePlayback: { sampleRate in
                node.stop()
                if ownsEngine { engine.stop() }
                engine.disconnectNodeOutput(node)
                guard let nextFormat = AVAudioFormat(
                    commonFormat: commonFormat,
                    sampleRate: sampleRate,
                    channels: 1,
                    interleaved: false)
                else {
                    throw NSError(domain: "RealtimePCMStreamingAudioPlayer", code: 1)
                }
                format = nextFormat
                engine.connect(node, to: engine.mainMixerNode, format: nextFormat)
                // A shared engine may be mid-reconfiguration here; its owner restarts it and then
                // resumes this node through resumePlaybackAfterEngineRestart().
                if ownsEngine {
                    engine.prepare()
                    try engine.start()
                }
                // Preserve the device-startup cushion before the first audible frames.
                let padFrames = AVAudioFrameCount(sampleRate * 0.3)
                if let pad = AVAudioPCMBuffer(pcmFormat: nextFormat, frameCapacity: padFrames) {
                    pad.frameLength = padFrames
                    pad.int16ChannelData?[0].update(repeating: 0, count: Int(padFrames))
                    pad.floatChannelData?[0].update(repeating: 0, count: Int(padFrames))
                    node.scheduleBuffer(pad)
                }
            },
            scheduleFrame: { data, _, completion in
                guard let format else {
                    throw NSError(domain: "RealtimePCMStreamingAudioPlayer", code: 2)
                }
                let frames = AVAudioFrameCount(data.count / MemoryLayout<Int16>.size)
                guard let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: frames) else {
                    throw NSError(domain: "RealtimePCMStreamingAudioPlayer", code: 3)
                }
                buffer.frameLength = frames
                if let channel = buffer.int16ChannelData?[0] {
                    data.copyBytes(
                        to: UnsafeMutableRawBufferPointer(
                            start: channel,
                            count: data.count))
                } else if let channel = buffer.floatChannelData?[0] {
                    data.withUnsafeBytes { raw in
                        for index in 0..<Int(frames) {
                            let sample = Int16(littleEndian: raw.loadUnaligned(
                                fromByteOffset: index * MemoryLayout<Int16>.size,
                                as: Int16.self))
                            channel[index] = Float(sample) / 32768
                        }
                    }
                } else {
                    throw NSError(domain: "RealtimePCMStreamingAudioPlayer", code: 3)
                }
                node.scheduleBuffer(
                    buffer,
                    completionCallbackType: .dataPlayedBack)
                { _ in completion() }
            },
            // A shared engine can be stopped by its owner for a reconfiguration; starting a node
            // on a stopped engine raises, so resumePlaybackAfterEngineRestart() starts it later.
            startPlayback: { if engine.isRunning { node.play() } },
            stopPlayback: {
                node.stop()
                if ownsEngine { engine.stop() }
            },
            playbackTime: {
                guard let renderTime = node.lastRenderTime,
                      let playerTime = node.playerTime(forNodeTime: renderTime)
                else { return nil }
                return Double(playerTime.sampleTime) / playerTime.sampleRate
            })
    }

    init(
        preparePlayback: @escaping (Double) throws -> Void,
        scheduleFrame: @escaping (Data, Double, @escaping Completion) throws -> Void,
        startPlayback: @escaping () -> Void = {},
        stopPlayback: @escaping () -> Void,
        playbackTime: @escaping () -> Double?)
    {
        self.preparePlayback = preparePlayback
        self.scheduleFrame = scheduleFrame
        self.startPlayback = startPlayback
        self.stopPlayback = stopPlayback
        self.playbackTime = playbackTime
    }

    public func play(
        stream: AsyncThrowingStream<Data, Error>,
        sampleRate: Double) async -> StreamingPlaybackResult
    {
        await self.beginPlayback(stream: stream, sampleRate: sampleRate).value
    }

    /// Register synchronously so relay controls can retire playback before its task runs.
    func beginPlayback(
        stream: AsyncThrowingStream<Data, Error>,
        sampleRate: Double) -> Task<StreamingPlaybackResult, Never>
    {
        self.lock.withLock {
            self.finish(StreamingPlaybackResult(finished: false, interruptedAt: nil), cancelInput: true)
            let results = AsyncStream<StreamingPlaybackResult>.makeStream(bufferingPolicy: .bufferingOldest(1))
            let resultTask = Task.detached(priority: .high) {
                for await result in results.stream {
                    return result
                }
                return StreamingPlaybackResult(finished: false, interruptedAt: nil)
            }
            guard sampleRate > 0 else {
                results.continuation.finish()
                return resultTask
            }
            self.generation &+= 1
            let generation = self.generation
            self.playbackStarted = false
            self.playbackContinuation = results.continuation
            // Registration and queue submission are atomic with stop; engine work is not.
            self.backendQueue.async { [weak self] in
                guard let self, self.isCurrent(generation) else { return }
                do {
                    try self.preparePlayback(sampleRate)
                    self.lock.withLock {
                        guard self.generation == generation else { return }
                        self.inputTask = Task.detached(priority: .high) { [weak self] in
                            await self?.consume(stream: stream, sampleRate: sampleRate, generation: generation)
                        }
                    }
                } catch {
                    self.lock.withLock { self.finish(generation: generation, finished: false) }
                }
            }
            return resultTask
        }
    }

    public func stop() -> Double? {
        // AVAudioPlayerNode's render-time query is thread-safe and does not wait for preparation.
        let interruptedAt = self.playbackTime()
        self.lock.withLock {
            self.finish(StreamingPlaybackResult(finished: false, interruptedAt: interruptedAt), cancelInput: true)
        }
        return interruptedAt
    }

    /// Called by a shared engine's owner after it restarts the engine, which stops attached nodes.
    public func resumePlaybackAfterEngineRestart() {
        self.backendQueue.async { [weak self] in
            guard let self else { return }
            let resume = self.lock.withLock { self.playbackStarted && self.playbackContinuation != nil }
            if resume { self.startPlayback() }
        }
    }

    private func isCurrent(_ generation: UInt64) -> Bool {
        self.lock.withLock { self.generation == generation }
    }

    private func consume(
        stream: AsyncThrowingStream<Data, Error>, sampleRate: Double, generation: UInt64) async
    {
        let frameBytes = max(
            MemoryLayout<Int16>.size,
            Int((sampleRate * Self.frameDurationSeconds).rounded()) * MemoryLayout<Int16>.size)
        var pending = Data()
        do {
            for try await chunk in stream {
                try Task.checkCancellation()
                pending.append(chunk)
                while pending.count >= frameBytes {
                    let frame = Data(pending.prefix(frameBytes))
                    pending.removeFirst(frameBytes)
                    guard await self.schedule(frame: frame, sampleRate: sampleRate, generation: generation)
                    else { return }
                }
            }
            if !pending.isEmpty {
                pending.append(Data(repeating: 0, count: frameBytes - pending.count))
                guard await self.schedule(frame: pending, sampleRate: sampleRate, generation: generation)
                else { return }
            }
            self.backendQueue.async { [weak self] in
                guard let self, self.isCurrent(generation) else { return }
                self.startPlaybackOnce(generation: generation)
                self.lock.withLock {
                    guard self.generation == generation else { return }
                    self.inputFinished = true
                    self.finishIfDrained(generation: generation)
                }
            }
        } catch {
            let interruptedAt = self.playbackTime()
            self.lock.withLock {
                guard self.generation == generation else { return }
                self.finish(StreamingPlaybackResult(finished: false, interruptedAt: interruptedAt))
            }
        }
    }

    private func schedule(frame: Data, sampleRate: Double, generation: UInt64) async -> Bool {
        let admitted = await withCheckedContinuation { continuation in
            self.lock.withLock {
                guard self.generation == generation, !Task.isCancelled else {
                    continuation.resume(returning: false)
                    return
                }
                if self.scheduledBufferIDs.count >= Self.maxScheduledBuffers {
                    self.slotWaiters.append(continuation)
                } else { continuation.resume(returning: true) }
            }
        }
        guard admitted else { return false }
        return await withCheckedContinuation { continuation in
            self.backendQueue.async { [weak self] in
                guard let self else { continuation.resume(returning: false)
                    return
                }
                let bufferID: UInt64? = self.lock.withLock {
                    guard self.generation == generation else { return nil }
                    self.nextBufferID &+= 1
                    self.scheduledBufferIDs.insert(self.nextBufferID)
                    return self.nextBufferID
                }
                guard let bufferID else { continuation.resume(returning: false)
                    return
                }
                do {
                    try self.scheduleFrame(frame, sampleRate) { [weak self] in
                        guard let self else { return }
                        self.backendQueue.async { [weak self] in
                            self?.lock.withLock { self?.completed(bufferID: bufferID, generation: generation) }
                        }
                    }
                    let shouldStart = self.lock.withLock {
                        self.generation == generation && self.scheduledBufferIDs.count >= Self.prebufferFrames
                    }
                    if shouldStart { self.startPlaybackOnce(generation: generation) }
                    continuation.resume(returning: self.isCurrent(generation))
                } catch {
                    self.lock.withLock { self.finish(generation: generation, finished: false) }
                    continuation.resume(returning: false)
                }
            }
        }
    }

    /// Called only on backendQueue. A concurrently retired generation is stopped next on that queue.
    private func startPlaybackOnce(generation: UInt64) {
        let start = self.lock.withLock {
            guard self.generation == generation, !self.playbackStarted else { return false }
            self.playbackStarted = true
            return true
        }
        if start {
            self.startPlayback()
        }
    }

    private func completed(bufferID: UInt64, generation: UInt64) {
        guard self.generation == generation, self.scheduledBufferIDs.remove(bufferID) != nil else { return }
        if !self.slotWaiters.isEmpty { self.slotWaiters.removeFirst().resume(returning: true) }
        self.finishIfDrained(generation: generation)
    }

    private func finishIfDrained(generation: UInt64) {
        guard self.inputFinished, self.scheduledBufferIDs.isEmpty else { return }
        self.finish(generation: generation, finished: true)
    }

    private func finish(generation: UInt64, finished: Bool) {
        guard self.generation == generation else { return }
        self.finish(StreamingPlaybackResult(finished: finished, interruptedAt: nil))
    }

    /// State-only retirement. Even synchronous backend stop callbacks cannot re-enter this lock.
    private func finish(_ result: StreamingPlaybackResult, cancelInput: Bool = false) {
        self.generation &+= 1
        if cancelInput { self.inputTask?.cancel() }
        self.scheduledBufferIDs.removeAll()
        let waiters = self.slotWaiters
        self.slotWaiters.removeAll()
        for waiter in waiters {
            waiter.resume(returning: false)
        }
        self.inputTask = nil
        self.inputFinished = false
        let continuation = self.playbackContinuation
        self.playbackContinuation = nil
        if continuation != nil {
            self.backendQueue.async { [self] in self.stopPlayback() }
        }
        continuation?.yield(result)
        continuation?.finish()
    }

    #if DEBUG
    // periphery:ignore - tests observe completion processing, not just callback submission.
    func _test_waitForBackendOperations() async {
        await withCheckedContinuation { continuation in
            self.backendQueue.async { continuation.resume() }
        }
    }
    #endif
}
#endif
