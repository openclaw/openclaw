@preconcurrency import AVFoundation
import Foundation
import OpenClawKit
import OSLog

enum MacRealtimeTalkInputProcessingMode: Sendable {
    case echoControlled
    case isolatedHeadphones
}

/// Copies selected microphone channels into a bounded serial processing lane.
/// Only verified isolated headphones bypass AEC; other routes require a valid render reference.
final class MacRealtimeTalkEchoPipeline: @unchecked Sendable {
    private let queue = DispatchQueue(label: "ai.openclaw.talk.echo", qos: .userInteractive)
    private let lock = NSLock()
    private let processor: MacRealtimeTalkEchoProcessor?
    private let targetSampleRate: Double
    private let deliveryGate: TalkGenerationDeliveryGate
    private let deliveryToken: UInt64
    private let onAudio: @Sendable (RealtimeTalkAudioFrame) -> Void
    private let onFailure: @Sendable () -> Void
    private let logger = Logger(subsystem: "ai.openclaw", category: "talk.realtime.echo")
    private var pending = 0
    private var stopped = false
    private var healthy = false

    var isHealthy: Bool {
        self.lock.lock()
        defer { self.lock.unlock() }
        return self.healthy && !self.stopped
    }

    init(
        inputProcessingMode: MacRealtimeTalkInputProcessingMode = .echoControlled,
        targetSampleRate: Double,
        deliveryGate: TalkGenerationDeliveryGate,
        deliveryToken: UInt64,
        onAudio: @escaping @Sendable (RealtimeTalkAudioFrame) -> Void,
        onFailure: @escaping @Sendable () -> Void) throws
    {
        self.processor = inputProcessingMode == .echoControlled ? try MacRealtimeTalkEchoProcessor() : nil
        self.targetSampleRate = targetSampleRate
        self.deliveryGate = deliveryGate
        self.deliveryToken = deliveryToken
        self.onAudio = onAudio
        self.onFailure = onFailure
    }

    func stop() {
        self.lock.lock()
        self.stopped = true
        self.healthy = false
        self.lock.unlock()
    }

    func makeTap(channels: Range<Int>, isRender: Bool) -> AVAudioNodeTapBlock {
        { [self] buffer, time in
            guard self.deliveryGate.isActive(self.deliveryToken) else { return }
            guard time.isHostTimeValid, let data = buffer.floatChannelData,
                  !channels.isEmpty, channels.lowerBound >= 0,
                  channels.upperBound <= Int(buffer.format.channelCount), buffer.frameLength > 0
            else { self.fail()
                return
            }
            self.lock.lock()
            let accepted = !self.stopped && self.pending < 8
            if accepted { self.pending += 1 }
            let alreadyStopped = self.stopped
            self.lock.unlock()
            guard accepted else {
                if !alreadyStopped { self.fail() }
                return
            }
            var mono = [Float](repeating: 0, count: Int(buffer.frameLength))
            for channel in channels {
                for i in mono.indices {
                    mono[i] += data[channel][i] / Float(channels.count)
                }
            }
            let chunk = MacRealtimeTalkAudioChunk(
                start: AVAudioTime.seconds(forHostTime: time.hostTime),
                sampleRate: buffer.format.sampleRate,
                samples: mono)
            self.queue.async { [self] in
                defer {
                    self.lock.lock()
                    self.pending -= 1
                    self.lock.unlock()
                }
                guard self.deliveryGate.isActive(self.deliveryToken) else { return }
                self.lock.lock()
                let stopped = self.stopped
                self.lock.unlock()
                guard !stopped else { return }
                do {
                    let cleaned: MacRealtimeTalkAudioChunk
                    if let processor = self.processor {
                        guard let processed = try processor.append(chunk, isRender: isRender) else { return }
                        cleaned = processed
                    } else {
                        guard !isRender else { return }
                        guard chunk.samples.allSatisfy(\.isFinite) else {
                            throw MacRealtimeTalkEchoError.invalidAudio
                        }
                        cleaned = chunk
                    }
                    guard let format = AVAudioFormat(
                        commonFormat: .pcmFormatFloat32,
                        sampleRate: cleaned.sampleRate,
                        channels: 1,
                        interleaved: false),
                        let pcm = AVAudioPCMBuffer(
                            pcmFormat: format, frameCapacity: AVAudioFrameCount(cleaned.samples.count)),
                        let destination = pcm.floatChannelData?[0]
                    else { throw MacRealtimeTalkEchoError.processingFailed }
                    pcm.frameLength = pcm.frameCapacity
                    cleaned.samples.withUnsafeBufferPointer { source in
                        destination.update(from: source.baseAddress!, count: source.count)
                    }
                    guard let frame = MacRealtimeTalkAudioFrameEncoder.encode(
                        buffer: pcm, targetSampleRate: self.targetSampleRate, timestampMs: cleaned.start * 1000)
                    else { throw MacRealtimeTalkEchoError.processingFailed }
                    self.lock.lock()
                    let becameHealthy = !self.healthy && !self.stopped
                    if !self.stopped { self.healthy = true }
                    self.lock.unlock()
                    if becameHealthy, self.processor != nil {
                        self.logger.info("realtime echo control ready with timestamped playback reference")
                    }
                    self.deliveryGate.deliver(ifActive: self.deliveryToken) { self.onAudio(frame) }
                } catch {
                    self.logger.error("realtime echo control failed; microphone delivery stopped")
                    self.fail()
                }
            }
        }
    }

    private func fail() {
        self.lock.lock()
        let notify = !self.stopped
        self.stopped = true
        self.healthy = false
        self.lock.unlock()
        guard notify, self.deliveryGate.deactivate(ifActive: self.deliveryToken) else { return }
        self.onFailure()
    }
}
