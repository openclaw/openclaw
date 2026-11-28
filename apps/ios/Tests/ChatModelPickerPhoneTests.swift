import SwiftUI
import Testing
@testable import OpenClaw
@testable import OpenClawChatUI

@MainActor
struct ChatModelPickerPhoneTests {
    @Test func `omitting a provisional model name keeps cached names and settled fallbacks`() async throws {
        let transport = LocalFixtureChatTransport(fixture: .appScreenshots)
        let model = OpenClawChatViewModel(sessionKey: "main", transport: transport)
        // The fixture starts healthy; do not race this explicit catalog load with reconnect recovery.
        model.healthOK = true
        model.isLoading = true
        await model.fetchSessions(limit: 1)
        #expect(model.composerInlineModelLabel == "gpt-5.6-sol")
        #expect(model.isWaitingForComposerModelName)

        model.modelChoices = try await transport.listModels(agentID: "main")
        #expect(!model.isWaitingForComposerModelName)
        #expect(model.composerInlineModelLabel == "GPT-5.6")

        await model.fetchModels()
        var unlisted = try #require(model.currentSessionEntry())
        unlisted.model = "unlisted"
        model.sessions = [unlisted]
        model.syncSelectedModel()
        #expect(!model.isWaitingForComposerModelName)
        #expect(model.composerInlineModelLabel == "unlisted")
    }

    @Test func `a new chat uses the picked catalog row when another provider has its ID`() async throws {
        let transport = LocalFixtureChatTransport(fixture: .appScreenshots)
        let model = OpenClawChatViewModel(sessionKey: "main", transport: transport)
        try #require(model.startNewChatDraft())
        await model.bootstrapTask?.value
        await model.loadComposerCapabilities()

        let direct = OpenClawChatModelChoice(
            modelID: "atlas-v2",
            name: "Atlas 2",
            provider: "studio",
            contextWindow: nil)
        let routed = OpenClawChatModelChoice(
            modelID: direct.selectionID, name: "Studio · atlas-v2", provider: "router", contextWindow: nil)
        model.modelChoices = [routed, direct]
        model.selectModel(direct.selectionID)
        await model.waitForPendingSessionSettings(for: model.currentModelPatchTarget())

        #expect(model.newChatDraft?.settings.model.flatMap(\.self) == direct.selectionID)
        #expect(model.canonicalModelSelectionID == direct.selectionID)
        #expect(model.composerInlineModelLabel == direct.name)
    }

    @Test func `provider marks resolve through the Control UI aliases and ship in the app`() {
        #expect(ChatProviderMarks.iconName(for: "anthropic") == "claude")
        #expect(ChatProviderMarks.iconName(for: "OpenAI") == "codex")
        #expect(ChatProviderMarks.iconName(for: "acp-kimi") == "kimi")
        #expect(ChatProviderMarks.assetName(for: "clawrouter") == "ProviderIcon-clawrouter")
        #expect(ChatProviderMarks.assetName(for: "z-ai") == "ProviderIcon-zai")
        // No shipped mark: the picker draws a neutral glyph instead.
        #expect(ChatProviderMarks.iconName(for: "azure-openai") == nil)
        #expect(ChatProviderMarks.assetName(for: "azure-openai") == nil)
    }

    @Test func `effort levels read as the Control UI writes them`() {
        let labels = ["off", "minimal", "low", "medium", "high", "xhigh", "max", "ultra", "adaptive", "turbo"]
            .map { OpenClawChatThinkingLevelOption(id: $0, label: $0).displayLabel }
        #expect(labels == [
            "Off", "Minimal", "Low", "Medium", "High", "Extra high", "Maximum", "Ultra", "Adaptive", "Turbo",
        ])
    }
}
