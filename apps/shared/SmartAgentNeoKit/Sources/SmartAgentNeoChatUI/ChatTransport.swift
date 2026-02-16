import Foundation

public enum SmartAgentNeoChatTransportEvent: Sendable {
    case health(ok: Bool)
    case tick
    case chat(SmartAgentNeoChatEventPayload)
    case agent(SmartAgentNeoAgentEventPayload)
    case seqGap
}

public protocol SmartAgentNeoChatTransport: Sendable {
    func requestHistory(sessionKey: String) async throws -> SmartAgentNeoChatHistoryPayload
    func sendMessage(
        sessionKey: String,
        message: String,
        thinking: String,
        idempotencyKey: String,
        attachments: [SmartAgentNeoChatAttachmentPayload]) async throws -> SmartAgentNeoChatSendResponse

    func abortRun(sessionKey: String, runId: String) async throws
    func listSessions(limit: Int?) async throws -> SmartAgentNeoChatSessionsListResponse

    func requestHealth(timeoutMs: Int) async throws -> Bool
    func events() -> AsyncStream<SmartAgentNeoChatTransportEvent>

    func setActiveSessionKey(_ sessionKey: String) async throws
}

extension SmartAgentNeoChatTransport {
    public func setActiveSessionKey(_: String) async throws {}

    public func abortRun(sessionKey _: String, runId _: String) async throws {
        throw NSError(
            domain: "SmartAgentNeoChatTransport",
            code: 0,
            userInfo: [NSLocalizedDescriptionKey: "chat.abort not supported by this transport"])
    }

    public func listSessions(limit _: Int?) async throws -> SmartAgentNeoChatSessionsListResponse {
        throw NSError(
            domain: "SmartAgentNeoChatTransport",
            code: 0,
            userInfo: [NSLocalizedDescriptionKey: "sessions.list not supported by this transport"])
    }
}
