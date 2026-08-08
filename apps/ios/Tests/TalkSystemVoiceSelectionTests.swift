import Foundation
import OpenClawKit
import Testing
@testable import OpenClaw

@Suite struct TalkSystemVoiceSelectionTests {
    @Test func resolvedOverrideReturnsNilForEmptyOrWhitespace() {
        #expect(TalkSystemVoiceSelection.resolvedOverride(nil) == nil)
        #expect(TalkSystemVoiceSelection.resolvedOverride("") == nil)
        #expect(TalkSystemVoiceSelection.resolvedOverride("   ") == nil)
    }

    @Test func resolvedOverrideTrimsAndValidatesAgainstInstalledVoices() {
        let resolved = TalkSystemVoiceSelection.resolvedOverride(
            "  com.apple.voice.enhanced.en-US.Samantha  ",
            isVoiceInstalled: { $0 == "com.apple.voice.enhanced.en-US.Samantha" })

        #expect(resolved == "com.apple.voice.enhanced.en-US.Samantha")
    }

    @Test func resolvedOverrideFallsBackToNilWhenVoiceIsNoLongerInstalled() {
        let resolved = TalkSystemVoiceSelection.resolvedOverride(
            "com.apple.voice.deleted.voice",
            isVoiceInstalled: { _ in false })

        #expect(resolved == nil)
    }

    @Test func optionsAlwaysLeadsWithSystemDefault() {
        let voices = [
            TalkSystemVoiceCatalog.Voice(id: "us", name: "Samantha", languageID: "en-US", quality: .standard),
        ]
        let options = TalkSystemVoiceSelection.options(languageID: nil, allVoices: voices)

        #expect(options.first?.id == TalkSystemVoiceSelection.automaticID)
        #expect(options.first?.label == "System Default")
        #expect(options.count == 2)
    }

    @Test func optionsFiltersByLanguageSubtag() {
        let voices = [
            TalkSystemVoiceCatalog.Voice(id: "us", name: "Samantha", languageID: "en-US", quality: .standard),
            TalkSystemVoiceCatalog.Voice(id: "gb", name: "Daniel", languageID: "en-GB", quality: .enhanced),
            TalkSystemVoiceCatalog.Voice(id: "fr", name: "Thomas", languageID: "fr-FR", quality: .standard),
        ]
        let options = TalkSystemVoiceSelection.options(languageID: "en-US", allVoices: voices)

        #expect(Set(options.map(\.id)) == Set([TalkSystemVoiceSelection.automaticID, "us", "gb"]))
    }

    @Test func optionsShowsEveryVoiceWhenLanguageIDIsNil() {
        let voices = [
            TalkSystemVoiceCatalog.Voice(id: "us", name: "Samantha", languageID: "en-US", quality: .standard),
            TalkSystemVoiceCatalog.Voice(id: "fr", name: "Thomas", languageID: "fr-FR", quality: .standard),
        ]
        let options = TalkSystemVoiceSelection.options(languageID: nil, allVoices: voices)

        #expect(options.count == 3)
    }
}
