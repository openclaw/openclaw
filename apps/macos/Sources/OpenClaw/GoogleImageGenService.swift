import Foundation
import OSLog

/// Direct Google Gemini API client for image generation.
/// Bypasses the OpenClaw gateway to avoid context bloat and rate limit issues.
@MainActor
final class GoogleImageGenService {
    static let shared = GoogleImageGenService()
    private let logger = Logger(subsystem: "ai.openclaw", category: "GoogleImageGen")

    /// Rate limiting: minimum interval between requests (12s ≈ 5 RPM with safety margin for Tier 1).
    private static let minRequestInterval: TimeInterval = 12
    /// Maximum retry attempts on 429 responses.
    private static let maxRetries = 2
    /// Base backoff duration in seconds (doubles each retry).
    private static let baseBackoff: TimeInterval = 15

    private var lastRequestTime: Date?
    private var inFlight = false

    private var apiKey: String? {
        // Check UserDefaults (set in Settings), then env vars, then .env file
        let stored = UserDefaults.standard.string(forKey: "openclaw.geminiAPIKey")?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        if let stored, !stored.isEmpty { return stored }
        return ProcessInfo.processInfo.environment["GEMINI_API_KEY"]
            ?? ProcessInfo.processInfo.environment["GOOGLE_API_KEY"]
    }

    struct ImageGenResult: Sendable {
        let imageData: Data
        let mimeType: String
        let text: String?
    }

    enum ImageGenError: LocalizedError {
        case noAPIKey
        case invalidResponse(String)
        case rateLimited(retryAfter: String?)
        case apiError(code: Int, message: String)
        case alreadyInFlight

        var errorDescription: String? {
            switch self {
            case .noAPIKey:
                return "No GEMINI_API_KEY or GOOGLE_API_KEY found"
            case let .invalidResponse(msg):
                return "Invalid response: \(msg)"
            case let .rateLimited(retry):
                return "Image generation rate limit reached. Please wait \(retry ?? "~30 seconds") before trying again."
            case let .apiError(code, message):
                return "API error \(code): \(message)"
            case .alreadyInFlight:
                return "An image generation request is already in progress."
            }
        }
    }

    /// Generate or edit an image using the Gemini API directly.
    /// Includes rate limiting (Tier 1: 5 RPM) and exponential backoff on 429s.
    func generate(
        prompt: String,
        model: String,
        inputImage: Data? = nil,
        inputMimeType: String = "image/jpeg",
        resolution: String = "1K",
        aspectRatio: String = "1:1"
    ) async throws -> ImageGenResult {
        // Prevent concurrent requests
        guard !self.inFlight else {
            throw ImageGenError.alreadyInFlight
        }

        guard let apiKey = self.apiKey ?? self.fetchAPIKeyFromGateway() else {
            Self.debugLog("ERROR: No API key found")
            throw ImageGenError.noAPIKey
        }

        self.inFlight = true
        defer { self.inFlight = false }

        Self.debugLog("API key found (length: \(apiKey.count)), model: \(model)")

        // Rate limit: wait if we sent a request too recently
        if let last = self.lastRequestTime {
            let elapsed = Date().timeIntervalSince(last)
            let wait = Self.minRequestInterval - elapsed
            if wait > 0 {
                Self.debugLog("Rate limiting: waiting \(String(format: "%.1f", wait))s")
                self.logger.info("Rate limiting: waiting \(String(format: "%.1f", wait))s before next request")
                try await Task.sleep(nanoseconds: UInt64(wait * 1_000_000_000))
            }
        }

        let modelID = model.replacingOccurrences(of: "google/", with: "")
        Self.debugLog("Resolved modelID: \(modelID)")
        let request = try self.buildRequest(
            modelID: modelID, apiKey: apiKey, prompt: prompt,
            inputImage: inputImage, inputMimeType: inputMimeType,
            resolution: resolution, aspectRatio: aspectRatio)

        // Attempt with retries on 429
        var lastRetryAfter: String?
        for attempt in 0...Self.maxRetries {
            if attempt > 0 {
                let backoff = Self.baseBackoff * pow(2.0, Double(attempt - 1))
                Self.debugLog("Rate limited, backing off \(String(format: "%.0f", backoff))s (attempt \(attempt)/\(Self.maxRetries))")
                self.logger.warning("Rate limited (attempt \(attempt)/\(Self.maxRetries)). Backing off \(String(format: "%.0f", backoff))s")
                try await Task.sleep(nanoseconds: UInt64(backoff * 1_000_000_000))
            }

            self.lastRequestTime = Date()
            Self.debugLog("Sending request (attempt \(attempt + 1))...")
            self.logger.info("Sending image gen request to \(modelID) (attempt \(attempt + 1))")

            let (data, response) = try await URLSession.shared.data(for: request)
            guard let httpResponse = response as? HTTPURLResponse else {
                Self.debugLog("ERROR: Not an HTTP response")
                throw ImageGenError.invalidResponse("Not an HTTP response")
            }

            Self.debugLog("Response status: \(httpResponse.statusCode), body size: \(data.count) bytes")
            if data.count < 2000 {
                Self.debugLog("Response body: \(String(data: data, encoding: .utf8) ?? "<binary>")")
            }

            if httpResponse.statusCode == 429 {
                lastRetryAfter = self.parseRetryAfter(from: data)
                Self.debugLog("429 Rate limited. retryAfter: \(lastRetryAfter ?? "nil")")
                if attempt < Self.maxRetries {
                    continue  // retry with backoff
                }
                throw ImageGenError.rateLimited(retryAfter: lastRetryAfter)
            }

            guard httpResponse.statusCode == 200 else {
                let errorMsg = self.parseErrorMessage(from: data)
                Self.debugLog("ERROR: HTTP \(httpResponse.statusCode): \(errorMsg)")
                throw ImageGenError.apiError(code: httpResponse.statusCode, message: errorMsg)
            }

            Self.debugLog("SUCCESS! Parsing response...")
            return try self.parseResponse(data)
        }

        throw ImageGenError.rateLimited(retryAfter: lastRetryAfter)
    }

