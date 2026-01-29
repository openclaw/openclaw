import Foundation

public enum DNAChatTransportEvent: Sendable {
    case health(ok: Bool)
    case tick
    case chat(DNAChatEventPayload)
    case agent(DNAAgentEventPayload)
    case seqGap
}

public protocol DNAChatTransport: Sendable {
    func requestHistory(sessionKey: String) async throws -> DNAChatHistoryPayload
    func sendMessage(
        sessionKey: String,
        message: String,
        thinking: String,
        idempotencyKey: String,
        attachments: [DNAChatAttachmentPayload]) async throws -> DNAChatSendResponse

    func abortRun(sessionKey: String, runId: String) async throws
    func listSessions(limit: Int?) async throws -> DNAChatSessionsListResponse

    func requestHealth(timeoutMs: Int) async throws -> Bool
    func events() -> AsyncStream<DNAChatTransportEvent>

    func setActiveSessionKey(_ sessionKey: String) async throws
}

extension DNAChatTransport {
    public func setActiveSessionKey(_: String) async throws {}

    public func abortRun(sessionKey _: String, runId _: String) async throws {
        throw NSError(
            domain: "DNAChatTransport",
            code: 0,
            userInfo: [NSLocalizedDescriptionKey: "chat.abort not supported by this transport"])
    }

    public func listSessions(limit _: Int?) async throws -> DNAChatSessionsListResponse {
        throw NSError(
            domain: "DNAChatTransport",
            code: 0,
            userInfo: [NSLocalizedDescriptionKey: "sessions.list not supported by this transport"])
    }
}
