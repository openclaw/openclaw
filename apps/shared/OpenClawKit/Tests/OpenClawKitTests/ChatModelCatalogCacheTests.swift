import Foundation
import Testing
@testable import OpenClawChatUI

private struct CatalogUnavailable: Error {}

private struct CacheTestTransport: OpenClawChatTransport {
    var choices: [OpenClawChatModelChoice]?

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

    func loadModelCatalog(sessionKey _: String, agentID _: String?) async throws -> OpenClawChatModelCatalogSnapshot {
        guard let choices else { throw CatalogUnavailable() }
        return OpenClawChatModelCatalogSnapshot(choices: choices, availabilityIsSessionScoped: false)
    }
}

@MainActor
struct ChatModelCatalogCacheTests {
    private let cached = [
        OpenClawChatModelChoice(modelID: "gpt-6.2-sol", name: "GPT-6.2 Sol", provider: "openai", contextWindow: nil),
        OpenClawChatModelChoice(
            modelID: "claude-fable-5-2",
            name: "Claude Fable 5.2",
            provider: "anthropic",
            contextWindow: nil),
    ]

    private func viewModel(_ transport: CacheTestTransport) -> (OpenClawChatViewModel, String) {
        let model = OpenClawChatViewModel(sessionKey: "main", transport: transport)
        let scope = "test-\(UUID().uuidString)"
        model.modelCatalogCacheScopeOverride = scope
        return (model, model.modelCatalogCacheKey ?? "")
    }

    @Test func `a cold start shows the cached list while the server does not answer`() async {
        let (model, key) = self.viewModel(CacheTestTransport(choices: nil))
        defer { UserDefaults.standard.removeObject(forKey: key) }
        ChatModelCatalogCache.store(self.cached, key: key)

        await model.fetchModels()

        #expect(model.modelChoices == self.cached)
        #if os(iOS)
        // A failed refresh with a list on screen says nothing.
        #expect(model.modelCatalogMessage == nil)
        #endif
    }

    @Test func `a fresh list replaces the cached one and is kept for next time`() async {
        let fresh = [self.cached[0]]
        let (model, key) = self.viewModel(CacheTestTransport(choices: fresh))
        defer { UserDefaults.standard.removeObject(forKey: key) }
        ChatModelCatalogCache.store(self.cached, key: key)

        await model.fetchModels()

        #expect(model.modelChoices == fresh)
        #expect(ChatModelCatalogCache.load(key) == fresh)
    }

    @Test func `each server and agent has its own slot`() {
        #expect(ChatModelCatalogCache.key(scope: "a", agentID: nil) != ChatModelCatalogCache.key(
            scope: "b",
            agentID: nil))
        #expect(ChatModelCatalogCache.key(scope: "a", agentID: "x") != ChatModelCatalogCache.key(
            scope: "a",
            agentID: "y"))
    }
}
