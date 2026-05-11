import OpenClawProtocol
import Testing
@testable import OpenClaw

struct TalkModeGatewayConfigTests {
    @Test func `openai provider keeps realtime model separate from native speech model`() {
        let snapshot = ConfigSnapshot(
            path: nil,
            exists: true,
            raw: nil,
            hash: nil,
            parsed: nil,
            valid: true,
            config: [
                "talk": AnyCodable([
                    "provider": "openai",
                    "providers": [
                        "openai": [
                            "model": "gpt-realtime-mini",
                            "modelId": "gpt-4o-mini-tts",
                            "voice": "cedar",
                        ],
                    ],
                    "resolved": [
                        "provider": "openai",
                        "config": [
                            "model": "gpt-realtime-mini",
                            "modelId": "gpt-4o-mini-tts",
                            "voice": "cedar",
                        ],
                    ],
                ]),
            ],
            issues: nil)

        let parsed = TalkModeGatewayConfigParser.parse(
            snapshot: snapshot,
            defaultProvider: "openai",
            defaultModelIdFallback: "gpt-4o-mini-tts",
            defaultSilenceTimeoutMs: TalkDefaults.silenceTimeoutMs,
            envVoice: nil,
            sagVoice: nil,
            envApiKey: nil)

        #expect(parsed.activeProvider == "openai")
        #expect(parsed.modelId == "gpt-4o-mini-tts")
        #expect(parsed.voiceId == "cedar")
    }

    @Test func `mlx provider does not inherit elevenlabs defaults`() {
        let snapshot = ConfigSnapshot(
            path: nil,
            exists: true,
            raw: nil,
            hash: nil,
            parsed: nil,
            valid: true,
            config: [
                "talk": AnyCodable([
                    "provider": "mlx",
                    "providers": [
                        "mlx": [
                            "voiceId": "unused-voice",
                        ],
                    ],
                    "resolved": [
                        "provider": "mlx",
                        "config": [
                            "voiceId": "unused-voice",
                        ],
                    ],
                    "speechLocale": "ru-RU",
                ]),
            ],
            issues: nil)

        let parsed = TalkModeGatewayConfigParser.parse(
            snapshot: snapshot,
            defaultProvider: "elevenlabs",
            defaultModelIdFallback: "eleven_v3",
            defaultSilenceTimeoutMs: TalkDefaults.silenceTimeoutMs,
            envVoice: "env-voice",
            sagVoice: "sag-voice",
            envApiKey: "env-key")

        #expect(parsed.activeProvider == "mlx")
        #expect(parsed.modelId == nil)
        #expect(parsed.apiKey == nil)
        #expect(parsed.voiceId == "unused-voice")
        #expect(parsed.speechLocaleID == "ru-RU")
    }
}
