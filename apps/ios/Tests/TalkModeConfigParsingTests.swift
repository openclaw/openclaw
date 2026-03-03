import Testing
@testable import OpenClaw

@MainActor
@Suite struct TalkModeConfigParsingTests {
    @Test func prefersNormalizedTalkProviderPayload() {
        let talk: [String: Any] = [
            "provider": "elevenlabs",
            "providers": [
                "elevenlabs": [
                    "voiceId": "voice-normalized",
                ],
            ],
            "voiceId": "voice-legacy",
        ]

        let selection = TalkModeManager.selectTalkProviderConfig(talk)
        #expect(selection?.provider == "elevenlabs")
        #expect(selection?.config["voiceId"] as? String == "voice-normalized")
    }

    @Test func ignoresLegacyTalkFieldsWhenNormalizedPayloadMissing() {
        let talk: [String: Any] = [
            "voiceId": "voice-legacy",
            "apiKey": "legacy-key",
        ]

        let selection = TalkModeManager.selectTalkProviderConfig(talk)
        #expect(selection == nil)
    }
}
