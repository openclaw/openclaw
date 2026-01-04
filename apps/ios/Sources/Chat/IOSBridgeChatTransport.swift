import ClawdbotChatUI
import ClawdbotKit
import Foundation

struct IOSBridgeChatTransport: ClawdbotChatTransport, Sendable {
    private let bridge: BridgeSession

    init(bridge: BridgeSession) {
        self.bridge = bridge
    }

    func abortRun(sessionKey: String, runId: String) async throws {
        struct Params: Codable {
            var sessionKey: String
            var runId: String
        }
        let data = try JSONEncoder().encode(Params(sessionKey: sessionKey, runId: runId))
        let json = String(data: data, encoding: .utf8)
        _ = try await self.bridge.request(method: "chat.abort", paramsJSON: json, timeoutSeconds: 10)
    }

    func listSessions(limit: Int?) async throws -> ClawdbotChatSessionsListResponse {
        struct Params: Codable {
            var includeGlobal: Bool
            var includeUnknown: Bool
            var limit: Int?
        }
        let data = try JSONEncoder().encode(Params(includeGlobal: true, includeUnknown: false, limit: limit))
        let json = String(data: data, encoding: .utf8)
        let res = try await self.bridge.request(method: "sessions.list", paramsJSON: json, timeoutSeconds: 15)
        return try JSONDecoder().decode(ClawdbotChatSessionsListResponse.self, from: res)
    }

    func setActiveSessionKey(_ sessionKey: String) async throws {
        struct Subscribe: Codable { var sessionKey: String }
        let data = try JSONEncoder().encode(Subscribe(sessionKey: sessionKey))
        let json = String(data: data, encoding: .utf8)
        try await self.bridge.sendEvent(event: "chat.subscribe", payloadJSON: json)
    }

    func requestHistory(sessionKey: String) async throws -> ClawdbotChatHistoryPayload {
        struct Params: Codable { var sessionKey: String }
        let data = try JSONEncoder().encode(Params(sessionKey: sessionKey))
        let json = String(data: data, encoding: .utf8)
        let res = try await self.bridge.request(method: "chat.history", paramsJSON: json, timeoutSeconds: 15)
        return try JSONDecoder().decode(ClawdbotChatHistoryPayload.self, from: res)
    }

    func sendMessage(
        sessionKey: String,
        message: String,
        thinking: String,
        idempotencyKey: String,
        attachments: [ClawdbotChatAttachmentPayload]) async throws -> ClawdbotChatSendResponse
    {
        struct Params: Codable {
            var sessionKey: String
            var message: String
            var thinking: String
            var attachments: [ClawdbotChatAttachmentPayload]?
            var timeoutMs: Int
            var idempotencyKey: String
        }

        let params = Params(
            sessionKey: sessionKey,
            message: message,
            thinking: thinking,
            attachments: attachments.isEmpty ? nil : attachments,
            timeoutMs: 30000,
            idempotencyKey: idempotencyKey)
        let data = try JSONEncoder().encode(params)
        let json = String(data: data, encoding: .utf8)
        let res = try await self.bridge.request(method: "chat.send", paramsJSON: json, timeoutSeconds: 35)
        return try JSONDecoder().decode(ClawdbotChatSendResponse.self, from: res)
    }

    func requestHealth(timeoutMs: Int) async throws -> Bool {
        let seconds = max(1, Int(ceil(Double(timeoutMs) / 1000.0)))
        let res = try await self.bridge.request(method: "health", paramsJSON: nil, timeoutSeconds: seconds)
        return (try? JSONDecoder().decode(ClawdbotGatewayHealthOK.self, from: res))?.ok ?? true
    }

    func events() -> AsyncStream<ClawdbotChatTransportEvent> {
        AsyncStream { continuation in
            let task = Task {
                let stream = await self.bridge.subscribeServerEvents()
                for await evt in stream {
                    if Task.isCancelled { return }
                    switch evt.event {
                    case "tick":
                        continuation.yield(.tick)
                    case "seqGap":
                        continuation.yield(.seqGap)
                    case "health":
                        guard let json = evt.payloadJSON, let data = json.data(using: .utf8) else { break }
                        let ok = (try? JSONDecoder().decode(ClawdbotGatewayHealthOK.self, from: data))?.ok ?? true
                        continuation.yield(.health(ok: ok))
                    case "chat":
                        guard let json = evt.payloadJSON, let data = json.data(using: .utf8) else { break }
                        if let payload = try? JSONDecoder().decode(ClawdbotChatEventPayload.self, from: data) {
                            continuation.yield(.chat(payload))
                        }
                    case "agent":
                        guard let json = evt.payloadJSON, let data = json.data(using: .utf8) else { break }
                        if let payload = try? JSONDecoder().decode(ClawdbotAgentEventPayload.self, from: data) {
                            continuation.yield(.agent(payload))
                        }
                    default:
                        break
                    }
                }
            }

            continuation.onTermination = { @Sendable _ in
                task.cancel()
            }
        }
    }
}