    private func buildRequest(
        modelID: String, apiKey: String, prompt: String,
        inputImage: Data?, inputMimeType: String,
        resolution: String, aspectRatio: String
    ) throws -> URLRequest {
        let url = URL(string: "https://generativelanguage.googleapis.com/v1beta/models/\(modelID):generateContent?key=\(apiKey)")!

        var parts: [[String: Any]] = []
        parts.append(["text": prompt])

        if let imageData = inputImage {
            parts.append([
                "inlineData": [
                    "mimeType": inputMimeType,
                    "data": imageData.base64EncodedString()
                ]
            ])
        }

        // Map resolution string to Gemini imageSize values
        let imageSize: String
        switch resolution {
        case "0.5K": imageSize = "512"
        case "2K":   imageSize = "2K"
        case "4K":   imageSize = "4K"
        default:     imageSize = "1K"
        }

        Self.debugLog("Image config: imageSize=\(imageSize), aspectRatio=\(aspectRatio)")

        let body: [String: Any] = [
            "contents": [
                ["parts": parts]
            ],
            "generationConfig": [
                "responseModalities": ["TEXT", "IMAGE"],
                "imageConfig": [
                    "imageSize": imageSize,
                    "aspectRatio": aspectRatio,
                ]
            ]
        ]

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.timeoutInterval = 120
        request.httpBody = try JSONSerialization.data(withJSONObject: body)
        return request
    }

    // MARK: - Debug

    private static func debugLog(_ msg: String) {
        let line = "[\(ISO8601DateFormatter().string(from: Date()))] [GoogleImageGen] \(msg)\n"
        if let data = line.data(using: .utf8),
           let handle = FileHandle(forWritingAtPath: "/tmp/openclaw-debug.log") {
            handle.seekToEndOfFile()
            handle.write(data)
            handle.closeFile()
        } else {
            FileManager.default.createFile(atPath: "/tmp/openclaw-debug.log", contents: line.data(using: .utf8))
        }
    }

    // MARK: - Private

    private func fetchAPIKeyFromGateway() -> String? {
        // Try to read from the gateway's .env file
        let envPath = NSString("~/.openclaw/.env").expandingTildeInPath
        guard let envContent = try? String(contentsOfFile: envPath, encoding: .utf8) else { return nil }
        for line in envContent.components(separatedBy: .newlines) {
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            if trimmed.hasPrefix("GEMINI_API_KEY=") {
                return String(trimmed.dropFirst("GEMINI_API_KEY=".count))
            }
            if trimmed.hasPrefix("GOOGLE_API_KEY=") {
                return String(trimmed.dropFirst("GOOGLE_API_KEY=".count))
            }
        }
        return nil
    }

    private func parseResponse(_ data: Data) throws -> ImageGenResult {
        guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let candidates = json["candidates"] as? [[String: Any]],
              let first = candidates.first
        else {
            throw ImageGenError.invalidResponse("Could not parse candidates")
        }

        // Check for safety/content filters before trying to parse image data
        if let finishReason = first["finishReason"] as? String, finishReason != "STOP" {
            let message = first["finishMessage"] as? String
                ?? "Image blocked by Google (\(finishReason)). Try a different prompt."
            throw ImageGenError.invalidResponse(message)
        }

        guard let content = first["content"] as? [String: Any],
              let parts = content["parts"] as? [[String: Any]]
        else {
            throw ImageGenError.invalidResponse("Response contained no image data")
        }

        var imageData: Data?
        var mimeType = "image/jpeg"
        var text: String?

        for part in parts {
            if let inlineData = part["inlineData"] as? [String: Any],
               let base64 = inlineData["data"] as? String,
               let decoded = Data(base64Encoded: base64)
            {
                imageData = decoded
                mimeType = (inlineData["mimeType"] as? String) ?? "image/jpeg"
            }
            if let t = part["text"] as? String {
                text = t
            }
        }

        guard let resultImage = imageData else {
            throw ImageGenError.invalidResponse(text ?? "No image in response")
        }

        self.logger.info("Image generated: \(resultImage.count) bytes, \(mimeType)")
        return ImageGenResult(imageData: resultImage, mimeType: mimeType, text: text)
    }

    private func parseRetryAfter(from data: Data) -> String? {
        guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let error = json["error"] as? [String: Any],
              let details = error["details"] as? [[String: Any]]
        else { return nil }

        for detail in details {
            if let retryInfo = detail["retryDelay"] as? String {
                return retryInfo
            }
        }
        return nil
    }

    private func parseErrorMessage(from data: Data) -> String {
        guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let error = json["error"] as? [String: Any],
              let message = error["message"] as? String
        else { return "Unknown error" }
        return String(message.prefix(300))
    }
}
