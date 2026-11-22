@testable import OpenClawChatUI

struct ToolResultIngestionTransport: OpenClawChatTransport {
    func requestHistory(sessionKey: String) async throws -> OpenClawChatHistoryPayload {
        .init(sessionKey: sessionKey, sessionId: nil, messages: [], thinkingLevel: nil)
    }

    func sendMessage(
        sessionKey: String,
        message: String,
        thinking: String,
        idempotencyKey: String,
        attachments: [OpenClawChatAttachmentPayload]) async throws -> OpenClawChatSendResponse
    {
        .init(runId: idempotencyKey, status: "started")
    }

    func requestHealth(timeoutMs: Int) async throws -> Bool {
        true
    }

    func events() -> AsyncStream<OpenClawChatTransportEvent> {
        AsyncStream { $0.finish() }
    }
}
