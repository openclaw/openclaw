import Foundation

public enum EasyHubChatTransportEvent: Sendable {
    case health(ok: Bool)
    case tick
    case chat(EasyHubChatEventPayload)
    case agent(EasyHubAgentEventPayload)
    case seqGap
}

public protocol EasyHubChatTransport: Sendable {
    func requestHistory(sessionKey: String) async throws -> EasyHubChatHistoryPayload
    func sendMessage(
        sessionKey: String,
        message: String,
        thinking: String,
        idempotencyKey: String,
        attachments: [EasyHubChatAttachmentPayload]) async throws -> EasyHubChatSendResponse

    func abortRun(sessionKey: String, runId: String) async throws
    func listSessions(limit: Int?) async throws -> EasyHubChatSessionsListResponse

    func requestHealth(timeoutMs: Int) async throws -> Bool
    func events() -> AsyncStream<EasyHubChatTransportEvent>

    func setActiveSessionKey(_ sessionKey: String) async throws
}

extension EasyHubChatTransport {
    public func setActiveSessionKey(_: String) async throws {}

    public func abortRun(sessionKey _: String, runId _: String) async throws {
        throw NSError(
            domain: "EasyHubChatTransport",
            code: 0,
            userInfo: [NSLocalizedDescriptionKey: "chat.abort not supported by this transport"])
    }

    public func listSessions(limit _: Int?) async throws -> EasyHubChatSessionsListResponse {
        throw NSError(
            domain: "EasyHubChatTransport",
            code: 0,
            userInfo: [NSLocalizedDescriptionKey: "sessions.list not supported by this transport"])
    }
}
