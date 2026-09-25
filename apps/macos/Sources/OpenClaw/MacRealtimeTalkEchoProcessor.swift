import Foundation
import OpenClawAudioAECNative

/// Hardware timestamps identify sample positions, independent of tap delivery order.
struct MacRealtimeTalkAudioChunk: Sendable {
    let start: Double
    let sampleRate: Double
    let samples: [Float]
    var end: Double {
        self.start + Double(self.samples.count) / self.sampleRate
    }
}

enum MacRealtimeTalkEchoError: Error {
    case invalidAudio
    case discontinuity
    case missingReference
    case processingFailed
}

private struct MacRealtimeTalkAudioTimeline {
    var chunks: [MacRealtimeTalkAudioChunk] = []
    var start: Double? {
        self.chunks.first?.start
    }

    var end: Double? {
        self.chunks.last?.end
    }

    mutating func append(_ chunk: MacRealtimeTalkAudioChunk) throws {
        guard chunk.start.isFinite, chunk.sampleRate.isFinite, chunk.sampleRate > 0,
              !chunk.samples.isEmpty, chunk.samples.allSatisfy(\.isFinite)
        else { throw MacRealtimeTalkEchoError.invalidAudio }
        if let previous = self.chunks.last {
            // Allow sub-sample timestamp rounding; real missing/repeated buffers
            // invalidate AEC instead of being replaced by artificial silence.
            guard abs(chunk.start - previous.end) <= 2 / min(chunk.sampleRate, previous.sampleRate)
            else { throw MacRealtimeTalkEchoError.discontinuity }
        }
        self.chunks.append(chunk)
        if let first = self.start, chunk.end - first > 2 {
            throw MacRealtimeTalkEchoError.missingReference
        }
    }

    func frame(at start: Double) throws -> [Float] {
        var result = [Float]()
        result.reserveCapacity(480)
        var chunkIndex = 0
        for i in 0..<480 {
            let time = start + Double(i) / 48000
            while chunkIndex + 1 < self.chunks.count,
                  time >= self.chunks[chunkIndex + 1].start
            {
                chunkIndex += 1
            }
            guard chunkIndex < self.chunks.count else { throw MacRealtimeTalkEchoError.discontinuity }
            let chunk = self.chunks[chunkIndex]
            let position = (time - chunk.start) * chunk.sampleRate
            guard position >= -0.01, position < Double(chunk.samples.count) + 2 else {
                throw MacRealtimeTalkEchoError.discontinuity
            }
            let index = max(0, Int(position))
            if index + 1 < chunk.samples.count {
                let fraction = Float(max(0, position) - Double(index))
                result.append(chunk.samples[index] * (1 - fraction) + chunk.samples[index + 1] * fraction)
            } else if chunkIndex + 1 < self.chunks.count {
                let next = self.chunks[chunkIndex + 1]
                let lastTime = chunk.end - 1 / chunk.sampleRate
                let fraction = Float(min(1, max(0, (time - lastTime) / (next.start - lastTime))))
                result.append(chunk.samples.last! * (1 - fraction) + next.samples[0] * fraction)
            } else {
                result.append(chunk.samples.last!)
            }
        }
        return result
    }

    mutating func discard(before time: Double) {
        // Keep the last boundary sample's chunk for interpolation across callbacks.
        while self.chunks.count > 1, self.chunks[1].start <= time {
            self.chunks.removeFirst()
        }
    }
}

/// Synchronous AEC owner; the audio pipeline calls it only on its serial queue.
/// Capture and render are paired at equal hardware times, with bounded holdback.
final class MacRealtimeTalkEchoProcessor {
    private let state: UnsafeMutableRawPointer
    private var capture = MacRealtimeTalkAudioTimeline()
    private var render = MacRealtimeTalkAudioTimeline()
    private var origin: Double?
    private var processedFrames = 0
    private var pendingOutput: [Float] = []

    init() throws {
        guard let state = oc_audio_aec_create() else { throw MacRealtimeTalkEchoError.processingFailed }
        self.state = state
    }

    deinit { oc_audio_aec_destroy(self.state) }

    func append(_ chunk: MacRealtimeTalkAudioChunk, isRender: Bool) throws -> MacRealtimeTalkAudioChunk? {
        if isRender { try self.render.append(chunk) } else { try self.capture.append(chunk) }
        if self.origin == nil, let micStart = self.capture.start, let renderStart = self.render.start {
            self.origin = max(micStart, renderStart)
        }
        guard let origin, let micEnd = self.capture.end, let renderEnd = self.render.end else { return nil }
        let start = origin + Double(self.processedFrames) / 100 - Double(self.pendingOutput.count) / 48000
        guard abs(micEnd - renderEnd) <= 0.4 else { throw MacRealtimeTalkEchoError.missingReference }
        while origin + Double(self.processedFrames + 1) / 100 <= min(micEnd, renderEnd) + 0.0000001 {
            let time = origin + Double(self.processedFrames) / 100
            let mic = try self.capture.frame(at: time)
            let reference = try self.render.frame(at: time)
            var cleaned = [Float](repeating: 0, count: 480)
            let status = reference.withUnsafeBufferPointer { render in
                mic.withUnsafeBufferPointer { capture in
                    cleaned.withUnsafeMutableBufferPointer { output in
                        oc_audio_aec_process(self.state, render.baseAddress, capture.baseAddress, output.baseAddress)
                    }
                }
            }
            guard status == 0 else { throw MacRealtimeTalkEchoError.processingFailed }
            self.pendingOutput.append(contentsOf: cleaned)
            self.processedFrames += 1
        }
        let next = origin + Double(self.processedFrames) / 100
        self.capture.discard(before: next)
        self.render.discard(before: next)
        // Tap callbacks can be shorter than the relay's RPC acknowledgment latency.
        // Keep processing AEC at 10ms, but combine at least 100ms of cleaned audio
        // across callbacks before using one of the sender's four in-flight slots.
        // Capture stop retires this processor and its partial packet; no old audio
        // may be flushed into a later capture generation.
        guard self.pendingOutput.count >= 4800 else { return nil }
        let output = self.pendingOutput
        self.pendingOutput = []
        return MacRealtimeTalkAudioChunk(start: start, sampleRate: 48000, samples: output)
    }
}
