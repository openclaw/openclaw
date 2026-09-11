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

    func requestHealth(timeoutMs: Int) async throws -> Bool {
        true
    }

    func events() -> AsyncStream<OpenClawChatTransportEvent> {
        AsyncStream { $0.finish() }
    }
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
        let model = try self
            .viewModel(#"{"id":"choice","name":"Choice","provider":"fixture","supportsFastMode":false}"#)
        #expect(!model.selectedModelSupportsFastMode)
    }

    @Test func `catalog thinking labels and default reach the picker together`() throws {
        let model = try self
            .viewModel(
                #"{"id":"choice","name":"Choice","provider":"fixture","thinkingLevels":[{"id":"low","label":"Quick"},{"id":"high","label":"Deep"}],"thinkingDefault":"high"}"#)
        model.syncThinkingLevelOptions()
        #expect(model.thinkingLevelOptions == [.init(id: "low", label: "Quick"), .init(id: "high", label: "Deep")])
        #expect(model.thinkingLevel == "high")
    }

    @Test func `absent catalog capabilities do not invent thinking or Fast choices`() throws {
        let model = try self.viewModel(#"{"id":"choice","name":"Choice","provider":"fixture"}"#)
        model.syncThinkingLevelOptions()
        #expect(!model.selectedModelSupportsFastMode)
        #expect(!model.showsThinkingPicker)
        #expect(model.effectiveThinkingLevelForSend("high") == "high")
    }

    @Test func `unknown availability stays selectable without refusal guidance`() throws {
        let model = try self.viewModel(#"{"id":"choice","name":"Choice","provider":"fixture"}"#)
        model.modelAvailabilityIsSessionScoped = true
        let choice = try #require(model.modelChoices.first)
        #expect(choice.available == nil)
        #expect(model.canSelectModel(choice.selectionID))
        #expect(model.modelUnavailableDescription(choice) == nil)
        #expect(model.selectedModelUnavailableReason == nil)
    }

    @Test func `saved Fast override wins over catalog default and remains clearable without applicability`() throws {
        let model = try self
            .viewModel(
                #"{"id":"choice","name":"Choice","provider":"fixture","supportsFastMode":false,"effectiveFastMode":true}"#)
        #expect(model.fastModeIsEnabled)
        model.sessions = try [JSONDecoder().decode(OpenClawChatSessionEntry.self, from: Data(
            #"{"key":"main","model":"choice","modelProvider":"fixture","fastMode":false}"#.utf8))]
        #expect(!model.fastModeIsEnabled)
        #expect(model.showsFastModeControls)
        #expect(!model.selectedModelSupportsFastMode)
    }

    @Test func `partial session thinking profile never borrows catalog levels`() throws {
        let model = try self
            .viewModel(
                #"{"id":"choice","name":"Choice","provider":"fixture","thinkingLevels":[{"id":"high","label":"Deep"}],"thinkingDefault":"high"}"#)
        model.sessions = try [JSONDecoder().decode(OpenClawChatSessionEntry.self, from: Data(
            #"{"key":"main","model":"choice","modelProvider":"fixture","thinkingDefault":"low"}"#.utf8))]
        model.syncThinkingLevelOptions()
        #expect(model.thinkingLevel == "low")
        #expect(model.thinkingLevelOptions.isEmpty)
        #expect(!model.showsThinkingPicker)
        #expect(model.sessions.first?.thinkingLevel == nil)
    }

    @Test func `catalog profile cannot cross a different session route`() throws {
        let model = try self
            .viewModel(
                #"{"id":"choice","name":"Choice","provider":"fixture","thinkingLevels":[{"id":"high","label":"Deep"}],"agentRuntime":{"id":"remote","source":"model"}}"#)
        model.sessions = try [JSONDecoder().decode(OpenClawChatSessionEntry.self, from: Data(
            #"{"key":"main","model":"choice","modelProvider":"fixture","agentRuntime":{"id":"local","source":"session"}}"#
                .utf8))]
        model.syncThinkingLevelOptions()
        #expect(!model.showsThinkingPicker)
        #expect(model.thinkingLevelOptions.isEmpty)
    }

    @Test func `input and route badges preserve published metadata`() throws {
        let model = try self
            .viewModel(
                #"{"id":"choice","name":"Choice","provider":"fixture","input":["text","image","document"],"agentRuntime":{"id":"remote","source":"model"}}"#)
        let choice = try #require(model.modelChoices.first)
        #expect(choice.input == ["text", "image", "document"])
        #expect(choice.agentRuntime?.id == "remote")
        #expect(choice.capabilityDescription == "Images · Documents · remote")
    }

    @Test func `direct catalog request carries session identity and configured details`() {
        let request = OpenClawChatGatewayRequests.modelsList(agentID: "reviewer", sessionKey: "agent:reviewer:work")
        #expect(request.method == "models.list")
        #expect(request.params["agentId"]?.value as? String == "reviewer")
        #expect(request.params["sessionKey"]?.value as? String == "agent:reviewer:work")
        #expect(request.params["view"]?.value as? String == "configured")
        #expect(request.params["includeDetails"]?.value as? Bool == true)
    }

    @Test func `failed catalog refresh preserves supplied rows and failure guidance`() throws {
        let catalog = try OpenClawChatGatewayPayloadCodec.decodeModelCatalog(Data(
            #"{"models":[{"id":"choice","name":"Choice","provider":"fixture"}],"refreshFailed":true}"#.utf8))
        #expect(catalog.refreshFailed)
        #expect(catalog.choices.map(\.selectionID) == ["fixture/choice"])
    }

    @Test func `background thinking uses its own model profile`() throws {
        let model = try self
            .viewModel(
                #"{"id":"choice","name":"Choice","provider":"fixture","thinkingLevels":[{"id":"off","label":"off"}]}"#)
        model.modelChoices += try OpenClawChatGatewayPayloadCodec.decodeModelChoices(Data(
            #"{"models":[{"id":"background","name":"Background","provider":"fixture","thinkingLevels":[{"id":"high","label":"high"}]}]}"#
                .utf8))
        model.sessions = try JSONDecoder().decode([OpenClawChatSessionEntry].self, from: Data(
            #"[{"key":"main","model":"choice","modelProvider":"fixture"},{"key":"other","model":"background","modelProvider":"fixture","thinkingLevel":"high"}]"#
                .utf8))
        model.syncSelectedModel()
        #expect(model.effectiveThinkingLevelForSend("high", sessionKey: "other") == "high")
    }
}
