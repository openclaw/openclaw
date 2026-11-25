import Foundation
import Testing
@testable import OpenClawChatUI

private func catalogModel(
    _ selectionID: String,
    name: String? = nil,
    providerName: String? = nil,
    manualSelectionAllowed: Bool? = nil) -> OpenClawChatModelChoice
{
    let parts = selectionID.split(separator: "/", maxSplits: 1).map(String.init)
    return OpenClawChatModelChoice(
        modelID: parts[1],
        name: name ?? parts[1],
        provider: parts[0],
        manualSelectionAllowed: manualSelectionAllowed,
        contextWindow: nil,
        providerName: providerName)
}

@MainActor
struct ChatModelPickerCatalogTests {
    @Test func `providers keep every model in catalog order, pinned and recent ones included`() {
        let choices = [
            catalogModel("openai/gpt-6.2-sol"), catalogModel("anthropic/opus"), catalogModel("openai/gpt-6-luna"),
            catalogModel("openai/gpt-6-astra"), catalogModel("anthropic/auto", manualSelectionAllowed: false),
        ]
        let catalog = ChatModelPickerStore.catalog(
            choices: choices,
            favorites: ["openai/gpt-6-luna"],
            recents: ["anthropic/opus"],
            defaultProvider: "anthropic")

        #expect(catalog.favorites.map(\.selectionID) == ["openai/gpt-6-luna"])
        #expect(catalog.recents.map(\.selectionID) == ["anthropic/opus"])
        #expect(catalog.providers.map(\.id) == ["anthropic", "openai"])
        #expect(catalog.providers[0].models.map(\.selectionID) == ["anthropic/opus"])
        #expect(catalog.providers[1].models.map(\.selectionID) ==
            ["openai/gpt-6.2-sol", "openai/gpt-6-luna", "openai/gpt-6-astra"])
        #expect(catalog.provider(for: choices[2])?.id == "openai")
    }

    @Test func `recents stop at three and skip favorites`() {
        let choices = ["a/1", "a/2", "a/3", "a/4", "a/5"].map { catalogModel($0) }
        let catalog = ChatModelPickerStore.catalog(
            choices: choices,
            favorites: ["a/2"],
            recents: ["a/1", "a/2", "a/3", "a/4", "a/5"])

        #expect(catalog.recents.map(\.selectionID) == ["a/1", "a/3", "a/4"])
    }

    @Test func `one provider gives one section with all of its models`() {
        let catalog = ChatModelPickerStore.catalog(
            choices: [catalogModel("openai/gpt-6.2-sol"), catalogModel("openai/gpt-6-luna")],
            favorites: [],
            recents: [])

        #expect(catalog.providers.count == 1)
        #expect(catalog.providers[0].displayName == "OpenAI")
        #expect(catalog.providers[0].models.count == 2)
    }

    @Test func `search is flat across providers and matches names, ids and provider names`() {
        let catalog = ChatModelPickerStore.catalog(
            choices: [
                catalogModel("anthropic/claude-opus-5-5", name: "Opus 5.5"),
                catalogModel("clawrouter/anthropic/claude-opus-5-5", name: "Claude Opus 5.5"),
                catalogModel("openai/gpt-6.2-sol", name: "GPT-6.2 Sol"),
                catalogModel("zai/glm-5.3", name: "GLM 5.3"),
            ],
            favorites: [],
            recents: [],
            defaultProvider: "anthropic")

        #expect(catalog.search("opus").map(\.selectionID) ==
            ["anthropic/claude-opus-5-5", "clawrouter/anthropic/claude-opus-5-5"])
        #expect(catalog.search("  SOL ").map(\.selectionID) == ["openai/gpt-6.2-sol"])
        #expect(catalog.search("glm-5").map(\.selectionID) == ["zai/glm-5.3"])
        #expect(catalog.search("Z.AI").map(\.selectionID) == ["zai/glm-5.3"])
        #expect(catalog.search("gpt-9").isEmpty)
        #expect(catalog.search("   ").isEmpty)
    }

    @Test func `provider names follow the configured name, then the brand table`() {
        let catalog = ChatModelPickerStore.catalog(
            choices: [
                catalogModel("clawrouter/openai/gpt-6.2-sol"),
                catalogModel("lmstudio/qwen"),
                catalogModel("acme-cloud/one"),
                catalogModel("custom/two", providerName: "Team proxy"),
            ],
            favorites: [],
            recents: [])

        #expect(catalog.providers.map(\.displayName) == ["Acme Cloud", "ClawRouter", "LM Studio", "Team proxy"])
    }

    @Test func `twenty providers stay sorted with the default first`() {
        let ids = (1...20).map { String(format: "p%02d", $0) }
        let catalog = ChatModelPickerStore.catalog(
            choices: ids.reversed().map { catalogModel("\($0)/model") },
            favorites: [],
            recents: [],
            defaultProvider: "p13")

        #expect(catalog.providers.count == 20)
        #expect(catalog.providers.first?.id == "p13")
        #expect(Array(catalog.providers.dropFirst().map(\.id)) == ids.filter { $0 != "p13" })
    }
}
