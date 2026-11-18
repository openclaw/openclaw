import AVFoundation
import Foundation

/// Normalizes an RMS value to the shared 0...1 UI level scale used by every
/// talk animation (mic, playback, recording) so the wave reads identically
/// across surfaces: dB full scale mapped over a 50 dB window.
public enum TalkAudioLevel {
    public static func normalized(rms: Double) -> Double {
        self.normalized(decibels: 20 * log10(max(rms, 1e-7)))
    }

    public static func normalized(decibels: Double) -> Double {
        max(0, min(1, (decibels + 50) / 50))
    }

    /// Average RMS across all channels of a float PCM buffer; 0 for degenerate
    /// buffers (Core Audio taps never deliver them in practice). Callable from
    /// realtime audio tap threads.
    public static func rms(buffer: AVAudioPCMBuffer) -> Double {
        guard let channelData = buffer.floatChannelData, buffer.frameLength > 0 else { return 0 }
        let frameCount = Int(buffer.frameLength)
        let channelCount = max(1, Int(buffer.format.channelCount))
        var sum: Double = 0
        for channel in 0..<channelCount {
            let samples = channelData[channel]
            for index in 0..<frameCount {
                let sample = Double(samples[index])
                sum += sample * sample
            }
        }
        return (sum / Double(frameCount * channelCount)).squareRoot()
    }

    /// RMS of little-endian PCM16 mono bytes; 0 for empty or odd-length data.
    public static func pcm16RMS(_ data: Data) -> Double {
        let sampleCount = data.count / 2
        guard sampleCount > 0 else { return 0 }
        var sum: Double = 0
        data.withUnsafeBytes { raw in
            let samples = raw.bindMemory(to: Int16.self)
            for index in 0..<sampleCount {
                let sample = Double(Int16(littleEndian: samples[index])) / Double(Int16.max)
                sum += sample * sample
            }
        }
        return (sum / Double(sampleCount)).squareRoot()
    }
}

/// PCM scheduling shared by the main-actor and lock-owned meters; callers own their clocks.
struct PCMPlaybackTimeline {
    private struct Segment {
        let start: TimeInterval
        let end: TimeInterval
        let level: Double
    }

    private var segments: [Segment] = []
    private var scheduleEnd: TimeInterval = 0
    var bytesPerSecond: Double = 0

    mutating func append(_ chunk: Data, elapsed: TimeInterval) {
        // Queue bursts behind scheduled audio, but resume stalled streams at the current time.
        var start = max(elapsed, self.scheduleEnd)
        let windowBytes = max(2, Int(self.bytesPerSecond * 0.05) & ~1)
        var offset = chunk.startIndex
        while offset < chunk.endIndex {
            let end = min(offset + windowBytes, chunk.endIndex)
            let window = Data(chunk[offset..<end])
            let duration = Double(window.count) / self.bytesPerSecond
            self.segments.append(Segment(
                start: start,
                end: start + duration,
                level: TalkAudioLevel.normalized(rms: TalkAudioLevel.pcm16RMS(window))))
            start += duration
            offset = end
        }
        self.scheduleEnd = start
    }

    mutating func level(elapsed: TimeInterval) -> Double? {
        guard elapsed <= self.scheduleEnd + 0.5 else { return nil }
        self.segments.removeAll { $0.end < elapsed }
        return self.segments.first { elapsed >= $0.start && elapsed < $0.end }?.level ?? 0
    }

    mutating func clear(keepingCapacity: Bool = false) {
        self.segments.removeAll(keepingCapacity: keepingCapacity)
        self.scheduleEnd = 0
    }
}

/// Builds a playback-time-aligned level envelope from PCM16 chunks that stream
/// through the app faster than real time (gateway TTS, ElevenLabs PCM, realtime
/// relay output). Chunks are RMS-metered on arrival but scheduled at their
/// expected playback offset, so the published level tracks what is audible
/// instead of network arrival bursts.
@MainActor
public final class PCMPlaybackEnvelope {
    private let onLevel: @MainActor (Double?) -> Void
    private var timeline = PCMPlaybackTimeline()
    private var startedAt: ContinuousClock.Instant?
    private var publishTask: Task<Void, Never>?

