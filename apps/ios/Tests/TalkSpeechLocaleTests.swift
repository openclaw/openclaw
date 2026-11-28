import Foundation
import Testing
@testable import OpenClaw

struct TalkSpeechLocaleTests {
    @Test func `system voice keeps BCP 47 locale separate from provider language`() {
        let parsed = TalkModeGatewayConfigParser.parse(
            config: ["talk": ["speechLocale": "tr_TR"]],
            defaultProvider: "elevenlabs",
            defaultModelIdFallback: "eleven_v3",
            defaultRealtimeModelIdFallback: "gpt-realtime-2",
            defaultSilenceTimeoutMs: 900)
        let configured = TalkSpeechLocale.resolvedLanguages(
            directiveLanguage: nil,
            gatewaySelection: parsed.snapshot.speechLocaleID,
            isSystemVoiceAvailable: { _ in true })
        let directive = TalkSpeechLocale.resolvedLanguages(
            directiveLanguage: "de_DE",
            gatewaySelection: parsed.snapshot.speechLocaleID,
            isSystemVoiceAvailable: { _ in true })
        let providerCompatible = TalkSpeechLocale.resolvedLanguages(
            directiveLanguage: "tr",
            gatewaySelection: parsed.snapshot.speechLocaleID,
            isSystemVoiceAvailable: { _ in true })
        let unavailableDirective = TalkSpeechLocale.resolvedLanguages(
            directiveLanguage: "zz-ZZ",
            gatewaySelection: parsed.snapshot.speechLocaleID,
            isSystemVoiceAvailable: { $0 == "tr-TR" })

        #expect(configured.provider == nil)
        #expect(configured.systemVoice == "tr-TR")
        #expect(directive.provider == nil)
        #expect(directive.systemVoice == "de-DE")
        #expect(providerCompatible.provider == "tr")
        #expect(providerCompatible.systemVoice == "tr")
        #expect(unavailableDirective.provider == nil)
        #expect(unavailableDirective.systemVoice == "tr-TR")
    }

    @Test @MainActor func `talk manager clears retired speech locale preference`() {
        let defaults = UserDefaults.standard
        let previous = defaults.object(forKey: "talk.speechLocale")
        defaults.set("de-DE", forKey: "talk.speechLocale")
        defer {
            if let previous {
                defaults.set(previous, forKey: "talk.speechLocale")
            } else {
                defaults.removeObject(forKey: "talk.speechLocale")
            }
        }

        _ = TalkModeManager(allowSimulatorCapture: true)

        #expect(defaults.object(forKey: "talk.speechLocale") == nil)
    }

    private static let supported: Set<String> = ["en-US", "en-GB", "pt-BR", "pt-PT", "fr-FR", "ru-RU"]

    @Test func `a choice on the phone wins over the Gateway and Automatic`() {
        let locale = TalkSpeechLocale.resolvedLocaleID(
            phoneSelection: "pt-BR",
            gatewaySelection: "ru_RU",
            automaticCandidates: ["en-BR"],
            supportedLocaleIDs: Self.supported)
        #expect(locale == "pt-BR")
    }

    @Test(arguments: [nil, ""] as [String?])
    func `without a phone choice the Gateway's locale wins over Automatic`(phoneSelection: String?) {
        let locale = TalkSpeechLocale.resolvedLocaleID(
            phoneSelection: phoneSelection,
            gatewaySelection: "ru_RU",
            automaticCandidates: ["pt-BR"],
            supportedLocaleIDs: Self.supported)
        #expect(locale == "ru-RU")
    }

