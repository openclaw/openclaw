import MullusiChatUI
import MullusiKit
import MullusiProtocol
import Foundation
import OSLog

struct IOSGatewayChatTransport: MullusiChatTransport, Sendable {
    private static let logger = Logger(subsystem: "ai.mullusi", category: "ios.chat.transport")
    private let gateway: GatewayNodeSession

    init(gateway: GatewayNodeSession) {
        self.gateway = gateway
    }

    func abortRun(sessionKey: String, runId: String) async throws {
        struct Params: Codable {
            var sessionKey: String
            var runId: String
        }
        let data = try JSONEncoder().encode(Params(sessionKey: sessionKey, runId: runId))
        let json = String(data: data, encoding: .utf8)
        _ = try await self.gateway.request(method: "chat.abort", paramsJSON: json, timeoutSeconds: 10)
    }

    func listSessions(limit: Int?) async throws -> MullusiChatSessionsListResponse {
        struct Params: Codable {
            var includeGlobal: Bool
            var includeUnknown: Bool
            var limit: Int?
        }
        let data = try JSONEncoder().encode(Params(includeGlobal: true, includeUnknown: false, limit: limit))
        let json = String(data: data, encoding: .utf8)
        let res = try await self.gateway.request(method: "sessions.list", paramsJSON: json, timeoutSeconds: 15)
        return try JSONDecoder().decode(MullusiChatSessionsListResponse.self, from: res)
    }

    func setActiveSessionKey(_ sessionKey: String) async throws {
        // Operator clients receive chat events without node-style subscriptions.
        // (chat.subscribe is a node event, not an operator RPC method.)
    }

    func resetSession(sessionKey: String) async throws {
        struct Params: Codable { var key: String }
        let data = try JSONEncoder().encode(Params(key: sessionKey))
        let json = String(data: data, encoding: .utf8)
        _ = try await self.gateway.request(method: "sessions.reset", paramsJSON: json, timeoutSeconds: 10)
    }

    func compactSession(sessionKey: String) async throws {
        struct Params: Codable { var key: String }
        let data = try JSONEncoder().encode(Params(key: sessionKey))
        let json = String(data: data, encoding: .utf8)
        _ = try await self.gateway.request(method: "sessions.compact", paramsJSON: json, timeoutSeconds: 10)
    }

    func requestHistory(sessionKey: String) async throws -> MullusiChatHistoryPayload {
        struct Params: Codable { var sessionKey: String }
        let data = try JSONEncoder().encode(Params(sessionKey: sessionKey))
        let json = String(data: data, encoding: .utf8)
        let res = try await self.gateway.request(method: "chat.history", paramsJSON: json, timeoutSeconds: 15)
        return try JSONDecoder().decode(MullusiChatHistoryPayload.self, from: res)
    }

    func sendMessage(
        sessionKey: String,
        message: String,
        thinking: String,
        idempotencyKey: String,
        attachments: [MullusiChatAttachmentPayload]) async throws -> MullusiChatSendResponse
    {
        let startLogMessage =
            "chat.send start sessionKey=\(sessionKey) "
            + "len=\(message.count) attachments=\(attachments.count)"
        Self.logger.info(
            "\(startLogMessage, privacy: .public)"
        )
        struct Params: Codable {
            var sessionKey: String
            var message: String
            var thinking: String
            var attachments: [MullusiChatAttachmentPayload]?
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
        do {
            let res = try await self.gateway.request(method: "chat.send", paramsJSON: json, timeoutSeconds: 35)
            let decoded = try JSONDecoder().decode(MullusiChatSendResponse.self, from: res)
            Self.logger.info("chat.send ok runId=\(decoded.runId, privacy: .public)")
            return decoded
        } catch {
            Self.logger.error("chat.send failed \(error.localizedDescription, privacy: .public)")
            throw error
        }
    }

    func requestHealth(timeoutMs: Int) async throws -> Bool {
        let seconds = max(1, Int(ceil(Double(timeoutMs) / 1000.0)))
        let res = try await self.gateway.request(method: "health", paramsJSON: nil, timeoutSeconds: seconds)
        return (try? JSONDecoder().decode(MullusiGatewayHealthOK.self, from: res))?.ok ?? true
    }

    func events() -> AsyncStream<MullusiChatTransportEvent> {
        AsyncStream { continuation in
            let task = Task {
                let stream = await self.gateway.subscribeServerEvents()
                for await evt in stream {
                    if Task.isCancelled { return }
                    switch evt.event {
                    case "tick":
                        continuation.yield(.tick)
                    case "seqGap":
                        continuation.yield(.seqGap)
                    case "health":
                        guard let payload = evt.payload else { break }
                        let ok = (try? GatewayPayloadDecoding.decode(
                            payload,
                            as: MullusiGatewayHealthOK.self))?.ok ?? true
                        continuation.yield(.health(ok: ok))
                    case "chat":
                        guard let payload = evt.payload else { break }
                        if let chatPayload = try? GatewayPayloadDecoding.decode(
                            payload,
                            as: MullusiChatEventPayload.self)
                        {
                            continuation.yield(.chat(chatPayload))
                        }
                    case "agent":
                        guard let payload = evt.payload else { break }
                        if let agentPayload = try? GatewayPayloadDecoding.decode(
                            payload,
                            as: MullusiAgentEventPayload.self)
                        {
                            continuation.yield(.agent(agentPayload))
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
