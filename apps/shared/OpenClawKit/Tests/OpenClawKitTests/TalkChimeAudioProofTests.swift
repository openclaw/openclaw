#if os(macOS)
import AVFoundation
import CoreGraphics
import CryptoKit
import Foundation
import ImageIO
import OpenClawKit
import Testing
import UniformTypeIdentifiers

/// Writes audio evidence for the Talk chimes when `TALK_CHIME_PROOF_DIR` is set; otherwise only the
/// in-memory checks run. The samples are the shipped chime assets decoded exactly as the player
/// would load them, laid out on the timeline the lifecycle state machine decides.
struct TalkChimeAudioProofTests {
    private struct Placed {
        let cue: TalkChimeLifecycle.Cue
        let label: String
        let start: Double
        let samples: [Float]
        let sampleRate: Double
        let sha256: String
    }

    private static func assetURL(_ cue: TalkChimeLifecycle.Cue) -> URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("Sources/OpenClawKit/Resources/chime_\(cue.rawValue).caf")
    }

    private static func decode(_ cue: TalkChimeLifecycle.Cue) throws -> (samples: [Float], rate: Double, sha: String) {
        let url = self.assetURL(cue)
        let data = try Data(contentsOf: url)
        let file = try AVAudioFile(forReading: url)
        let format = AVAudioFormat(
            commonFormat: .pcmFormatFloat32, sampleRate: file.processingFormat.sampleRate,
            channels: 1, interleaved: false)!
        let buffer = try #require(AVAudioPCMBuffer(pcmFormat: file.processingFormat, frameCapacity: AVAudioFrameCount(file.length)))
        try file.read(into: buffer)
        let channels = Int(buffer.format.channelCount)
        let frames = Int(buffer.frameLength)
        var mono = [Float](repeating: 0, count: frames)
        let source = try #require(buffer.floatChannelData)
        for channel in 0..<channels { for i in 0..<frames { mono[i] += source[channel][i] / Float(channels) } }
        _ = format
        let sha = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
        return (mono, file.processingFormat.sampleRate, sha)
    }

    @Test func `scripted call places readiness, reply and end chimes with audible samples`() throws {
        // Decisions come from the real lifecycle state machine.
        var call = TalkChimeLifecycle()
        let wake = try #require(call.ready(enabled: true))
        call.replyFinished(isRealtime: false)
        let follow = try #require(call.resumedListening(isRealtime: false, enabled: true))
        let bye = try #require(call.end(clean: true, enabled: true))
        #expect([wake, follow, bye] == [.wake, .follow, .bye])

        let script: [(TalkChimeLifecycle.Cue, String, Double)] = [
            (wake, "Listening", 0.5), (follow, "Ready for reply", 4.0), (bye, "Call end", 7.5),
        ]
        var placed: [Placed] = []
        for (cue, label, start) in script {
            let decoded = try Self.decode(cue)
            #expect(decoded.samples.count > 1000)
            #expect((decoded.samples.map { abs($0) }.max() ?? 0) > 0.01)
            placed.append(Placed(
                cue: cue, label: label, start: start, samples: decoded.samples,
                sampleRate: decoded.rate, sha256: decoded.sha))
        }
        guard let dir = ProcessInfo.processInfo.environment["TALK_CHIME_PROOF_DIR"] else { return }
        try Self.write(placed, to: URL(fileURLWithPath: dir, isDirectory: true))
    }

    private static func write(_ placed: [Placed], to dir: URL) throws {
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let rate = placed[0].sampleRate
        let total = placed.map { $0.start + Double($0.samples.count) / $0.sampleRate }.max()! + 1.0
        var mix = [Float](repeating: 0, count: Int(total * rate))
        for item in placed {
            let offset = Int(item.start * rate)
            for (i, value) in item.samples.enumerated() where offset + i < mix.count { mix[offset + i] += value }
        }
        // WAV, 16-bit mono.
        var wav = Data()
        func u32(_ v: UInt32) { var x = v.littleEndian; wav.append(Data(bytes: &x, count: 4)) }
        func u16(_ v: UInt16) { var x = v.littleEndian; wav.append(Data(bytes: &x, count: 2)) }
        let bytes = mix.count * 2
        wav.append("RIFF".data(using: .ascii)!); u32(UInt32(36 + bytes)); wav.append("WAVEfmt ".data(using: .ascii)!)
        u32(16); u16(1); u16(1); u32(UInt32(rate)); u32(UInt32(rate) * 2); u16(2); u16(16)
        wav.append("data".data(using: .ascii)!); u32(UInt32(bytes))
        for v in mix { u16(UInt16(bitPattern: Int16(max(-1, min(1, v)) * 32767))) }
        try wav.write(to: dir.appendingPathComponent("chimes-call.wav"))

        let events = placed.map { item -> [String: Any] in
            ["cue": item.cue.rawValue, "label": item.label, "startSeconds": item.start,
             "durationSeconds": Double(item.samples.count) / item.sampleRate,
             "peak": Double(item.samples.map { abs($0) }.max() ?? 0), "assetSha256": item.sha256,
             "source": "apps/shared/OpenClawKit/Sources/OpenClawKit/Resources/chime_\(item.cue.rawValue).caf"]
        }
        let json = try JSONSerialization.data(
            withJSONObject: ["sampleRate": rate, "totalSeconds": total, "events": events],
            options: [.prettyPrinted, .sortedKeys])
        try json.write(to: dir.appendingPathComponent("chime-events.json"))

        // Waveform PNG with markers.
        let width = 1600, height = 360
        let context = try #require(CGContext(
            data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0,
            space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue))
        context.setFillColor(CGColor(red: 1, green: 1, blue: 1, alpha: 1))
        context.fill(CGRect(x: 0, y: 0, width: width, height: height))
        context.setStrokeColor(CGColor(red: 0.1, green: 0.3, blue: 0.7, alpha: 1))
        let mid = CGFloat(height) / 2, perPixel = max(1, mix.count / width)
        for x in 0..<width {
            let slice = mix[(x * perPixel)..<min(mix.count, (x + 1) * perPixel)]
            let peak = CGFloat(slice.map { abs($0) }.max() ?? 0)
            context.move(to: CGPoint(x: x, y: Int(mid - peak * (mid - 30))))
            context.addLine(to: CGPoint(x: x, y: Int(mid + peak * (mid - 30))))
        }
        context.strokePath()
        context.setStrokeColor(CGColor(red: 0.8, green: 0.1, blue: 0.1, alpha: 1))
        for item in placed {
            let x = CGFloat(item.start / total) * CGFloat(width)
            context.move(to: CGPoint(x: x, y: 0)); context.addLine(to: CGPoint(x: x, y: CGFloat(height)))
        }
        context.strokePath()
        let image = try #require(context.makeImage())
        let png = NSMutableData()
        let destination = try #require(CGImageDestinationCreateWithData(png, UTType.png.identifier as CFString, 1, nil))
        CGImageDestinationAddImage(destination, image, nil)
        try #require(CGImageDestinationFinalize(destination))
        try (png as Data).write(to: dir.appendingPathComponent("waveform.png"))
    }
}
#endif
