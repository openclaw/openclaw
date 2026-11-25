import Testing
@testable import OpenClawKit

struct TalkConfigParsingTests {
    @Test(arguments: [nil, "resolved-key"] as [String?])
    func `prefers canonical resolved talk provider payload`(apiKey: String?) {
        var resolvedConfig = ["voiceId": "voice-resolved"]
        if let apiKey { resolvedConfig["apiKey"] = apiKey }
        let talk: [String: AnyCodable] = [
            "resolved": AnyCodable([
                "provider": "elevenlabs",
                "config": resolvedConfig,
            ]),
            "provider": AnyCodable("elevenlabs"),
            "providers": AnyCodable([
                "elevenlabs": [
                    "voiceId": "voice-normalized",
                    "apiKey": "normalized-key",
                ],
            ]),
        ]

        let selection = TalkConfigParsing.selectProviderConfig(talk, defaultProvider: "elevenlabs")
        #expect(selection?.provider == "elevenlabs")
        #expect(selection?.normalizedPayload == true)
        #expect(selection?.config["voiceId"]?.stringValue == "voice-resolved")
        #expect(selection?.config["apiKey"]?.stringValue == apiKey)
    }

    @Test func `rejects normalized talk provider payload without resolved`() {
        let talk: [String: AnyCodable] = [
            "provider": AnyCodable("elevenlabs"),
            "providers": AnyCodable([
                "elevenlabs": [
                    "voiceId": "voice-normalized",
                ],
            ]),
            "voiceId": AnyCodable("voice-legacy"),
        ]

        let selection = TalkConfigParsing.selectProviderConfig(talk, defaultProvider: "elevenlabs")
        #expect(selection == nil)
    }

    @Test func `falls back to legacy talk fields when normalized payload missing`() {
        let talk: [String: AnyCodable] = [
            "voiceId": AnyCodable("voice-legacy"),
            "apiKey": AnyCodable("legacy-key"),
        ]

        let selection = TalkConfigParsing.selectProviderConfig(talk, defaultProvider: "elevenlabs")
        #expect(selection?.provider == "elevenlabs")
        #expect(selection?.normalizedPayload == false)
        #expect(selection?.config["voiceId"]?.stringValue == "voice-legacy")
        #expect(selection?.config["apiKey"]?.stringValue == "legacy-key")
    }

    @Test func `can disable legacy fallback`() {
        let talk: [String: Any] = [
            "voiceId": "voice-legacy",
            "apiKey": "legacy-key",
        ]

        let selection = TalkConfigParsing.selectProviderConfig(
            TalkConfigParsing.bridgeFoundationDictionary(talk),
            defaultProvider: "elevenlabs",
            allowLegacyFallback: false)
        #expect(selection == nil)
    }

    @Test func `rejects normalized payload when multiple providers and no provider`() {
        let talk: [String: AnyCodable] = [
            "providers": AnyCodable([
                "acme": [
                    "voiceId": "voice-acme",
                ],
                "elevenlabs": [
                    "voiceId": "voice-eleven",
                ],
            ]),
        ]

        let selection = TalkConfigParsing.selectProviderConfig(talk, defaultProvider: "elevenlabs")
        #expect(selection == nil)
    }

    @Test func `bridges foundation dictionary`() {
        let raw: [String: Any] = [
            "provider": "elevenlabs",
            "providers": [
                "elevenlabs": [
                    "voiceId": "voice-normalized",
                ],
            ],
            "voiceId": "voice-legacy",
        ]

        let bridged = TalkConfigParsing.bridgeFoundationDictionary(raw)
        #expect(bridged?["provider"]?.stringValue == "elevenlabs")
        let nested = bridged?["providers"]?.dictionaryValue?["elevenlabs"]?.dictionaryValue
        #expect(nested?["voiceId"]?.stringValue == "voice-normalized")
        #expect(TalkConfigParsing.selectProviderConfig(
            bridged,
            defaultProvider: "elevenlabs",
            allowLegacyFallback: false) == nil)
    }

    @Test func `resolves positive integer timeout`() {
        #expect(TalkConfigParsing.resolvedPositiveInt(AnyCodable(1500), fallback: 700) == 1500)
        #expect(TalkConfigParsing.resolvedPositiveInt(AnyCodable(0), fallback: 700) == 700)
        #expect(TalkConfigParsing.resolvedPositiveInt(AnyCodable(true), fallback: 700) == 700)
        #expect(TalkConfigParsing.resolvedPositiveInt(AnyCodable("1500"), fallback: 700) == 700)
    }

    @Test func `resolves silence timeout from Foundation values`() {
        let cases: [(value: Any?, expected: Int)] = [(1500, 1500), (nil, 900), (0, 900), (true, 900)]
        for testCase in cases {
            let talk = testCase.value.map { ["silenceTimeoutMs": $0] }
            #expect(TalkConfigParsing.resolvedSilenceTimeoutMs(
                TalkConfigParsing.bridgeFoundationDictionary(talk),
                fallback: 900) == testCase.expected)
        }
    }

    @Test func `resolves speech locale ID`() {
        #expect(TalkConfigParsing.resolvedSpeechLocaleID(["speechLocale": AnyCodable(" ru_RU ")]) == "ru-RU")
        #expect(TalkConfigParsing
            .resolvedSpeechLocaleID(["speechLocale": AnyCodable("")], fallback: "en-US") == "en-US")
        let bridged = TalkConfigParsing.bridgeFoundationDictionary(["speechLocale": " ru-RU "])
        #expect(TalkConfigParsing.resolvedSpeechLocaleID(bridged) == "ru-RU")
    }

    @Test func `resolves speech recognition locale from supported fallbacks`() {
        let locale = TalkConfigParsing.resolvedSpeechRecognitionLocaleID(
            preferredLocaleIDs: ["zz-ZZ", "fr-FR"],
            supportedLocaleIDs: ["fr-FR", "en-US"])
        let fallback = TalkConfigParsing.resolvedSpeechRecognitionLocaleID(
            preferredLocaleIDs: ["zz-ZZ", "yy-YY"],
            supportedLocaleIDs: ["en-US"])

        #expect(locale == "fr-FR")
        #expect(fallback == "en-US")
    }

    @Test func `snapshot keeps speaker voice precedence separate from voice`() {
        let talk: [String: AnyCodable] = [
            "realtime": AnyCodable([
                "provider": " OpenAI ",
                "model": " top-model ",
                "voice": " top-voice ",
                "providers": ["openai": [
                    "model": "provider-model",
                    "speakerVoice": "provider-speaker",
                    "voice": "provider-voice",
                ]],
            ]),
        ]
        let snapshot = TalkConfigSnapshot(talk, defaultProvider: "elevenlabs", defaultSilenceTimeoutMs: 900)
        #expect(snapshot.realtime.provider == "OpenAI")
        #expect(snapshot.realtime.modelId == "top-model")
        #expect(snapshot.realtime.voice == "top-voice")
        #expect(snapshot.realtime.speakerVoice == "top-voice")
        #expect(snapshot.interruptOnSpeech == nil)

        let speakerOnly = TalkConfigSnapshot(
            [
                "interruptOnSpeech": AnyCodable(false),
                "realtime": AnyCodable([
                    "speakerVoice": " top-speaker ",
                    "providers": ["openai": ["voice": "provider-voice"]],
                ]),
            ],
            defaultProvider: "elevenlabs",
            defaultSilenceTimeoutMs: 900)
        #expect(speakerOnly.realtime.voice == "provider-voice")
        #expect(speakerOnly.realtime.speakerVoice == "top-speaker")
        #expect(speakerOnly.interruptOnSpeech == false)
    }
}
