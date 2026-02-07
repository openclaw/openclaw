import Foundation

public enum OpenClawChatTransportEvent: Sendable {
    case health(ok: Bool)
    case tick
    case chat(OpenClawChatEventPayload)
    case agent(OpenClawAgentEventPayload)
    case seqGap
}

public protocol OpenClawChatTransport: Sendable {
    func requestHistory(sessionKey: String) async throws -> OpenClawChatHistoryPayload
    func sendMessage(
        sessionKey: String,
        message: String,
        thinking: String,
        idempotencyKey: String,
        attachments: [OpenClawChatAttachmentPayload]) async throws -> OpenClawChatSendResponse

    func abortRun(sessionKey: String, runId: String) async throws
    func listSessions(limit: Int?) async throws -> OpenClawChatSessionsListResponse

    func requestHealth(timeoutMs: Int) async throws -> Bool
    func events() -> AsyncStream<OpenClawChatTransportEvent>

    func setActiveSessionKey(_ sessionKey: String) async throws
}

extension OpenClawChatTransport {
    public func setActiveSessionKey(_: String) async throws {}

    public func abortRun(sessionKey _: String, runId _: String) async throws {
        throw NSError(
            domain: "OpenClawChatTransport",
            code: 0,
            userInfo: [NSLocalizedDescriptionKey: "chat.abort not supported by this transport"])
    }

    public func listSessions(limit _: Int?) async throws -> OpenClawChatSessionsListResponse {
        throw NSError(
            domain: "OpenClawChatTransport",
            code: 0,
            userInfo: [NSLocalizedDescriptionKey: "sessions.list not supported by this transport"])
    }
}
