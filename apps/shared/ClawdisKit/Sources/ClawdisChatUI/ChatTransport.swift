import Foundation

public enum ClawdisChatTransportEvent: Sendable {
    case health(ok: Bool)
    case tick
    case chat(ClawdisChatEventPayload)
    case agent(ClawdisAgentEventPayload)
    case seqGap
}

public protocol ClawdisChatTransport: Sendable {
    func requestHistory(sessionKey: String) async throws -> ClawdisChatHistoryPayload
    func sendMessage(
        sessionKey: String,
        message: String,
        thinking: String,
        idempotencyKey: String,
        attachments: [ClawdisChatAttachmentPayload]) async throws -> ClawdisChatSendResponse

    func abortRun(sessionKey: String, runId: String) async throws
    func listSessions(limit: Int?) async throws -> ClawdisChatSessionsListResponse

    func requestHealth(timeoutMs: Int) async throws -> Bool
    func events() -> AsyncStream<ClawdisChatTransportEvent>

    func setActiveSessionKey(_ sessionKey: String) async throws
}

extension ClawdisChatTransport {
    public func setActiveSessionKey(_: String) async throws {}

    public func abortRun(sessionKey _: String, runId _: String) async throws {
        throw NSError(
            domain: "ClawdisChatTransport",
            code: 0,
            userInfo: [NSLocalizedDescriptionKey: "chat.abort not supported by this transport"])
    }

    public func listSessions(limit _: Int?) async throws -> ClawdisChatSessionsListResponse {
        throw NSError(
            domain: "ClawdisChatTransport",
            code: 0,
            userInfo: [NSLocalizedDescriptionKey: "sessions.list not supported by this transport"])
    }
}
