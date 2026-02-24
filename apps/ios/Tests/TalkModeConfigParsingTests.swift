import Testing
@testable import OpenClaw

@Suite struct TalkModeConfigParsingTests {
    @Test func prefersNormalizedTalkProviderPayload() async {
        let talk: [String: Any] = [
            "provider": "elevenlabs",
            "providers": [
                "elevenlabs": [
                    "voiceId": "voice-normalized",
                ],
            ],
            "voiceId": "voice-legacy",
        ]

        let selection = await MainActor.run { TalkModeManager.selectTalkProviderConfig(talk) }
        #expect(selection?.provider == "elevenlabs")
        #expect(selection?.normalizedPayload == true)
        #expect(selection?.config["voiceId"] as? String == "voice-normalized")
    }

    @Test func fallsBackToLegacyTalkFieldsWhenNormalizedPayloadMissing() async {
        let talk: [String: Any] = [
            "voiceId": "voice-legacy",
            "apiKey": "legacy-key",
        ]

        let selection = await MainActor.run { TalkModeManager.selectTalkProviderConfig(talk) }
        #expect(selection?.provider == "elevenlabs")
        #expect(selection?.normalizedPayload == false)
        #expect(selection?.config["voiceId"] as? String == "voice-legacy")
        #expect(selection?.config["apiKey"] as? String == "legacy-key")
    }
}
