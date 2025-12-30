import Foundation

public struct ElevenLabsVoice: Decodable, Sendable {
    public let voiceId: String
    public let name: String?

    enum CodingKeys: String, CodingKey {
        case voiceId = "voice_id"
        case name
    }
}

public struct ElevenLabsTTSRequest: Sendable {
    public var text: String
    public var modelId: String?
    public var outputFormat: String?
    public var speed: Double?
    public var stability: Double?
    public var similarity: Double?
    public var style: Double?
    public var speakerBoost: Bool?
    public var seed: UInt32?
    public var normalize: String?
    public var language: String?
    public var latencyTier: Int?

    public init(
        text: String,
        modelId: String? = nil,
        outputFormat: String? = nil,
        speed: Double? = nil,
        stability: Double? = nil,
        similarity: Double? = nil,
        style: Double? = nil,
        speakerBoost: Bool? = nil,
        seed: UInt32? = nil,
        normalize: String? = nil,
        language: String? = nil,
        latencyTier: Int? = nil)
    {
        self.text = text
        self.modelId = modelId
        self.outputFormat = outputFormat
        self.speed = speed
        self.stability = stability
        self.similarity = similarity
        self.style = style
        self.speakerBoost = speakerBoost
        self.seed = seed
        self.normalize = normalize
        self.language = language
        self.latencyTier = latencyTier
    }
}

public struct ElevenLabsTTSClient: Sendable {
    public var apiKey: String
    public var requestTimeoutSeconds: TimeInterval
    public var listVoicesTimeoutSeconds: TimeInterval
    public var baseUrl: URL

    public init(
        apiKey: String,
        requestTimeoutSeconds: TimeInterval = 45,
        listVoicesTimeoutSeconds: TimeInterval = 15,
        baseUrl: URL = URL(string: "https://api.elevenlabs.io")!)
    {
        self.apiKey = apiKey
        self.requestTimeoutSeconds = requestTimeoutSeconds
        self.listVoicesTimeoutSeconds = listVoicesTimeoutSeconds
        self.baseUrl = baseUrl
    }

    public func synthesizeWithHardTimeout(
        voiceId: String,
        request: ElevenLabsTTSRequest,
        hardTimeoutSeconds: TimeInterval) async throws -> Data
    {
        try await withThrowingTaskGroup(of: Data.self) { group in
            group.addTask {
                try await self.synthesize(voiceId: voiceId, request: request)
            }
            group.addTask {
                try await Task.sleep(nanoseconds: UInt64(hardTimeoutSeconds * 1_000_000_000))
                throw NSError(domain: "ElevenLabsTTS", code: 408, userInfo: [
                    NSLocalizedDescriptionKey: "ElevenLabs TTS timed out after \(hardTimeoutSeconds)s",
                ])
            }
            let data = try await group.next()!
            group.cancelAll()
            return data
        }
    }

