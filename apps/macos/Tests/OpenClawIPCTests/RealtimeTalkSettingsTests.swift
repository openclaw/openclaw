import OpenClawProtocol
import Testing
@testable import OpenClaw

struct RealtimeTalkSettingsTests {
    @Test func `parses top level realtime selection`() {
        let root: [String: Any] = [
            "talk": [
                "realtime": [
                    "provider": "OpenAI",
                    "model": "gpt-live-1-codex",
                    "speakerVoice": "cedar",
                    "mode": "realtime",
                    "transport": "gateway-relay",
                    "brain": "agent-consult",
                ],
            ],
        ]

        let draft = RealtimeTalkSettingsConfig.parse(root)
        #expect(draft.enabled)
        #expect(draft.explicitlyUsesOpenAI)
        #expect(draft.model == "gpt-live-1-codex")
        #expect(draft.voice == "cedar")
    }

    @Test func `does not enable realtime when brain is missing or unsupported`() {
        for brain in [nil, "client-direct"] as [String?] {
            var realtime: [String: Any] = [
                "provider": "openai",
                "mode": "realtime",
                "transport": "gateway-relay",
            ]
            if let brain {
                realtime["brain"] = brain
            }

            let draft = RealtimeTalkSettingsConfig.parse([
                "talk": ["realtime": realtime],
            ])

            #expect(!draft.enabled)
            #expect(draft.explicitlyUsesOpenAI)
        }
    }

