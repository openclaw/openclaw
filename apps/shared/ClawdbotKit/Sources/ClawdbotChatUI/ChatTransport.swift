import Foundation

public enum ClawdbotChatTransportEvent: Sendable {
    case health(ok: Bool)
    case tick
    case chat(ClawdbotChatEventPayload)
    case agent(ClawdbotAgentEventPayload)
    case seqGap
}

public protocol ClawdbotChatTransport: Sendable {
    func requestHistory(sessionKey: String) async throws -> ClawdbotChatHistoryPayload
    func sendMessage(
        sessionKey: String,
        message: String,
        thinking: String,
        idempotencyKey: String,
        attachments: [ClawdbotChatAttachmentPayload]) async throws -> ClawdbotChatSendResponse

    func abortRun(sessionKey: String, runId: String) async throws
    func listSessions(limit: Int?) async throws -> ClawdbotChatSessionsListResponse

    func requestHealth(timeoutMs: Int) async throws -> Bool
    func events() -> AsyncStream<ClawdbotChatTransportEvent>

    func setActiveSessionKey(_ sessionKey: String) async throws
}

extension ClawdbotChatTransport {
    public func setActiveSessionKey(_: String) async throws {}

    public func abortRun(sessionKey _: String, runId _: String) async throws {
        throw NSError(
            domain: "ClawdbotChatTransport",
            code: 0,
            userInfo: [NSLocalizedDescriptionKey: "chat.abort not supported by this transport"])
    }

    public func listSessions(limit _: Int?) async throws -> ClawdbotChatSessionsListResponse {
        throw NSError(
            domain: "ClawdbotChatTransport",
            code: 0,
            userInfo: [NSLocalizedDescriptionKey: "sessions.list not supported by this transport"])
    }
}