    public func synthesize(voiceId: String, request: ElevenLabsTTSRequest) async throws -> Data {
        var url = self.baseUrl
        url.appendPathComponent("v1")
        url.appendPathComponent("text-to-speech")
        url.appendPathComponent(voiceId)

        let body = try JSONSerialization.data(withJSONObject: Self.buildPayload(request), options: [])

        var lastError: Error?
        for attempt in 0..<3 {
            var req = URLRequest(url: url)
            req.httpMethod = "POST"
            req.httpBody = body
            req.timeoutInterval = self.requestTimeoutSeconds
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            req.setValue("audio/mpeg", forHTTPHeaderField: "Accept")
            req.setValue(self.apiKey, forHTTPHeaderField: "xi-api-key")

            do {
                let (data, response) = try await URLSession.shared.data(for: req)
                if let http = response as? HTTPURLResponse {
                    let contentType = (http.value(forHTTPHeaderField: "Content-Type") ?? "unknown").lowercased()
                    if http.statusCode == 429 || http.statusCode >= 500 {
                        let message = Self.truncatedErrorBody(data)
                        lastError = NSError(domain: "ElevenLabsTTS", code: http.statusCode, userInfo: [
                            NSLocalizedDescriptionKey: "ElevenLabs retryable failure: \(http.statusCode) ct=\(contentType) \(message)",
                        ])
                        if attempt < 2 {
                            let retryAfter = Double(http.value(forHTTPHeaderField: "Retry-After") ?? "")
                            let baseDelay = [0.25, 0.75, 1.5][attempt]
                            let delaySeconds = max(baseDelay, retryAfter ?? 0)
                            try? await Task.sleep(nanoseconds: UInt64(delaySeconds * 1_000_000_000))
                            continue
                        }
                        throw lastError!
                    }

                    if http.statusCode >= 400 {
                        let message = Self.truncatedErrorBody(data)
                        throw NSError(domain: "ElevenLabsTTS", code: http.statusCode, userInfo: [
                            NSLocalizedDescriptionKey: "ElevenLabs failed: \(http.statusCode) ct=\(contentType) \(message)",
                        ])
                    }

                    if !contentType.contains("audio") {
                        let message = Self.truncatedErrorBody(data)
                        throw NSError(domain: "ElevenLabsTTS", code: 415, userInfo: [
                            NSLocalizedDescriptionKey: "ElevenLabs returned non-audio ct=\(contentType) \(message)",
                        ])
                    }
                }
                return data
            } catch {
                lastError = error
                if attempt < 2 {
                    try? await Task.sleep(nanoseconds: UInt64([0.25, 0.75, 1.5][attempt] * 1_000_000_000))
                    continue
                }
                throw error
            }
        }
        throw lastError ?? NSError(domain: "ElevenLabsTTS", code: 1, userInfo: [
            NSLocalizedDescriptionKey: "ElevenLabs failed",
        ])
    }

