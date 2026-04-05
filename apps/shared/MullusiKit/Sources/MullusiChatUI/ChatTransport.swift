import Foundation

public enum MullusiChatTransportEvent: Sendable {
    case health(ok: Bool)
    case tick
    case chat(MullusiChatEventPayload)
    case agent(MullusiAgentEventPayload)
    case seqGap
}

public protocol MullusiChatTransport: Sendable {
    func requestHistory(sessionKey: String) async throws -> MullusiChatHistoryPayload
    func listModels() async throws -> [MullusiChatModelChoice]
    func sendMessage(
        sessionKey: String,
        message: String,
        thinking: String,
        idempotencyKey: String,
        attachments: [MullusiChatAttachmentPayload]) async throws -> MullusiChatSendResponse

    func abortRun(sessionKey: String, runId: String) async throws
    func listSessions(limit: Int?) async throws -> MullusiChatSessionsListResponse
    func setSessionModel(sessionKey: String, model: String?) async throws
    func setSessionThinking(sessionKey: String, thinkingLevel: String) async throws

    func requestHealth(timeoutMs: Int) async throws -> Bool
    func events() -> AsyncStream<MullusiChatTransportEvent>

    func setActiveSessionKey(_ sessionKey: String) async throws
    func resetSession(sessionKey: String) async throws
    func compactSession(sessionKey: String) async throws
}

extension MullusiChatTransport {
    public func setActiveSessionKey(_: String) async throws {}

    public func resetSession(sessionKey _: String) async throws {
        throw NSError(
            domain: "MullusiChatTransport",
            code: 0,
            userInfo: [NSLocalizedDescriptionKey: "sessions.reset not supported by this transport"])
    }

    public func compactSession(sessionKey _: String) async throws {
        throw NSError(
            domain: "MullusiChatTransport",
            code: 0,
            userInfo: [NSLocalizedDescriptionKey: "sessions.compact not supported by this transport"])
    }

    public func abortRun(sessionKey _: String, runId _: String) async throws {
        throw NSError(
            domain: "MullusiChatTransport",
            code: 0,
            userInfo: [NSLocalizedDescriptionKey: "chat.abort not supported by this transport"])
    }

    public func listSessions(limit _: Int?) async throws -> MullusiChatSessionsListResponse {
        throw NSError(
            domain: "MullusiChatTransport",
            code: 0,
            userInfo: [NSLocalizedDescriptionKey: "sessions.list not supported by this transport"])
    }

    public func listModels() async throws -> [MullusiChatModelChoice] {
        throw NSError(
            domain: "MullusiChatTransport",
            code: 0,
            userInfo: [NSLocalizedDescriptionKey: "models.list not supported by this transport"])
    }

    public func setSessionModel(sessionKey _: String, model _: String?) async throws {
        throw NSError(
            domain: "MullusiChatTransport",
            code: 0,
            userInfo: [NSLocalizedDescriptionKey: "sessions.patch(model) not supported by this transport"])
    }

    public func setSessionThinking(sessionKey _: String, thinkingLevel _: String) async throws {
        throw NSError(
            domain: "MullusiChatTransport",
            code: 0,
            userInfo: [NSLocalizedDescriptionKey: "sessions.patch(thinkingLevel) not supported by this transport"])
    }
}
