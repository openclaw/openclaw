import OpenClawProtocol
import Testing
@testable import OpenClaw

struct TalkModeConfigParsingTests {
    @Test func `prefers normalized talk provider payload`() {
        let talk: [String: AnyCodable] = [
            "provider": AnyCodable("elevenlabs"),
            "providers": AnyCodable([
                "elevenlabs": [
                    "voiceId": "voice-normalized",
                ],
            ]),
            "voiceId": AnyCodable("voice-legacy"),
        ]

        let selection = TalkModeRuntime.selectTalkProviderConfig(talk)
        #expect(selection?.provider == "elevenlabs")
        #expect(selection?.normalizedPayload == true)
        #expect(selection?.config["voiceId"]?.stringValue == "voice-normalized")
    }

    @Test func `falls back to legacy talk fields when normalized payload missing`() {
        let talk: [String: AnyCodable] = [
            "voiceId": AnyCodable("voice-legacy"),
            "apiKey": AnyCodable("legacy-key"),
        ]

        let selection = TalkModeRuntime.selectTalkProviderConfig(talk)
        #expect(selection?.provider == "elevenlabs")
        #expect(selection?.normalizedPayload == false)
        #expect(selection?.config["voiceId"]?.stringValue == "voice-legacy")
        #expect(selection?.config["apiKey"]?.stringValue == "legacy-key")
    }

    @Test func readsConfiguredSilenceTimeoutMs() {
        let talk: [String: AnyCodable] = [
            "silenceTimeoutMs": AnyCodable(1500),
        ]

        #expect(TalkModeRuntime.resolvedSilenceTimeoutMs(talk) == 1500)
    }

    @Test func defaultsSilenceTimeoutMsWhenMissing() {
        #expect(TalkModeRuntime.resolvedSilenceTimeoutMs(nil) == 700)
    }

    @Test func defaultsSilenceTimeoutMsWhenInvalid() {
        let talk: [String: AnyCodable] = [
            "silenceTimeoutMs": AnyCodable(0),
        ]

        #expect(TalkModeRuntime.resolvedSilenceTimeoutMs(talk) == 700)
    }
}
