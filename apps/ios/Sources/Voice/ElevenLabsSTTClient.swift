import Foundation

/// Client for the ElevenLabs Speech-to-Text (Scribe v2) batch API.
/// Kept as a fallback; the primary path uses ElevenLabsRealtimeSTTClient.
struct ElevenLabsSTTClient {
    private static let endpoint = URL(string: "https://api.elevenlabs.io/v1/speech-to-text")!

    /// Transcribes WAV audio data using ElevenLabs Scribe.
    /// - Parameters:
    ///   - wavData: WAV-encoded audio data (16-bit PCM mono).
    ///   - apiKey: ElevenLabs API key (same key used for TTS).
    ///   - languageCode: Optional ISO 639-3 language code hint (e.g. "eng", "zho").
    ///   - modelId: Scribe model to use (default "scribe_v2").
    /// - Returns: The transcribed text.
    static func transcribe(
        wavData: Data, apiKey: String, languageCode: String? = nil, modelId: String = "scribe_v2"
    ) async throws -> String {
        let boundary = "Boundary-\(UUID().uuidString)"
        var request = URLRequest(url: endpoint)
        request.httpMethod = "POST"
        request.setValue(apiKey, forHTTPHeaderField: "xi-api-key")
        request.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")

        var body = Data()
        // model_id field
        body.appendMultipartField(name: "model_id", value: modelId, boundary: boundary)
        // language_code field (optional)
        if let languageCode, !languageCode.isEmpty {
            body.appendMultipartField(name: "language_code", value: languageCode, boundary: boundary)
        }
        // file field
        body.append("--\(boundary)\r\n".data(using: .utf8)!)
        body.append("Content-Disposition: form-data; name=\"file\"; filename=\"audio.wav\"\r\n".data(using: .utf8)!)
        body.append("Content-Type: audio/wav\r\n\r\n".data(using: .utf8)!)
        body.append(wavData)
        body.append("\r\n".data(using: .utf8)!)
        // closing boundary
        body.append("--\(boundary)--\r\n".data(using: .utf8)!)
        request.httpBody = body
        request.timeoutInterval = 30

        let (data, response) = try await URLSession.shared.data(for: request)
        guard let httpResponse = response as? HTTPURLResponse else {
            throw NSError(domain: "ElevenLabsSTT", code: -1, userInfo: [
                NSLocalizedDescriptionKey: "Invalid response",
            ])
        }
        guard httpResponse.statusCode == 200 else {
            let detail = String(data: data, encoding: .utf8) ?? "unknown error"
            throw NSError(domain: "ElevenLabsSTT", code: httpResponse.statusCode, userInfo: [
                NSLocalizedDescriptionKey: "STT failed (\(httpResponse.statusCode)): \(detail)",
            ])
        }

        struct STTResponse: Decodable { let text: String }
        let decoded = try JSONDecoder().decode(STTResponse.self, from: data)
        return decoded.text
    }
}

private extension Data {
    mutating func appendMultipartField(name: String, value: String, boundary: String) {
        self.append("--\(boundary)\r\n".data(using: .utf8)!)
        self.append("Content-Disposition: form-data; name=\"\(name)\"\r\n\r\n".data(using: .utf8)!)
        self.append("\(value)\r\n".data(using: .utf8)!)
    }
}
