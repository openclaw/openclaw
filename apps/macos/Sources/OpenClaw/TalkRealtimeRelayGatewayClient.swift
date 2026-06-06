import Foundation
import OpenClawKit
import OpenClawProtocol

struct TalkRealtimeRelayGatewayClient: Sendable {
    private let gateway: GatewayConnection

    init(gateway: GatewayConnection = .shared) {
        self.gateway = gateway
    }

    func subscribe(bufferingNewest: Int = 200) async -> AsyncStream<GatewayPush> {
        await self.gateway.subscribe(bufferingNewest: bufferingNewest)
    }

    func createSession(options: TalkRealtimeRelayOptions) async throws -> TalkSessionCreateResult {
        var params: [String: AnyCodable] = [
            "sessionKey": AnyCodable(options.sessionKey),
            "mode": AnyCodable("realtime"),
            "transport": AnyCodable("gateway-relay"),
            "brain": AnyCodable("agent-consult"),
        ]
        Self.addString(options.provider, key: "provider", to: &params)
        Self.addString(options.model, key: "model", to: &params)
        Self.addString(options.voice, key: "voice", to: &params)
        return try await self.requestDecoded(
            method: "talk.session.create",
            params: params,
            timeoutMs: 20_000)
    }

    func appendAudio(sessionId: String, audio: Data, timestampMs: Double) async throws {
        let _: TalkSessionOkResult = try await self.requestDecoded(
            method: "talk.session.appendAudio",
            params: [
                "sessionId": AnyCodable(sessionId),
                "audioBase64": AnyCodable(audio.base64EncodedString()),
                "timestamp": AnyCodable(timestampMs),
            ],
            timeoutMs: 8_000)
    }

    func closeSession(sessionId: String) async {
        let _: TalkSessionOkResult? = try? await self.requestDecoded(
            method: "talk.session.close",
            params: ["sessionId": AnyCodable(sessionId)],
            timeoutMs: 8_000)
    }

    func cancelOutput(sessionId: String, reason: String) async {
        let _: TalkSessionOkResult? = try? await self.requestDecoded(
            method: "talk.session.cancelOutput",
            params: [
                "sessionId": AnyCodable(sessionId),
                "reason": AnyCodable(reason),
            ],
            timeoutMs: 8_000)
    }

    func submitToolResult(sessionId: String, callId: String, result: AnyCodable) async throws {
        let _: TalkSessionOkResult = try await self.requestDecoded(
            method: "talk.session.submitToolResult",
            params: [
                "sessionId": AnyCodable(sessionId),
                "callId": AnyCodable(callId),
                "result": result,
            ],
            timeoutMs: 30_000)
    }

    func steer(sessionId: String, sessionKey: String, text: String, mode: String?) async throws -> AnyCodable {
        var params: [String: AnyCodable] = [
            "sessionId": AnyCodable(sessionId),
            "sessionKey": AnyCodable(sessionKey),
            "text": AnyCodable(text),
        ]
        Self.addString(mode, key: "mode", to: &params)
        return try await self.requestDecoded(
            method: "talk.session.steer",
            params: params,
            timeoutMs: 30_000)
    }

    func startToolCall(
        sessionKey: String,
        sessionId: String,
        callId: String,
        name: String,
        args: AnyCodable) async throws -> TalkRealtimeRelayToolStartResult
    {
        try await self.requestDecoded(
            method: "talk.client.toolCall",
            params: [
                "sessionKey": AnyCodable(sessionKey),
                "relaySessionId": AnyCodable(sessionId),
                "callId": AnyCodable(callId),
                "name": AnyCodable(name),
                "args": args,
            ],
            timeoutMs: 30_000)
    }

    private func requestDecoded<T: Decodable>(
        method: String,
        params: [String: AnyCodable],
        timeoutMs: Double) async throws -> T
    {
        let data = try await self.gateway.requestRaw(
            method: method,
            params: params,
            timeoutMs: timeoutMs)
        return try JSONDecoder().decode(T.self, from: data)
    }

    private static func addString(_ value: String?, key: String, to params: inout [String: AnyCodable]) {
        let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard !trimmed.isEmpty else { return }
        params[key] = AnyCodable(trimmed)
    }
}

struct TalkRealtimeRelayToolStartResult: Decodable, Sendable {
    let runId: String?
    let idempotencyKey: String?
}
