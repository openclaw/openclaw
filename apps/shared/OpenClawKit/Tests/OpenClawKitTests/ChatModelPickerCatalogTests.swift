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

    @Test func `recents stop at five and skip favorites`() {
        let choices = ["a/1", "a/2", "a/3", "a/4", "a/5", "a/6", "a/7"].map { catalogModel($0) }
        let catalog = ChatModelPickerStore.catalog(
            choices: choices,
            favorites: ["a/2"],
            recents: ["a/1", "a/2", "a/3", "a/4", "a/5", "a/6", "a/7"])

        #expect(catalog.recents.map(\.selectionID) == ["a/1", "a/3", "a/4", "a/5", "a/6"])
    }

    @Test func `recent models come from every chat, newest first, then this device's picks`() {
        let ids = ChatModelPickerStore.recentModelIDs(
            chats: [("a/1", 10), ("b/1", 30), (nil, 40), ("a/1", 20), ("c/1", 25), ("", 50)],
            picks: ["d/1", "b/1", "e/1", "f/1"])
        // b/1 is newest; a/1 shows once at its newest chat; the device's picks follow; capped at five.
        #expect(ids == ["b/1", "c/1", "a/1", "d/1", "e/1"])
        #expect(ChatModelPickerStore.recentModelIDs(chats: [], picks: []) == [])
    }

    @Test func `models that cannot be used now leave Recent, the current one stays once`() {
        let signedOut = OpenClawChatModelChoice(
            modelID: "1", name: "1", provider: "b", available: false, contextWindow: nil)
        let choices = [catalogModel("a/1"), catalogModel("a/2"), signedOut]
        let catalog = ChatModelPickerStore.catalog(
            choices: choices, favorites: [], recents: ["b/1", "a/2", "a/1", "a/9"], current: "a/1")
        #expect(catalog.recents.map(\.selectionID) == ["a/1", "a/2"])
    }

    @Test func `the current model leads Recent unless it is a favorite, and the stored recents stay as they are`() {
        let choices = ["a/1", "a/2", "a/3", "a/4", "a/5"].map { catalogModel($0) } + [catalogModel("b/1")]
        let recents = ["a/2", "a/3", "a/4"]
        func recentIDs(current: String?, favorites: [String] = []) -> [String] {
            ChatModelPickerStore.catalog(choices: choices, favorites: favorites, recents: recents, current: current)
                .recents.map(\.selectionID)
        }

        // Never picked on this device: first, ahead of the rest.
        #expect(recentIDs(current: "a/1") == ["a/1", "a/2", "a/3", "a/4"])
        // Already a recent: moved to the top, not listed twice.
        #expect(recentIDs(current: "a/3") == ["a/3", "a/2", "a/4"])
        // A favorite: it stays in Favorites only.
        let favorite = ChatModelPickerStore.catalog(
            choices: choices, favorites: ["a/1"], recents: recents, current: "a/1")
        #expect(favorite.favorites.map(\.selectionID) == ["a/1"])
        #expect(favorite.recents.map(\.selectionID) == recents)
        // Not in the catalog (unknown, or not selectable): the root is what the stored lists give.
        #expect(recentIDs(current: "b/9") == recents)
        #expect(recentIDs(current: nil) == recents)
        let locked = ChatModelPickerStore.catalog(
            choices: choices + [catalogModel("a/6", manualSelectionAllowed: false)],
            favorites: [],
            recents: recents,
            current: "a/6")
        #expect(locked.recents.map(\.selectionID) == recents)
    }

    @Test func `with one provider the current model stays in its list, not in Recent`() {
        let choices = ["a/1", "a/2", "a/3"].map { catalogModel($0) }
        let catalog = ChatModelPickerStore.catalog(
            choices: choices,
            favorites: [],
            recents: ["a/2"],
            current: "a/1")

        #expect(catalog.providers.count == 1)
        #expect(catalog.recents.map(\.selectionID) == ["a/2"])
        // The list below holds the only check: the current model is left out of Recent, a favorite stays.
        #expect(ChatModelPickerStore.catalog(choices: choices, favorites: [], recents: ["a/1", "a/2"], current: "a/1")
            .recents.map(\.selectionID) == ["a/2"])
        #expect(ChatModelPickerStore.catalog(choices: choices, favorites: ["a/1"], recents: [], current: "a/1")
            .favorites.map(\.selectionID) == ["a/1"])
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
