import Foundation
import OpenClawChatUI
import OpenClawKit
import OpenClawProtocol

/// Backs the chat "Listen" action with the gateway `tts.speak` method, which
/// renders text with the operator's configured TTS provider chain.
enum ChatMessageSpeechClient {
    private static let requestTimeoutSeconds = 60

    static func synthesize(
        text: String,
        gateway: GatewayNodeSession) async throws -> OpenClawChatSpeechClip
    {
        let params = TtsSpeakParams(text: text)
        let paramsData = try JSONEncoder().encode(params)
        guard let paramsJSON = String(data: paramsData, encoding: .utf8) else {
            throw ChatMessageSpeechError.invalidRequest
        }
        let responseData = try await gateway.request(
            method: "tts.speak",
            paramsJSON: paramsJSON,
            timeoutSeconds: Self.requestTimeoutSeconds)
        let response = try JSONDecoder().decode(TtsSpeakResult.self, from: responseData)
        guard let audioData = Data(base64Encoded: response.audiobase64), !audioData.isEmpty else {
            throw ChatMessageSpeechError.emptyAudio
        }
        return OpenClawChatSpeechClip(data: audioData, mimeType: response.mimetype)
    }
}

private enum ChatMessageSpeechError: LocalizedError {
    case invalidRequest
    case emptyAudio

    var errorDescription: String? {
        switch self {
        case .invalidRequest:
            "Failed to encode tts.speak request"
        case .emptyAudio:
            "Gateway tts.speak returned empty audio"
        }
    }
}