    @Test(arguments: [nil, "auto", "zz-ZZ"] as [String?])
    func `Automatic takes the first supported phone language, then keyboards, then English`(gateway: String?) {
        // English UI with region Brazil and a Portuguese keyboard: English comes first, as the phone says.
        let english = TalkSpeechLocale.resolvedLocaleID(
            phoneSelection: nil,
            gatewaySelection: gateway,
            automaticCandidates: TalkSpeechLocale.automaticCandidates(
                preferredLanguages: ["en-BR"],
                keyboardLanguages: ["pt-BR", "en-US"]),
            supportedLocaleIDs: Self.supported)
        #expect(english == "en-US")
        // An unsupported preferred language gives way to the keyboard.
        let keyboard = TalkSpeechLocale.resolvedLocaleID(
            phoneSelection: nil,
            gatewaySelection: gateway,
            automaticCandidates: TalkSpeechLocale.automaticCandidates(
                preferredLanguages: ["yy-YY"],
                keyboardLanguages: ["pt_BR"]),
            supportedLocaleIDs: Self.supported)
        #expect(keyboard == "pt-BR")
        let fallback = TalkSpeechLocale.resolvedLocaleID(
            phoneSelection: nil,
            gatewaySelection: gateway,
            automaticCandidates: ["yy-YY"],
            supportedLocaleIDs: Self.supported)
        #expect(fallback == "en-US")
    }

    @Test func `Automatic lists preferred languages before keyboards, once each`() {
        #expect(TalkSpeechLocale.automaticCandidates(
            preferredLanguages: ["en-BR", "pt-BR"],
            keyboardLanguages: ["pt_BR", "fr-FR"]) == ["en-BR", "pt-BR", "fr-FR"])
    }

    @Test func `a language without its exact region finds its usual one`() {
        #expect(TalkSpeechLocale.supportedMatch(for: "en-BR", in: Self.supported) == "en-US")
        #expect(TalkSpeechLocale.supportedMatch(for: "pt", in: Self.supported) == "pt-BR")
        #expect(TalkSpeechLocale.supportedMatch(for: "pt-PT", in: Self.supported) == "pt-PT")
        #expect(TalkSpeechLocale.supportedMatch(for: "yy-YY", in: Self.supported) == nil)
    }

    @Test @MainActor func `the picker puts the phone's languages first, named in their own language`() {
        let choices = TalkSpeechLocale.choices(
            automaticCandidates: ["en-BR", "pt-BR"],
            supportedLocaleIDs: Self.supported)
        #expect(choices.phone.map(\.id) == ["en-US", "pt-BR"])
        #expect(choices.phone.last?.name.hasPrefix("Português") == true)
        #expect(!choices.others.map(\.id).contains("pt-BR"))
        #expect(choices.others.map(\.id).contains("fr-FR"))
    }

    @Test func `speech synthesis prefers directive locale`() {
        let locale = TalkSpeechLocale.resolvedSynthesisLocaleID(
            directiveLanguage: " tr_TR ",
            gatewaySelection: "ru-RU",
            isVoiceAvailable: { _ in true })

        #expect(locale == "tr-TR")
    }

    @Test func `speech synthesis uses gateway locale`() {
        let gateway = TalkSpeechLocale.resolvedSynthesisLocaleID(
            directiveLanguage: nil,
            gatewaySelection: "ru_RU",
            isVoiceAvailable: { _ in true })

        #expect(gateway == "ru-RU")
    }

    @Test func `automatic speech synthesis uses system default without gateway locale`() {
        let locale = TalkSpeechLocale.resolvedSynthesisLocaleID(
            directiveLanguage: nil,
            gatewaySelection: nil,
            isVoiceAvailable: { _ in true })

        #expect(locale == nil)
    }

    @Test func `unavailable directive falls through to gateway voice`() {
        let locale = TalkSpeechLocale.resolvedSynthesisLocaleID(
            directiveLanguage: "zz-ZZ",
            gatewaySelection: "tr_TR",
            isVoiceAvailable: { $0 == "tr-TR" })

        #expect(locale == "tr-TR")
    }

    @Test func `unavailable candidates use system default only after every candidate fails`() {
        var checkedLocaleIDs: [String] = []
        let locale = TalkSpeechLocale.resolvedSynthesisLocaleID(
            directiveLanguage: "zz-ZZ",
            gatewaySelection: "tr-TR",
            isVoiceAvailable: {
                checkedLocaleIDs.append($0)
                return false
            })

        #expect(locale == nil)
        #expect(checkedLocaleIDs == ["zz-ZZ", "tr-TR"])
    }
}
