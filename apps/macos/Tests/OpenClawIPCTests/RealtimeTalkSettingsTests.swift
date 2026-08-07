import OpenClawProtocol
import Testing
@testable import OpenClaw

@Suite
struct RealtimeTalkSettingsTests {
    @Test func `parses top level realtime selection`() throws {
        let root: [String: Any] = [
            "talk": [
                "realtime": [
                    "provider": "OpenAI",
                    "model": "gpt-live-1-codex",
                    "speakerVoice": "cedar",
                    "mode": "realtime",
                    "transport": "gateway-relay",
                ],
            ],
        ]

        let draft = RealtimeTalkSettingsConfig.parse(root)
        #expect(draft.enabled)
        #expect(draft.explicitlyUsesOpenAI)
        #expect(draft.model == "gpt-live-1-codex")
        #expect(draft.voice == "cedar")
    }

    @Test func `parses provider defaults without enabling realtime`() throws {
        let root: [String: Any] = [
            "talk": [
                "realtime": [
                    "providers": [
                        "OPENAI": [
                            "model": "gpt-realtime-2.1",
                            "speakerVoice": "marin",
                        ],
                    ],
                ],
            ],
        ]

        let draft = RealtimeTalkSettingsConfig.parse(root)
        #expect(!draft.enabled)
        #expect(draft.explicitlyUsesOpenAI)
        #expect(draft.model == "gpt-realtime-2.1")
        #expect(draft.voice == "marin")
    }

    @Test func `applying enabled draft preserves unrelated talk settings`() throws {
        let root: [String: Any] = [
            "talk": [
                "provider": "system",
                "interruptOnSpeech": false,
                "realtime": ["instructions": "Be concise"],
            ],
            "ui": ["seamColor": "#ff00ff"],
        ]
        let draft = RealtimeTalkSettingsDraft(
            enabled: true,
            model: "gpt-live-1-codex",
            voice: "cedar",
            explicitlyUsesOpenAI: true)

        let updated = RealtimeTalkSettingsConfig.applying(draft, to: root)
        let talk = try #require(updated["talk"] as? [String: Any])
        let realtime = try #require(talk["realtime"] as? [String: Any])
        #expect(talk["provider"] as? String == "system")
        #expect(talk["interruptOnSpeech"] as? Bool == false)
        #expect(realtime["instructions"] as? String == "Be concise")
        #expect(realtime["provider"] as? String == "openai")
        #expect(realtime["model"] as? String == "gpt-live-1-codex")
        #expect(realtime["speakerVoice"] as? String == "cedar")
        #expect(realtime["mode"] as? String == "realtime")
        #expect(realtime["transport"] as? String == "gateway-relay")
        #expect(realtime["brain"] as? String == "agent-consult")
    }

    @Test func `disabling removes only managed runtime selectors`() throws {
        let root: [String: Any] = [
            "talk": [
                "realtime": [
                    "provider": "openai",
                    "model": "gpt-live-1-codex",
                    "speakerVoice": "cedar",
                    "mode": "realtime",
                    "transport": "gateway-relay",
                    "brain": "agent-consult",
                    "instructions": "Be concise",
                ],
            ],
        ]
        var draft = RealtimeTalkSettingsConfig.parse(root)
        draft.enabled = false

        let updated = RealtimeTalkSettingsConfig.applying(draft, to: root)
        let talk = try #require(updated["talk"] as? [String: Any])
        let realtime = try #require(talk["realtime"] as? [String: Any])
        #expect(realtime["mode"] == nil)
        #expect(realtime["transport"] == nil)
        #expect(realtime["brain"] == nil)
        #expect(realtime["provider"] as? String == "openai")
        #expect(realtime["model"] as? String == "gpt-live-1-codex")
        #expect(realtime["instructions"] as? String == "Be concise")
    }

    @Test func `disabling inferred openai provider removes managed selectors`() throws {
        let root: [String: Any] = [
            "talk": [
                "realtime": [
                    "providers": ["openai": ["model": "gpt-realtime-2.1"]],
                    "mode": "realtime",
                    "transport": "gateway-relay",
                    "brain": "agent-consult",
                ],
            ],
        ]
        var draft = RealtimeTalkSettingsConfig.parse(root)
        #expect(draft.enabled)
        draft.enabled = false

        let updated = RealtimeTalkSettingsConfig.applying(draft, to: root)
        let talk = try #require(updated["talk"] as? [String: Any])
        let realtime = try #require(talk["realtime"] as? [String: Any])
        #expect(realtime["mode"] == nil)
        #expect(realtime["transport"] == nil)
        #expect(realtime["brain"] == nil)
        #expect(realtime["providers"] != nil)
    }

    @Test func `catalog parser exposes only openai readiness and options`() throws {
        let catalog = TalkCatalogResult(
            modes: [],
            transports: [],
            brains: [],
            speech: [:],
            transcription: [:],
            realtime: [
                "providers": AnyCodable([
                    ["id": "google", "configured": true],
                    [
                        "id": "openai",
                        "configured": true,
                        "models": ["gpt-realtime-2.1", "gpt-live-1-codex"],
                        "voices": ["marin", "cedar"],
                    ],
                ]),
            ])

        let provider = try #require(RealtimeTalkSettingsConfig.openAIProvider(in: catalog))
        #expect(provider.configured)
        #expect(provider.models == ["gpt-realtime-2.1", "gpt-live-1-codex"])
        #expect(provider.voices == ["marin", "cedar"])
    }
}
