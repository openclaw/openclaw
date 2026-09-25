import Foundation
import Testing
@testable import OpenClaw

struct MacRealtimeTalkEchoProcessorTests {
    @Test(arguments: [48000.0, 96000.0])
    func `short hardware callbacks coalesce before consuming relay requests`(sampleRate: Double) throws {
        let processor = try MacRealtimeTalkEchoProcessor()
        let callbackFrames = 2048
        let callbackDuration = Double(callbackFrames) / sampleRate
        var packets: [MacRealtimeTalkAudioChunk] = []
        for callback in 0..<100 {
            let start = 100 + Double(callback * callbackFrames) / sampleRate
            let capture = MacRealtimeTalkAudioChunk(
                start: start, sampleRate: sampleRate, samples: .init(repeating: 0.025, count: callbackFrames))
            let render = MacRealtimeTalkAudioChunk(
                start: start, sampleRate: sampleRate, samples: .init(repeating: 0, count: callbackFrames))
            for (chunk, isRender) in [(capture, false), (render, true)] {
                if let packet = try processor.append(chunk, isRender: isRender) {
                    packets.append(packet)
                }
            }
        }
        #expect(!packets.isEmpty)
        var nextStart = 100.0
        var emittedSamples = 0
        for packet in packets {
            #expect(packet.samples.count >= 4800)
            #expect(packet.samples.count.isMultiple(of: 480))
            #expect(abs(packet.start - nextStart) < 0.000001)
            #expect(packet.end - packet.start < 0.1 + callbackDuration + 0.01)
            emittedSamples += packet.samples.count
            nextStart = packet.end
        }
        let processedSamples = Int(floor(100 * callbackDuration * 100 + 0.000001)) * 480
        #expect((0..<4800).contains(processedSamples - emittedSamples))

        // A 200ms RPC acknowledgment delay used to exhaust four slots at both
        // callback rates. Coalescing must leave room without raising that limit.
        var acknowledgments: [Double] = []
        for packet in packets {
            acknowledgments.removeAll { $0 <= packet.end }
            #expect(acknowledgments.count < 4)
            acknowledgments.append(packet.end + 0.2)
        }
    }

    @Test func `retiring capture discards its partial cleaned packet`() throws {
        let old = try MacRealtimeTalkEchoProcessor()
        let partial = [Float](repeating: 0.05, count: 4320)
        #expect(try old.append(.init(start: 10, sampleRate: 48000, samples: partial), isRender: false) == nil)
        #expect(try old.append(
            .init(start: 10, sampleRate: 48000, samples: .init(repeating: 0, count: 4320)),
            isRender: true) == nil)

        // Capture creates a new processor, with a new hardware-time origin.
        let resumed = try MacRealtimeTalkEchoProcessor()
        let silence = [Float](repeating: 0, count: 4800)
        #expect(try resumed.append(.init(start: 20, sampleRate: 48000, samples: silence), isRender: false) == nil)
        let packet = try #require(try resumed.append(
            .init(start: 20, sampleRate: 48000, samples: silence), isRender: true))
        #expect(packet.start == 20)
        #expect(packet.samples.count == 4800)
    }

    @Test func `timestamped render cancels a delayed echo across mixed rate tap batches`() throws {
        let processor = try MacRealtimeTalkEchoProcessor()
        var reference = [Float](repeating: 0, count: 44100 * 12)
        var random: UInt64 = 17
        for i in reference.indices {
            random = random &* 6_364_136_223_846_793_005 &+ 1
            // Echo RMS is about.06, below the live speaker measurement(.115).
            // At very quiet levels AEC3 comfort noise dominates total output power.
            let white = Float(Int32(truncatingIfNeeded: random >> 32)) / Float(Int32.max) * 0.6
            reference[i] = (i > 0 ? reference[i - 1] * 0.8 : 0) + white * 0.2
        }
        var energyIn = 0.0
        var energyOut = 0.0
        var sampleCount = 0
        var batches = 0
        var nearSin = 0.0
        var nearCos = 0.0
        var nearCount = 0
        for tick in 0..<120 {
            let offset = tick * 4800
            let capture = (0..<4800).map { i -> Float in
                // Echo comes from the waveform actually rendered at44.1kHz,
                // sampled by the microphone clock80ms later.
                let position = Double(offset + i - 3840) * 44100 / 48000
                let index = Int(max(0, position))
                let fraction = Float(max(0, position) - Double(index))
                let echo: Float = position < 0 ? 0 :
                    (reference[index] * (1 - fraction) + reference[index + 1] * fraction) * 0.55
                let near: Float = tick >= 100 ? 0.06 * sin(Float(offset + i) * 2 * .pi * 600 / 48000) : 0
                return echo + near
            }
            let render = Array(reference[(tick * 4410)..<((tick + 1) * 4410)])
            let time = 100 + Double(tick) / 10
            // The capture callback may precede the mixer callback. Neither may
            // synthesize silence to fill the other stream's delivery latency.
            let first = try processor.append(.init(start: time, sampleRate: 48000, samples: capture), isRender: false)
            #expect(first == nil)
            let result = try #require(try processor.append(
                .init(start: time, sampleRate: 44100, samples: render), isRender: true))
            #expect(result.samples.count == 4800)
            #expect(abs(result.start - time) < 0.000001)
            batches += 1
            if tick >= 80, tick < 100 {
                energyIn += capture.reduce(0.0) { $0 + Double($1 * $1) }
                energyOut += result.samples.reduce(0.0) { $0 + Double($1 * $1) }
                sampleCount += result.samples.count
            }
            if tick >= 110 {
                for (i, value) in result.samples.enumerated() {
                    let phase = Double(offset + i) * 2 * .pi * 600 / 48000
                    nearSin += Double(value) * sin(phase)
                    nearCos += Double(value) * cos(phase)
                    nearCount += 1
                }
            }
        }
        #expect(batches == 120)
        #expect(sampleCount == 4800 * 20)
        #expect(10 * log10(energyIn / max(energyOut, 1e-15)) > 12)
        // Cancellation must retain independent near-end sound while the same
        // render keeps playing. A muted-output implementation cannot pass.
        #expect(2 * hypot(nearSin, nearCos) / Double(nearCount) > 0.03)
    }

    @Test func `missing or discontinuous reference cannot emit microphone audio`() throws {
        let silence = [Float](repeating: 0, count: 4800)
        let mic = [Float](repeating: 0.1, count: 4800)
        let missing = try MacRealtimeTalkEchoProcessor()
        _ = try missing.append(.init(start: 1, sampleRate: 48000, samples: silence), isRender: true)
        for tick in 0..<5 {
            let result = try missing.append(
                .init(start: 1 + Double(tick) / 10, sampleRate: 48000, samples: mic), isRender: false)
            if tick > 0 { #expect(result == nil) }
        }
        #expect(throws: MacRealtimeTalkEchoError.self) {
            try missing.append(.init(start: 1.5, sampleRate: 48000, samples: mic), isRender: false)
        }
        let gap = try MacRealtimeTalkEchoProcessor()
        _ = try gap.append(.init(start: 1, sampleRate: 48000, samples: silence), isRender: true)
        #expect(throws: MacRealtimeTalkEchoError.self) {
            try gap.append(.init(start: 1.2, sampleRate: 48000, samples: silence), isRender: true)
        }
    }
}
