import Foundation
import OSLog

/// WebSocket client for ElevenLabs Realtime Speech-to-Text API.
/// Streams Int16 PCM audio chunks and receives partial/committed transcripts.
@MainActor
final class ElevenLabsRealtimeSTTClient {
    enum TranscriptKind { case partial, committed }

    var onTranscript: ((String, TranscriptKind) -> Void)?
    var onError: ((Error) -> Void)?
    private(set) var isConnected: Bool = false

    private let apiKey: String
    private let modelId: String
    private let languageCode: String
    private let sampleRate: Int
    private var webSocketTask: URLSessionWebSocketTask?
    private var receiveTask: Task<Void, Never>?
    private let logger = Logger(subsystem: "ai.openclaw", category: "RealtimeSTT")

    init(apiKey: String, modelId: String = "scribe_v2_realtime", languageCode: String = "", sampleRate: Int = 48000) {
        self.apiKey = apiKey
        self.modelId = modelId
        self.languageCode = languageCode
        self.sampleRate = sampleRate
    }

    func connect() {
        guard self.webSocketTask == nil else { return }

        var components = URLComponents(string: "wss://api.elevenlabs.io/v1/speech-to-text/realtime")!
        components.queryItems = [
            URLQueryItem(name: "model_id", value: self.modelId),
            URLQueryItem(name: "audio_format", value: "pcm_\(self.sampleRate)"),
            URLQueryItem(name: "commit_strategy", value: "manual"),
        ]
        if !self.languageCode.isEmpty {
            components.queryItems?.append(URLQueryItem(name: "language_code", value: self.languageCode))
        }

        var request = URLRequest(url: components.url!)
        request.setValue(self.apiKey, forHTTPHeaderField: "xi-api-key")

        let task = URLSession.shared.webSocketTask(with: request)
        self.webSocketTask = task
        task.resume()
        self.isConnected = true
        self.logger.info("websocket connecting model=\(self.modelId, privacy: .public)")

        self.receiveTask = Task { [weak self] in
            await self?.receiveLoop()
        }
    }

    /// Sends Int16 PCM audio data as a base64-encoded chunk.
    func sendAudio(_ int16Data: Data) {
        guard let task = self.webSocketTask, self.isConnected else { return }
        let base64 = int16Data.base64EncodedString()
        let json = "{\"message_type\":\"input_audio_chunk\",\"audio_base_64\":\"\(base64)\"}"
        task.send(.string(json)) { [weak self] error in
            if let error {
                self?.logger.warning("send error: \(error.localizedDescription, privacy: .public)")
            }
        }
    }

    /// Sends a commit message to finalize the current transcript.
    func commit() {
        guard let task = self.webSocketTask, self.isConnected else { return }
        let json = "{\"message_type\":\"commit\"}"
        task.send(.string(json)) { [weak self] error in
            if let error {
                self?.logger.warning("commit send error: \(error.localizedDescription, privacy: .public)")
            }
        }
    }

    func disconnect() {
        self.receiveTask?.cancel()
        self.receiveTask = nil
        self.webSocketTask?.cancel(with: .normalClosure, reason: nil)
        self.webSocketTask = nil
        self.isConnected = false
        self.logger.info("websocket disconnected")
    }

    // MARK: - Private

    private func receiveLoop() async {
        guard let task = self.webSocketTask else { return }
        while !Task.isCancelled {
            do {
                let message = try await task.receive()
                switch message {
                case .string(let text):
                    self.handleMessage(text)
                case .data(let data):
                    if let text = String(data: data, encoding: .utf8) {
                        self.handleMessage(text)
                    }
                @unknown default:
                    break
                }
            } catch {
                if Task.isCancelled { return }
                await MainActor.run {
                    self.isConnected = false
                    self.logger.warning("websocket receive error: \(error.localizedDescription, privacy: .public)")
                    self.onError?(error)
                }
                return
            }
        }
    }

    private struct RealtimeMessage: Decodable {
        let message_type: String
        let text: String?
    }

    private func handleMessage(_ text: String) {
        guard let data = text.data(using: .utf8),
              let msg = try? JSONDecoder().decode(RealtimeMessage.self, from: data)
        else { return }

        switch msg.message_type {
        case "partial_transcript":
            if let transcript = msg.text {
                Task { @MainActor in
                    self.onTranscript?(transcript, .partial)
                }
            }
        case "committed_transcript":
            if let transcript = msg.text {
                Task { @MainActor in
                    self.onTranscript?(transcript, .committed)
                }
            }
        default:
            break
        }
    }
}
