import Foundation
import OpenClawChatUI
import OpenClawKit
import OpenClawProtocol

/// Backs the chat "Listen" action with the gateway `tts.speak` method, which
/// renders text with the operator's configured TTS provider chain.
enum ChatMessageSpeechClient {
    typealias Request = (_ method: String, _ paramsJSON: String?, _ timeoutSeconds: Int) async throws -> Data
    private static let requestTimeoutSeconds = 60

    static func synthesize(
        text: String,
        gateway: GatewayNodeSession) async throws -> OpenClawChatSpeechClip
    {
        try await self.synthesize(text: text) { method, paramsJSON, timeoutSeconds in
            try await gateway.request(
                method: method,
                paramsJSON: paramsJSON,
                timeoutSeconds: timeoutSeconds)
        }
    }

    static func synthesize(
        text: String,
        request: Request) async throws -> OpenClawChatSpeechClip
    {
        let params = TtsSpeakParams(text: text)
        let paramsData = try JSONEncoder().encode(params)
        let paramsJSON = String(bytes: paramsData, encoding: .utf8)!
        let responseData = try await request("tts.speak", paramsJSON, Self.requestTimeoutSeconds)
        return try OpenClawChatGatewayPayloadCodec.decodeSpeechClip(responseData)
    }
}