    public init(onLevel: @escaping @MainActor (Double?) -> Void) {
        self.onLevel = onLevel
    }

    /// Starts a new envelope; the playback clock is anchored to the first chunk.
    public func begin(sampleRate: Double) {
        self.cancel()
        self.timeline.bytesPerSecond = max(1, sampleRate * Double(MemoryLayout<Int16>.size))
    }

    public func append(_ chunk: Data) {
        guard self.timeline.bytesPerSecond > 1, !chunk.isEmpty else { return }
        let now = ContinuousClock.now
        if self.startedAt == nil {
            self.startedAt = now
            self.startPublishing()
        }
        guard let startedAt = self.startedAt else { return }
        self.timeline.append(chunk, elapsed: Self.seconds(startedAt.duration(to: now)))
    }

    /// Passes PCM chunks through to a player while metering them into this
    /// envelope, so the published level follows the audible speech. Callers
    /// `cancel()` once playback returns.
    public func metering(
        _ stream: AsyncThrowingStream<Data, Error>,
        sampleRate: Double) -> AsyncThrowingStream<Data, Error>
    {
        self.begin(sampleRate: sampleRate)
        return AsyncThrowingStream { continuation in
            let task = Task { @MainActor [weak self] in
                do {
                    for try await chunk in stream {
                        self?.append(chunk)
                        continuation.yield(chunk)
                    }
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
            continuation.onTermination = { _ in
                task.cancel()
            }
        }
    }

    /// Stops immediately (interruption/teardown) and clears the published level.
    public func cancel() {
        self.publishTask?.cancel()
        self.publishTask = nil
        self.timeline.clear()
        self.startedAt = nil
        self.onLevel(nil)
    }

    private func startPublishing() {
        self.publishTask?.cancel()
        self.publishTask = Task { [weak self] in
            while !Task.isCancelled {
                guard let self else { return }
                guard self.publish() else {
                    self.cancel()
                    return
                }
                try? await Task.sleep(nanoseconds: 33_000_000)
            }
        }
    }

    /// Publishes the level at the current playback position; false once the
    /// scheduled tail (plus a drain grace) has fully played out.
    private func publish() -> Bool {
        guard let startedAt = self.startedAt else { return false }
        let elapsed = Self.seconds(startedAt.duration(to: .now))
        guard let level = self.timeline.level(elapsed: elapsed) else { return false }
        self.onLevel(level)
        return true
    }

    private static func seconds(_ duration: Duration) -> TimeInterval {
        let parts = duration.components
        return Double(parts.seconds) + Double(parts.attoseconds) * 1e-18
    }
}

/// Publishes the live output level of an `AVAudioPlayer` (buffered TTS clips)
/// via its built-in metering at ~30 Hz. Detach clears the level to nil so the
/// consumer can distinguish "silent" from "not playing".
@MainActor
final class AudioPlayerLevelMeter {
    private let onLevel: @MainActor (Double?) -> Void
    private var pollTask: Task<Void, Never>?
    private weak var player: AVAudioPlayer?

    init(onLevel: @escaping @MainActor (Double?) -> Void) {
        self.onLevel = onLevel
    }

    func attach(_ player: AVAudioPlayer) {
        self.detach()
        player.isMeteringEnabled = true
        self.player = player
        self.pollTask = Task { [weak self] in
            while !Task.isCancelled {
                guard let self, let player = self.player else { return }
                player.updateMeters()
                self.onLevel(TalkAudioLevel.normalized(decibels: Double(player.averagePower(forChannel: 0))))
                try? await Task.sleep(nanoseconds: 33_000_000)
            }
        }
    }

    func detach() {
        self.pollTask?.cancel()
        self.pollTask = nil
        self.player = nil
        self.onLevel(nil)
    }
}
