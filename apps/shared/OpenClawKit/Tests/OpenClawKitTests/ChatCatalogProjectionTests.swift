import Foundation
import Testing
@testable import OpenClawChatUI

private struct CatalogProjectionTransport: OpenClawChatTransport {
    func requestHistory(sessionKey: String) async throws -> OpenClawChatHistoryPayload {
        .init(sessionKey: sessionKey, sessionId: nil, messages: [], thinkingLevel: nil)
    }

    func sendMessage(
        sessionKey: String, message: String, thinking: String, idempotencyKey: String,
        attachments: [OpenClawChatAttachmentPayload]) async throws -> OpenClawChatSendResponse
    {
        .init(runId: idempotencyKey, status: "started")
    }

    func requestHealth(timeoutMs: Int) async throws -> Bool { true }
    func events() -> AsyncStream<OpenClawChatTransportEvent> { AsyncStream { $0.finish() } }
}

@MainActor
struct ChatCatalogProjectionTests {
    private func viewModel(_ row: String) throws -> OpenClawChatViewModel {
        let model = OpenClawChatViewModel(sessionKey: "main", transport: CatalogProjectionTransport())
        model.modelChoices = try OpenClawChatGatewayPayloadCodec.decodeModelChoices(
            Data("{\"models\":[\(row)]}".utf8))
        model.sessionDefaults = .init(modelProvider: "fixture", model: "choice", contextTokens: nil)
        return model
    }

    @Test func `Fast applicability comes from published row rather than an always enabled control`() throws {
        let model = try self.viewModel(#"{"id":"choice","name":"Choice","provider":"fixture","supportsFastMode":false}"#)
        #expect(!model.selectedModelSupportsFastMode)
    }

    @Test func `catalog thinking labels and default reach the picker together`() throws {
        let model = try self.viewModel(#"{"id":"choice","name":"Choice","provider":"fixture","thinkingLevels":[{"id":"low","label":"Quick"},{"id":"high","label":"Deep"}],"thinkingDefault":"high"}"#)
        model.syncThinkingLevelOptions()
        #expect(model.thinkingLevelOptions == [.init(id: "low", label: "Quick"), .init(id: "high", label: "Deep")])
        #expect(model.thinkingLevel == "high")
    }

    @Test func `absent catalog capabilities do not invent thinking or Fast choices`() throws {
        let model = try self.viewModel(#"{"id":"choice","name":"Choice","provider":"fixture"}"#)
        model.syncThinkingLevelOptions()
        #expect(!model.selectedModelSupportsFastMode)
        #expect(!model.showsThinkingPicker)
    }
}
