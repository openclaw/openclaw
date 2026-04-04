import Foundation

public enum MistralTTSError: Error, LocalizedError {
    case invalidBaseUrl(String)
    case requestFailed(status: Int, message: String)
    case decodingFailed(Error)
    case missingAudioData

    public var errorDescription: String? {
        switch self {
        case .invalidBaseUrl(let url):
            return "Invalid Mistral base URL: \(url)"
        case .requestFailed(let status, let message):
            return "Mistral API error (\(status)): \(message)"
        case .decodingFailed(let error):
            return "Failed to decode Mistral response: \(error.localizedDescription)"
        case .missingAudioData:
            return "Mistral TTS response missing or invalid audio_data"
        }
    }
}

public struct MistralTTSVoice: Codable, Sendable {
    public let id: String
    public let name: String?
    public let slug: String?
    public let languages: [String]?

    public init(id: String, name: String?, slug: String? = nil, languages: [String]? = nil) {
        self.id = id
        self.name = name
        self.slug = slug
        self.languages = languages
    }
}

public struct MistralVoicesResponse: Codable, Sendable {
    public let items: [MistralTTSVoice]
}

public struct MistralTTSRequest: Codable, Sendable {
    public let text: String
    public let modelId: String
    public let voiceId: String?
    public let speed: Double?
    public let responseFormat: String
    
    enum CodingKeys: String, CodingKey {
        case text = "input"
        case modelId = "model"
        case voiceId = "voice"
        case speed
        case responseFormat = "response_format"
    }

    public init(text: String, modelId: String, voiceId: String?, speed: Double?, responseFormat: String) {
        self.text = text
        self.modelId = modelId
        self.voiceId = voiceId
        self.speed = speed
        self.responseFormat = responseFormat
    }
}

private struct MistralTTSResponse: Codable {
    let audio_data: String?
}

public actor MistralTTSClient {
    public static let defaultModelId = "voxtral-mini-tts-2603"
    public static let defaultVoiceId = "1024d823-a11e-43ee-bf3d-d440dccc0577" // Paul - Happy
    public static let defaultOutputFormat = "mp3"
    
    private let apiKey: String
    private let baseUrl: String
    private var cachedVoices: [MistralTTSVoice]?

    public init(apiKey: String, baseUrl: String = "https://api.mistral.ai/v1") {
        self.apiKey = apiKey
        self.baseUrl = baseUrl
    }

    public func clearCache() {
        self.cachedVoices = nil
    }

    public func resolveVoiceId(requested: String, fallback: String? = nil) async throws -> String? {
        if requested.isEmpty {
            return fallback
        }
        
        // Step 1: Already a UUID?
        if requested.count >= 32 && requested.contains("-") {
            return requested
        }
        
        // Step 2: Slug match
        let voices = try await self.listVoices()
        if let matched = voices.first(where: { $0.slug == requested }) {
            return matched.id
        }
        
        return fallback
    }

    public func listVoices() async throws -> [MistralTTSVoice] {
        if let cached = cachedVoices {
            return cached
        }
        
        guard var url = URL(string: self.baseUrl), url.scheme != nil else {
            throw MistralTTSError.invalidBaseUrl(self.baseUrl)
        }
        url.appendPathComponent("audio/voices")
        
        if var components = URLComponents(url: url, resolvingAgainstBaseURL: false) {
            components.queryItems = [URLQueryItem(name: "limit", value: "100")]
            if let finalUrl = components.url {
                url = finalUrl
            }
        }
        
        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        request.addValue("Bearer \(self.apiKey)", forHTTPHeaderField: "Authorization")
        
        let (data, response) = try await URLSession.shared.data(for: request)
        
        guard let httpResponse = response as? HTTPURLResponse, httpResponse.statusCode == 200 else {
            let status = (response as? HTTPURLResponse)?.statusCode ?? 0
            let errorMsg = String(data: data, encoding: .utf8) ?? "Unknown error"
            throw MistralTTSError.requestFailed(status: status, message: errorMsg)
        }
        
        do {
            let decoded = try JSONDecoder().decode(MistralVoicesResponse.self, from: data)
            self.cachedVoices = decoded.items
            return decoded.items
        } catch {
            throw MistralTTSError.decodingFailed(error)
        }
    }

    /// Returns an asynchronous stream of audio data.
    /// Note: Mistral TTS currently provides a single-shot response in JSON.
    /// This method wraps it in an AsyncThrowingStream for compatibility with streaming players.
    public func streamSynthesize(voiceId: String?, request: MistralTTSRequest) -> AsyncThrowingStream<Data, Error> {
        AsyncThrowingStream { continuation in
            Task {
                do {
                    guard var url = URL(string: self.baseUrl), url.scheme != nil else {
                        throw MistralTTSError.invalidBaseUrl(self.baseUrl)
                    }
                    url.appendPathComponent("audio/speech")
                    
                    var urlRequest = URLRequest(url: url)
                    urlRequest.httpMethod = "POST"
                    urlRequest.addValue("Bearer \(self.apiKey)", forHTTPHeaderField: "Authorization")
                    urlRequest.addValue("application/json", forHTTPHeaderField: "Content-Type")
                    
                    let body = try JSONEncoder().encode(request)
                    urlRequest.httpBody = body
                    
                    let (data, response) = try await URLSession.shared.data(for: urlRequest)
                    
                    guard let httpResponse = response as? HTTPURLResponse, httpResponse.statusCode == 200 else {
                        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
                        let errorMsg = String(data: data, encoding: .utf8) ?? "Unknown error"
                        throw MistralTTSError.requestFailed(status: status, message: errorMsg)
                    }
                    
                    let decoded = try JSONDecoder().decode(MistralTTSResponse.self, from: data)
                    guard let audioBase64 = decoded.audio_data,
                          let audioData = Data(base64Encoded: audioBase64) else {
                        throw MistralTTSError.missingAudioData
                    }
                    
                    continuation.yield(audioData)
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
        }
    }
}
