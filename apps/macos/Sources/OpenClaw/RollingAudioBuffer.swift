import AVFoundation
import Foundation

/// A circular audio buffer that keeps the last N seconds of audio.
/// When triggered, switches to append mode and captures until stopped.
actor RollingAudioBuffer {
    private let maxDuration: TimeInterval
    private let targetSampleRate: Double = 16000 // Whisper expects 16kHz

    /// Audio samples stored as Float arrays (mono, 16kHz)
    private var samples: [Float] = []

    /// Maximum samples to keep in rolling mode (before trigger)
    private var maxSamples: Int {
        Int(maxDuration * targetSampleRate)
    }

    private var isTriggered = false

    init(maxDuration: TimeInterval = 10.0, sampleRate: Double = 16000) {
        self.maxDuration = maxDuration
        // Pre-allocate some capacity
        self.samples.reserveCapacity(Int(maxDuration * sampleRate))
    }

    /// Append audio samples (already converted to mono Float)
    func appendSamples(_ newSamples: [Float]) {
        self.samples.append(contentsOf: newSamples)

        // In rolling mode, trim old samples to stay under maxDuration
        if !self.isTriggered, self.samples.count > self.maxSamples {
            let excess = self.samples.count - self.maxSamples
            self.samples.removeFirst(excess)
        }
    }

    /// Switch to triggered (append) mode — stops trimming old audio
    func trigger() {
        guard !self.isTriggered else { return }
        self.isTriggered = true
    }

    /// Reset to rolling mode and clear samples
    func reset() {
        self.samples.removeAll(keepingCapacity: true)
        self.isTriggered = false
    }

    /// Whether we're in triggered (recording) mode
    var triggered: Bool {
        self.isTriggered
    }

    /// Current duration of audio in buffer
    var duration: TimeInterval {
        Double(samples.count) / targetSampleRate
    }

    /// Export buffer to a WAV file
    func exportToFile(url: URL) throws {
        guard !samples.isEmpty else {
            throw NSError(domain: "RollingAudioBuffer", code: 1,
                         userInfo: [NSLocalizedDescriptionKey: "No audio samples"])
        }

        // Convert Float samples to Int16 for WAV
        let int16Samples = samples.map { sample -> Int16 in
            let clamped = max(-1.0, min(1.0, sample))
            return Int16(clamped * Float(Int16.max))
        }

        // Write WAV file manually
        let sampleRate: UInt32 = UInt32(targetSampleRate)
        let numChannels: UInt16 = 1
        let bitsPerSample: UInt16 = 16
        let byteRate = sampleRate * UInt32(numChannels) * UInt32(bitsPerSample / 8)
        let blockAlign = numChannels * (bitsPerSample / 8)
        let dataSize = UInt32(int16Samples.count * 2)
        let fileSize = 36 + dataSize

        var data = Data()

        // RIFF header
        data.append(contentsOf: "RIFF".utf8)
        data.append(contentsOf: withUnsafeBytes(of: fileSize.littleEndian) { Array($0) })
        data.append(contentsOf: "WAVE".utf8)

        // fmt chunk
        data.append(contentsOf: "fmt ".utf8)
        data.append(contentsOf: withUnsafeBytes(of: UInt32(16).littleEndian) { Array($0) }) // chunk size
        data.append(contentsOf: withUnsafeBytes(of: UInt16(1).littleEndian) { Array($0) }) // PCM format
        data.append(contentsOf: withUnsafeBytes(of: numChannels.littleEndian) { Array($0) })
        data.append(contentsOf: withUnsafeBytes(of: sampleRate.littleEndian) { Array($0) })
        data.append(contentsOf: withUnsafeBytes(of: byteRate.littleEndian) { Array($0) })
        data.append(contentsOf: withUnsafeBytes(of: blockAlign.littleEndian) { Array($0) })
        data.append(contentsOf: withUnsafeBytes(of: bitsPerSample.littleEndian) { Array($0) })

        // data chunk
        data.append(contentsOf: "data".utf8)
        data.append(contentsOf: withUnsafeBytes(of: dataSize.littleEndian) { Array($0) })

        // Audio samples
        for sample in int16Samples {
            data.append(contentsOf: withUnsafeBytes(of: sample.littleEndian) { Array($0) })
        }

        try data.write(to: url)
    }

    /// Export buffer to a temporary file
    func exportToTempFile() throws -> URL {
        let tempURL = FileManager.default.temporaryDirectory
            .appendingPathComponent("voicewake-\(UUID().uuidString).wav")
        try self.exportToFile(url: tempURL)
        return tempURL
    }
}

/// Helper to extract mono Float samples from an AVAudioPCMBuffer
func extractMonoSamples(from buffer: AVAudioPCMBuffer, targetSampleRate: Double = 16000) -> [Float]? {
    guard let channelData = buffer.floatChannelData else { return nil }
    let frameCount = Int(buffer.frameLength)
    guard frameCount > 0 else { return nil }

    let sourceSampleRate = buffer.format.sampleRate
    let channelCount = Int(buffer.format.channelCount)

    // Mix to mono
    var monoSamples = [Float](repeating: 0, count: frameCount)
    for i in 0..<frameCount {
        var sum: Float = 0
        for ch in 0..<channelCount {
            sum += channelData[ch][i]
        }
        monoSamples[i] = sum / Float(channelCount)
    }

    // Resample if needed (simple linear interpolation)
    if abs(sourceSampleRate - targetSampleRate) > 1 {
        let ratio = targetSampleRate / sourceSampleRate
        let newCount = Int(Double(frameCount) * ratio)
        var resampled = [Float](repeating: 0, count: newCount)
        for i in 0..<newCount {
            let srcIndex = Double(i) / ratio
            let srcIndexInt = Int(srcIndex)
            let frac = Float(srcIndex - Double(srcIndexInt))
            if srcIndexInt + 1 < monoSamples.count {
                resampled[i] = monoSamples[srcIndexInt] * (1 - frac) + monoSamples[srcIndexInt + 1] * frac
            } else if srcIndexInt < monoSamples.count {
                resampled[i] = monoSamples[srcIndexInt]
            }
        }
        return resampled
    }

    return monoSamples
}
