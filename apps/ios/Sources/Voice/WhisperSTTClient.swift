import Foundation
import OSLog

/// Lightweight client for OpenAI Whisper speech-to-text API.
/// Accepts raw PCM audio, wraps it in a WAV container, and POSTs
/// multipart/form-data to `/v1/audio/transcriptions`.
struct WhisperSTTClient {
    let apiKey: String
    let model: String
    let language: String?

    private static let logger = Logger(subsystem: "ai.openclaw", category: "WhisperSTT")
    private static let apiURL = URL(string: "https://api.openai.com/v1/audio/transcriptions")!

    init(apiKey: String, model: String = "whisper-1", language: String? = nil) {
        self.apiKey = apiKey
        self.model = model
        self.language = language
    }

    /// Transcribe raw PCM audio data (mono, Float32) at the given sample rate.
    func transcribe(pcmData: Data, sampleRate: Double) async throws -> String {
        let wavData = Self.wavFromPCM(pcmData: pcmData, sampleRate: UInt32(sampleRate))

        let boundary = "whisper-\(UUID().uuidString)"
        var request = URLRequest(url: Self.apiURL)
        request.httpMethod = "POST"
        request.setValue("Bearer \(apiKey)", forHTTPHeaderField: "Authorization")
        request.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
        request.timeoutInterval = 30

        var body = Data()
        Self.appendFormField(&body, boundary: boundary, name: "model", value: model)
        if let language, !language.isEmpty {
            Self.appendFormField(&body, boundary: boundary, name: "language", value: language)
        }
        Self.appendFormField(&body, boundary: boundary, name: "response_format", value: "text")
        Self.appendFileField(&body, boundary: boundary, name: "file", filename: "audio.wav",
                             contentType: "audio/wav", data: wavData)
        body.append("--\(boundary)--\r\n".data(using: .utf8)!)
        request.httpBody = body

        Self.logger.info("transcribe: sending \(wavData.count) bytes model=\(model)")
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let httpResponse = response as? HTTPURLResponse else {
            throw WhisperSTTError.invalidResponse
        }
        guard httpResponse.statusCode == 200 else {
            let errorBody = String(data: data, encoding: .utf8) ?? ""
            Self.logger.error("transcribe failed: status=\(httpResponse.statusCode) body=\(errorBody, privacy: .public)")
            throw WhisperSTTError.apiError(statusCode: httpResponse.statusCode, body: errorBody)
        }

        let transcript = (String(data: data, encoding: .utf8) ?? "")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        Self.logger.info("transcribe ok: chars=\(transcript.count)")
        return transcript
    }

    // MARK: - WAV encoding

    /// Wraps raw Float32 mono PCM data in a minimal WAV container (16-bit PCM).
    private static func wavFromPCM(pcmData: Data, sampleRate: UInt32) -> Data {
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

    // MARK: - Multipart helpers

    private static func appendFormField(_ body: inout Data, boundary: String, name: String, value: String) {
        body.append("--\(boundary)\r\n".data(using: .utf8)!)
        body.append("Content-Disposition: form-data; name=\"\(name)\"\r\n\r\n".data(using: .utf8)!)
        body.append("\(value)\r\n".data(using: .utf8)!)
    }

    private static func appendFileField(
        _ body: inout Data, boundary: String, name: String,
        filename: String, contentType: String, data: Data
    ) {
        body.append("--\(boundary)\r\n".data(using: .utf8)!)
        body.append(
            "Content-Disposition: form-data; name=\"\(name)\"; filename=\"\(filename)\"\r\n".data(using: .utf8)!)
        body.append("Content-Type: \(contentType)\r\n\r\n".data(using: .utf8)!)
        body.append(data)
        body.append("\r\n".data(using: .utf8)!)
    }
}

enum WhisperSTTError: LocalizedError {
    case invalidResponse
    case apiError(statusCode: Int, body: String)

    var errorDescription: String? {
        switch self {
        case .invalidResponse:
            return "Invalid response from Whisper API"
        case .apiError(let statusCode, let body):
            return "Whisper API error \(statusCode): \(body)"
        }
    }
}

private extension Data {
    mutating func appendLittleEndian<T: FixedWidthInteger>(_ value: T) {
        var v = value.littleEndian
        Swift.withUnsafeBytes(of: &v) { self.append(contentsOf: $0) }
    }
}