    @Test func `parses provider defaults without enabling realtime`() {
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

    @Test func `applied model and voice survive a config reload`() {
        let selected = RealtimeTalkSettingsDraft(
            enabled: true,
            model: "gpt-live-1-codex",
            voice: "cedar",
            explicitlyUsesOpenAI: true)

        let saved = RealtimeTalkSettingsConfig.applying(selected, to: [:])
        let reloaded = RealtimeTalkSettingsConfig.parse(saved)

        #expect(reloaded == selected)
    }

    @Test func `enabling adds canonical openai entry to an existing provider map`() throws {
        let root: [String: Any] = [
            "talk": [
                "realtime": [
                    "providers": [
                        "google": ["model": "gemini-live"],
                    ],
                ],
            ],
        ]
        let draft = RealtimeTalkSettingsDraft(
            enabled: true,
            model: "gpt-live-1-codex",
            voice: "cedar",
            explicitlyUsesOpenAI: false)

        let updated = RealtimeTalkSettingsConfig.applying(draft, to: root)
        let talk = try #require(updated["talk"] as? [String: Any])
        let realtime = try #require(talk["realtime"] as? [String: Any])
        let providers = try #require(realtime["providers"] as? [String: Any])
        let google = try #require(providers["google"] as? [String: Any])
        let openAI = try #require(providers["openai"] as? [String: Any])
        #expect(realtime["provider"] as? String == "openai")
        #expect(google["model"] as? String == "gemini-live")
        #expect(openAI["model"] as? String == "gpt-live-1-codex")
        #expect(openAI["speakerVoice"] as? String == "cedar")
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
        draft.model = "gpt-realtime-2.1"
        draft.voice = "marin"

        let updated = RealtimeTalkSettingsConfig.applying(draft, to: root)
        let talk = try #require(updated["talk"] as? [String: Any])
        let realtime = try #require(talk["realtime"] as? [String: Any])
        #expect(realtime["mode"] == nil)
        #expect(realtime["transport"] == nil)
        #expect(realtime["brain"] == nil)
        #expect(realtime["provider"] as? String == "openai")
        #expect(realtime["model"] as? String == "gpt-realtime-2.1")
        #expect(realtime["speakerVoice"] as? String == "marin")
        #expect(realtime["instructions"] as? String == "Be concise")
        let providers = try #require(realtime["providers"] as? [String: Any])
        let openAI = try #require(providers["openai"] as? [String: Any])
        #expect(openAI["model"] as? String == "gpt-realtime-2.1")
        #expect(openAI["speakerVoice"] as? String == "marin")
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

    @Test func `storing disabled openai options preserves another selected provider`() throws {
        let root: [String: Any] = [
            "talk": [
                "realtime": [
                    "provider": "google",
                    "model": "gemini-live",
                    "speakerVoice": "Kore",
                    "mode": "realtime",
                    "transport": "gateway-relay",
                    "providers": [
                        "google": ["model": "gemini-live"],
                        "openai": ["model": "gpt-realtime-2.1"],
                    ],
                ],
            ],
        ]
        var draft = RealtimeTalkSettingsConfig.parse(root)
        #expect(!draft.enabled)
        draft.model = "gpt-live-1-codex"
        draft.voice = "cedar"

        let updated = RealtimeTalkSettingsConfig.applying(draft, to: root)
        let talk = try #require(updated["talk"] as? [String: Any])
        let realtime = try #require(talk["realtime"] as? [String: Any])
        let providers = try #require(realtime["providers"] as? [String: Any])
        let openAI = try #require(providers["openai"] as? [String: Any])
        #expect(realtime["provider"] as? String == "google")
        #expect(realtime["model"] as? String == "gemini-live")
        #expect(realtime["speakerVoice"] as? String == "Kore")
        #expect(realtime["mode"] as? String == "realtime")
        #expect(realtime["transport"] as? String == "gateway-relay")
        #expect(openAI["model"] as? String == "gpt-live-1-codex")
        #expect(openAI["speakerVoice"] as? String == "cedar")
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
                        "transports": ["webrtc", "gateway-relay"],
                        "brains": ["agent-consult"],
                    ],
                ]),
            ])

        let provider = try #require(RealtimeTalkSettingsConfig.openAIProvider(in: catalog))
        #expect(provider.configured)
        #expect(provider.models == ["gpt-realtime-2.1", "gpt-live-1-codex"])
        #expect(provider.voices == ["marin", "cedar"])
        #expect(provider.transports == ["webrtc", "gateway-relay"])
        #expect(provider.brains == ["agent-consult"])
        #expect(provider.supportsGatewayRelayAgentConsult)
    }

    @Test(arguments: [
        (["webrtc", "gateway-relay"], ["agent-consult"], true),
        (["webrtc"], ["agent-consult"], false),
        (["webrtc", "gateway-relay"], ["none"], false),
        ([String](), [String](), false),
    ])
    func `relay readiness requires the exact configuration this card writes`(
        transports: [String],
        brains: [String],
        expected: Bool) throws
    {
        let catalog = TalkCatalogResult(
            modes: [],
            transports: [],
            brains: [],
            speech: [:],
            transcription: [:],
            realtime: [
                "providers": AnyCodable([
                    [
                        "id": "openai",
                        "configured": true,
                        "transports": transports,
                        "brains": brains,
                    ] as [String: Any],
                ]),
            ])

        let provider = try #require(RealtimeTalkSettingsConfig.openAIProvider(in: catalog))
        #expect(provider.supportsGatewayRelayAgentConsult == expected)
    }

    @Test func `catalog readiness only gates the model it was evaluated for`() {
        // talk.catalog takes no parameters and resolves `configured` from the saved realtime
        // model, so an OAuth-only GPT-Live user with a saved GA selection is reported
        // unconfigured. Blocking on that verdict kept them from switching to GPT-Live at all.
        let switchingToGptLive = RealtimeTalkSettingsModel.canEnable(
            availability: .needsOpenAIAccess,
            draftModel: "gpt-live-1-codex",
            draftEnabled: false,
            readinessModel: "gpt-realtime-2.1")
        let stayingOnTheEvaluatedModel = RealtimeTalkSettingsModel.canEnable(
            availability: .needsOpenAIAccess,
            draftModel: "gpt-realtime-2.1",
            draftEnabled: false,
            readinessModel: "gpt-realtime-2.1")
        let beforeAnyCatalogAnswer = RealtimeTalkSettingsModel.canEnable(
            availability: .needsOpenAIAccess,
            draftModel: "gpt-live-1-codex",
            draftEnabled: false,
            readinessModel: nil)
        let gatewayUnavailable = RealtimeTalkSettingsModel.canEnable(
            availability: .unavailable("no route"),
            draftModel: "gpt-live-1-codex",
            draftEnabled: false,
            readinessModel: "gpt-realtime-2.1")

        #expect(switchingToGptLive)
        #expect(!stayingOnTheEvaluatedModel)
        #expect(!beforeAnyCatalogAnswer)
        #expect(!gatewayUnavailable)
    }

    @Test func `enabling gpt-live clears forced consult routing but keeps it for GA models`() throws {
        let root: [String: Any] = [
            "talk": ["realtime": ["consultRouting": "force-agent-consult"]],
        ]

        let gptLive = RealtimeTalkSettingsConfig.applying(
            RealtimeTalkSettingsDraft(
                enabled: true,
                model: "gpt-live-1-codex",
                voice: "cedar",
                explicitlyUsesOpenAI: true),
            to: root)
        let gaRealtime = RealtimeTalkSettingsConfig.applying(
            RealtimeTalkSettingsDraft(
                enabled: true,
                model: "gpt-realtime-2.1",
                voice: "cedar",
                explicitlyUsesOpenAI: true),
            to: root)

        let gptLiveRealtime = try #require(
            (gptLive["talk"] as? [String: Any])?["realtime"] as? [String: Any])
        let gaRealtimeValues = try #require(
            (gaRealtime["talk"] as? [String: Any])?["realtime"] as? [String: Any])

        // The provider rejects GPT-Live gateway-relay launches that force consult routing, so
        // saving both would persist an enabled state no Talk session can start.
        #expect(gptLiveRealtime["consultRouting"] == nil)
        #expect(gptLiveRealtime["brain"] as? String == "agent-consult")
        #expect(gaRealtimeValues["consultRouting"] as? String == "force-agent-consult")
    }
}
