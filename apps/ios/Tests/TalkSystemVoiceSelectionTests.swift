import Foundation
import OpenClawKit
import Testing
@testable import OpenClaw

struct TalkSystemVoiceSelectionTests {
    @Test func `resolved override returns nil for empty or whitespace`() {
        #expect(TalkSystemVoiceSelection.resolvedOverride(nil) == nil)
        #expect(TalkSystemVoiceSelection.resolvedOverride("") == nil)
        #expect(TalkSystemVoiceSelection.resolvedOverride("   ") == nil)
    }

    @Test func `resolved override trims and validates against installed voices`() {
        let resolved = TalkSystemVoiceSelection.resolvedOverride(
            "  com.apple.voice.enhanced.en-US.Samantha  ",
            isVoiceInstalled: { $0 == "com.apple.voice.enhanced.en-US.Samantha" })

        #expect(resolved == "com.apple.voice.enhanced.en-US.Samantha")
    }

    @Test func `resolved override falls back to nil when voice is no longer installed`() {
        let resolved = TalkSystemVoiceSelection.resolvedOverride(
            "com.apple.voice.deleted.voice",
            isVoiceInstalled: { _ in false })

        #expect(resolved == nil)
    }

    @Test func `options always leads with system default`() {
        let voices = [
            TalkSystemVoiceCatalog.Voice(id: "us", name: "Samantha", languageID: "en-US", quality: .standard),
        ]
        let options = TalkSystemVoiceSelection.options(languageID: nil, allVoices: voices)

        #expect(options.first?.id == TalkSystemVoiceSelection.automaticID)
        #expect(options.first?.label == "System Default")
        #expect(options.count == 2)
    }

    @Test func `options filters by language subtag`() {
        let voices = [
            TalkSystemVoiceCatalog.Voice(id: "us", name: "Samantha", languageID: "en-US", quality: .standard),
            TalkSystemVoiceCatalog.Voice(id: "gb", name: "Daniel", languageID: "en-GB", quality: .enhanced),
            TalkSystemVoiceCatalog.Voice(id: "fr", name: "Thomas", languageID: "fr-FR", quality: .standard),
        ]
        let options = TalkSystemVoiceSelection.options(languageID: "en-US", allVoices: voices)

        #expect(Set(options.map(\.id)) == Set([TalkSystemVoiceSelection.automaticID, "us", "gb"]))
    }

    @Test func `options shows every voice when language ID is nil`() {
        let voices = [
            TalkSystemVoiceCatalog.Voice(id: "us", name: "Samantha", languageID: "en-US", quality: .standard),
            TalkSystemVoiceCatalog.Voice(id: "fr", name: "Thomas", languageID: "fr-FR", quality: .standard),
        ]
        let options = TalkSystemVoiceSelection.options(languageID: nil, allVoices: voices)

        #expect(options.count == 3)
    }

    @Test func `resolved override with language ID falls back when voice no longer matches language`() {
        let voices = [
            TalkSystemVoiceCatalog.Voice(id: "us", name: "Samantha", languageID: "en-US", quality: .standard),
        ]

        let resolved = TalkSystemVoiceSelection.resolvedOverride("us", languageID: "fr-FR", allVoices: voices)

        #expect(resolved == nil)
    }

    @Test func `resolved override with language ID keeps voice matching current language`() {
        let voices = [
            TalkSystemVoiceCatalog.Voice(id: "us", name: "Samantha", languageID: "en-US", quality: .standard),
        ]

        let resolved = TalkSystemVoiceSelection.resolvedOverride("us", languageID: "en-GB", allVoices: voices)

        #expect(resolved == "us")
    }

    @Test func `resolved override with language ID shows every installed voice when language is nil`() {
        let voices = [
            TalkSystemVoiceCatalog.Voice(id: "fr", name: "Thomas", languageID: "fr-FR", quality: .standard),
        ]

        let resolved = TalkSystemVoiceSelection.resolvedOverride("fr", languageID: nil, allVoices: voices)

        #expect(resolved == "fr")
    }
}