    public func streamSynthesize(
        voiceId: String,
        request: ElevenLabsTTSRequest) -> AsyncThrowingStream<Data, Error>
    {
        AsyncThrowingStream { continuation in
            let task = Task {
                do {
                    let url = Self.streamingURL(
                        baseUrl: self.baseUrl,
                        voiceId: voiceId,
                        latencyTier: request.latencyTier)
                    let body = try JSONSerialization.data(withJSONObject: Self.buildPayload(request), options: [])

                    var req = URLRequest(url: url)
                    req.httpMethod = "POST"
                    req.httpBody = body
                    req.timeoutInterval = self.requestTimeoutSeconds
                    req.setValue("application/json", forHTTPHeaderField: "Content-Type")
                    req.setValue("audio/mpeg", forHTTPHeaderField: "Accept")
                    req.setValue(self.apiKey, forHTTPHeaderField: "xi-api-key")

                    let (bytes, response) = try await URLSession.shared.bytes(for: req)
                    guard let http = response as? HTTPURLResponse else {
                        throw NSError(domain: "ElevenLabsTTS", code: 1, userInfo: [
                            NSLocalizedDescriptionKey: "ElevenLabs invalid response",
                        ])
                    }

                    let contentType = (http.value(forHTTPHeaderField: "Content-Type") ?? "unknown").lowercased()
                    if http.statusCode >= 400 {
                        let message = try await Self.readErrorBody(bytes: bytes)
                        throw NSError(domain: "ElevenLabsTTS", code: http.statusCode, userInfo: [
                            NSLocalizedDescriptionKey: "ElevenLabs failed: \(http.statusCode) ct=\(contentType) \(message)",
                        ])
                    }
                    if !contentType.contains("audio") {
                        let message = try await Self.readErrorBody(bytes: bytes)
                        throw NSError(domain: "ElevenLabsTTS", code: 415, userInfo: [
                            NSLocalizedDescriptionKey: "ElevenLabs returned non-audio ct=\(contentType) \(message)",
                        ])
                    }

                    var buffer = Data()
                    buffer.reserveCapacity(16_384)
                    for try await byte in bytes {
                        buffer.append(byte)
                        if buffer.count >= 8_192 {
                            continuation.yield(buffer)
                            buffer.removeAll(keepingCapacity: true)
                        }
                    }
                    if !buffer.isEmpty {
                        continuation.yield(buffer)
                    }
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

    public func listVoices() async throws -> [ElevenLabsVoice] {
        var url = self.baseUrl
        url.appendPathComponent("v1")
        url.appendPathComponent("voices")

        var req = URLRequest(url: url)
        req.httpMethod = "GET"
        req.timeoutInterval = self.listVoicesTimeoutSeconds
        req.setValue(self.apiKey, forHTTPHeaderField: "xi-api-key")

        let (data, response) = try await URLSession.shared.data(for: req)
        if let http = response as? HTTPURLResponse, http.statusCode >= 400 {
            let message = Self.truncatedErrorBody(data)
            throw NSError(domain: "ElevenLabsTTS", code: http.statusCode, userInfo: [
                NSLocalizedDescriptionKey: "ElevenLabs voices failed: \(http.statusCode) \(message)",
            ])
        }

        struct VoicesResponse: Decodable { let voices: [ElevenLabsVoice] }
        return try JSONDecoder().decode(VoicesResponse.self, from: data).voices
    }

    public static func validatedOutputFormat(_ value: String?) -> String? {
        let trimmed = (value ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        guard trimmed.hasPrefix("mp3_") || trimmed.hasPrefix("pcm_") else { return nil }
        return trimmed
    }

    public static func validatedLanguage(_ value: String?) -> String? {
        let normalized = (value ?? "").trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard normalized.count == 2, normalized.allSatisfy({ $0 >= "a" && $0 <= "z" }) else { return nil }
        return normalized
    }

    public static func validatedNormalize(_ value: String?) -> String? {
        let normalized = (value ?? "").trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard ["auto", "on", "off"].contains(normalized) else { return nil }
        return normalized
    }

    private static func buildPayload(_ request: ElevenLabsTTSRequest) -> [String: Any] {
        var payload: [String: Any] = ["text": request.text]
        if let modelId = request.modelId?.trimmingCharacters(in: .whitespacesAndNewlines), !modelId.isEmpty {
            payload["model_id"] = modelId
        }
        if let outputFormat = request.outputFormat?.trimmingCharacters(in: .whitespacesAndNewlines), !outputFormat.isEmpty {
            payload["output_format"] = outputFormat
        }
        if let seed = request.seed {
            payload["seed"] = seed
        }
        if let normalize = request.normalize {
            payload["apply_text_normalization"] = normalize
        }
        if let language = request.language {
            payload["language_code"] = language
        }

        var voiceSettings: [String: Any] = [:]
        if let speed = request.speed { voiceSettings["speed"] = speed }
        if let stability = request.stability { voiceSettings["stability"] = stability }
        if let similarity = request.similarity { voiceSettings["similarity_boost"] = similarity }
        if let style = request.style { voiceSettings["style"] = style }
        if let speakerBoost = request.speakerBoost { voiceSettings["use_speaker_boost"] = speakerBoost }
        if !voiceSettings.isEmpty {
            payload["voice_settings"] = voiceSettings
        }
        return payload
    }

    private static func truncatedErrorBody(_ data: Data) -> String {
        let raw = String(data: data.prefix(4096), encoding: .utf8) ?? "unknown"
        return raw.replacingOccurrences(of: "\n", with: " ").replacingOccurrences(of: "\r", with: " ")
    }

    private static func streamingURL(baseUrl: URL, voiceId: String, latencyTier: Int?) -> URL {
        var url = baseUrl
        url.appendPathComponent("v1")
        url.appendPathComponent("text-to-speech")
        url.appendPathComponent(voiceId)
        url.appendPathComponent("stream")

        guard let latencyTier else { return url }
        let latencyItem = URLQueryItem(
            name: "optimize_streaming_latency",
            value: "\(latencyTier)")
        guard var components = URLComponents(url: url, resolvingAgainstBaseURL: false) else {
            return url
        }
        var items = components.queryItems ?? []
        items.append(latencyItem)
        components.queryItems = items
        return components.url ?? url
    }

    private static func readErrorBody(bytes: URLSession.AsyncBytes) async throws -> String {
        var data = Data()
        for try await byte in bytes {
            data.append(byte)
            if data.count >= 4096 { break }
        }
        return truncatedErrorBody(data)
    }
}
