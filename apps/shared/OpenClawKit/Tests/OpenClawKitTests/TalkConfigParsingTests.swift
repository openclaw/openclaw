import OpenClawKit
import Testing

struct TalkConfigParsingTests {
    @Test func prefersNormalizedTalkProviderPayload() {
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
        #expect(selection?.provider == "elevenlabs")
        #expect(selection?.normalizedPayload == true)
        #expect(selection?.config["voiceId"]?.stringValue == "voice-normalized")
    }

    @Test func fallsBackToLegacyTalkFieldsWhenNormalizedPayloadMissing() {
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

    @Test func canDisableLegacyFallback() {
        let talk: [String: AnyCodable] = [
            "voiceId": AnyCodable("voice-legacy"),
        ]

        let selection = TalkConfigParsing.selectProviderConfig(
            talk,
            defaultProvider: "elevenlabs",
            allowLegacyFallback: false)
        #expect(selection == nil)
    }

    @Test func bridgesFoundationDictionary() {
        let raw: [String: Any] = [
            "provider": "elevenlabs",
            "providers": [
                "elevenlabs": [
                    "voiceId": "voice-normalized",
                ],
            ],
        ]

        let bridged = TalkConfigParsing.bridgeFoundationDictionary(raw)
        #expect(bridged?["provider"]?.stringValue == "elevenlabs")
        let nested = bridged?["providers"]?.dictionaryValue?["elevenlabs"]?.dictionaryValue
        #expect(nested?["voiceId"]?.stringValue == "voice-normalized")
    }

    @Test func resolvesPositiveIntegerTimeout() {
        #expect(TalkConfigParsing.resolvedPositiveInt(AnyCodable(1500), fallback: 700) == 1500)
        #expect(TalkConfigParsing.resolvedPositiveInt(AnyCodable(0), fallback: 700) == 700)
        #expect(TalkConfigParsing.resolvedPositiveInt(AnyCodable(true), fallback: 700) == 700)
        #expect(TalkConfigParsing.resolvedPositiveInt(AnyCodable("1500"), fallback: 700) == 700)
    }
}
