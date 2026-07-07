import Foundation
import Testing
@testable import OpenClawChatUI

private func pickerModel(_ selectionID: String) -> OpenClawChatModelChoice {
    let parts = selectionID.split(separator: "/", maxSplits: 1).map(String.init)
    return OpenClawChatModelChoice(
        modelID: parts.count == 2 ? parts[1] : selectionID,
        name: selectionID,
        provider: parts.count == 2 ? parts[0] : "test",
        contextWindow: nil)
}

@MainActor
private func withPickerStore(_ body: (ChatModelPickerStore, UserDefaults) throws -> Void) throws {
    let suiteName = "ChatModelPickerStoreTests.\(UUID().uuidString)"
    let defaults = try #require(UserDefaults(suiteName: suiteName))
    defer { defaults.removePersistentDomain(forName: suiteName) }
    try body(ChatModelPickerStore(defaults: defaults), defaults)
}

@MainActor
@Suite struct ChatModelPickerStoreTests {
    @Test func `favorites and recents round trip through defaults`() throws {
        try withPickerStore { store, defaults in
            store.toggleFavorite("anthropic/opus")
            store.recordRecent("openai/gpt")

            let reloaded = ChatModelPickerStore(defaults: defaults)
            #expect(reloaded.favorites == ["anthropic/opus"])
            #expect(reloaded.recents == ["openai/gpt"])
        }
    }

    @Test func `recents dedupe move to front cap and skip invalid ids`() throws {
        try withPickerStore { store, _ in
            store.recordRecent("")
            store.recordRecent(OpenClawChatViewModel.defaultModelSelectionID)
            for id in ["one", "two", "three", "four", "five", "six"] {
                store.recordRecent(id)
            }
            #expect(store.recents == ["six", "five", "four", "three", "two"])

            store.recordRecent("four")
            #expect(store.recents == ["four", "six", "five", "three", "two"])
        }
    }

    @Test func `favorites preserve pin order and remove unpinned ids`() throws {
        try withPickerStore { store, _ in
            store.toggleFavorite("one")
            store.toggleFavorite("two")
            store.toggleFavorite("three")
            #expect(store.favorites == ["one", "two", "three"])

            store.toggleFavorite("two")
            #expect(store.favorites == ["one", "three"])

            store.toggleFavorite("two")
            #expect(store.favorites == ["one", "three", "two"])
        }
    }

    @Test func `separate stores preserve each others updates`() throws {
        try withPickerStore { first, defaults in
            let second = ChatModelPickerStore(defaults: defaults)

            first.toggleFavorite("one")
            second.toggleFavorite("two")
            #expect(second.favorites == ["one", "two"])

            first.recordRecent("one")
            second.recordRecent("two")
            #expect(second.recents == ["two", "one"])
        }
    }

    @Test func `ordering preserves sections and skips missing models`() {
        let choices = [pickerModel("a/one"), pickerModel("b/two"), pickerModel("c/three"), pickerModel("d/four")]
        let sections = ChatModelPickerStore.sections(
            choices: choices,
            favorites: ["c/three", "missing/model", "a/one"],
            recents: ["a/one", "d/four", "missing/recent"])

        #expect(sections.pinned.map(\.selectionID) == ["c/three", "a/one"])
        #expect(sections.recent.map(\.selectionID) == ["d/four"])
        #expect(sections.remaining.map(\.selectionID) == ["b/two"])
    }

    @Test func `ordering handles empty inputs`() {
        let sections = ChatModelPickerStore.sections(choices: [], favorites: [], recents: [])
        #expect(sections.pinned.isEmpty)
        #expect(sections.recent.isEmpty)
        #expect(sections.remaining.isEmpty)
    }
}
