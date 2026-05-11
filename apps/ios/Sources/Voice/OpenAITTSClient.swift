import Foundation

struct OpenAITTSRequest {
    let text: String
    let modelId: String
    let voiceId: String
    let responseFormat: String
    let speed: Double?
    let instructions: String?
}

final class OpenAITTSClient: Sendable {
    private let apiKey: String
    private let baseURL: URL

    init(apiKey: String, baseURL: URL = URL(string: "https://api.openai.com/v1")!) {
        self.apiKey = apiKey
        self.baseURL = baseURL
    }

    func synthesize(request: OpenAITTSRequest) async throws -> Data {
        let url = self.baseURL.appendingPathComponent("audio/speech")
        var urlRequest = URLRequest(url: url)
        urlRequest.httpMethod = "POST"
        urlRequest.setValue("Bearer \(self.apiKey)", forHTTPHeaderField: "Authorization")
        urlRequest.setValue("application/json", forHTTPHeaderField: "Content-Type")

        var body: [String: Any] = [
            "model": request.modelId,
            "input": request.text,
            "voice": request.voiceId,
            "response_format": request.responseFormat,
        ]
        if let speed = request.speed {
            body["speed"] = speed
        }
        if let instructions = request.instructions?.trimmingCharacters(in: .whitespacesAndNewlines),
           !instructions.isEmpty
        {
            body["instructions"] = instructions
        }
        urlRequest.httpBody = try JSONSerialization.data(withJSONObject: body)

        let (data, response) = try await URLSession.shared.data(for: urlRequest)
        guard let http = response as? HTTPURLResponse else {
            throw NSError(domain: "OpenAITTS", code: -1, userInfo: [
                NSLocalizedDescriptionKey: "OpenAI TTS returned a non-HTTP response.",
            ])
        }
        guard (200..<300).contains(http.statusCode) else {
            let message = String(data: data, encoding: .utf8) ?? HTTPURLResponse
                .localizedString(forStatusCode: http.statusCode)
            throw NSError(domain: "OpenAITTS", code: http.statusCode, userInfo: [
                NSLocalizedDescriptionKey: "OpenAI TTS failed: \(message)",
            ])
        }
        return data
    }

    func streamSynthesize(request: OpenAITTSRequest) -> AsyncThrowingStream<Data, Error> {
        AsyncThrowingStream { continuation in
            let task = Task {
                do {
                    let data = try await self.synthesize(request: request)
                    continuation.yield(data)
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
}
