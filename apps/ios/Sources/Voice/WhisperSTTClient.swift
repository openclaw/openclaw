import Foundation

/// WAV encoding utility for gateway STT. Wraps raw Float32 mono PCM in a
/// minimal 16-bit WAV container suitable for server-side transcription.
struct WhisperSTTClient {
    /// Wraps raw Float32 mono PCM data in a minimal WAV container (16-bit PCM).
    static func wavFromPCM(pcmData: Data, sampleRate: UInt32) -> Data {
        let sampleCount = pcmData.count / MemoryLayout<Float>.size
        let int16Data = pcmData.withUnsafeBytes { raw -> Data in
            let floats = raw.bindMemory(to: Float.self)
            var buf = Data(capacity: sampleCount * 2)
            for i in 0..<sampleCount {
                let clamped = max(-1.0, min(1.0, floats[i]))
                var sample = Int16(clamped * Float(Int16.max))
                withUnsafeBytes(of: &sample) { buf.append(contentsOf: $0) }
            }
            return buf
        }

        let channels: UInt16 = 1
        let bitsPerSample: UInt16 = 16
        let byteRate = sampleRate * UInt32(channels) * UInt32(bitsPerSample / 8)
        let blockAlign = channels * (bitsPerSample / 8)
        let dataSize = UInt32(int16Data.count)
        let fileSize = 36 + dataSize

        var header = Data(capacity: 44)
        header.append(contentsOf: "RIFF".utf8)
        header.appendLittleEndian(fileSize)
        header.append(contentsOf: "WAVE".utf8)
        header.append(contentsOf: "fmt ".utf8)
        header.appendLittleEndian(UInt32(16)) // chunk size
        header.appendLittleEndian(UInt16(1))  // PCM format
        header.appendLittleEndian(channels)
        header.appendLittleEndian(sampleRate)
        header.appendLittleEndian(byteRate)
        header.appendLittleEndian(blockAlign)
        header.appendLittleEndian(bitsPerSample)
        header.append(contentsOf: "data".utf8)
        header.appendLittleEndian(dataSize)
        header.append(int16Data)
        return header
    }
}

private extension Data {
    mutating func appendLittleEndian<T: FixedWidthInteger>(_ value: T) {
        var v = value.littleEndian
        Swift.withUnsafeBytes(of: &v) { self.append(contentsOf: $0) }
    }
}
