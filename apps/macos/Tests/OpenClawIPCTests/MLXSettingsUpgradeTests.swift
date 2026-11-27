import Foundation
import OpenClawKit
import Testing
@testable import OpenClaw

private enum MLXSettingsProof {
    static let model = "openclaw-test-owned-retained-model"
    static var provider: [String: Any] {
        [
            "modelId": self.model, "voiceId": "retained-proof-voice", "outputFormat": "pcm_32000",
            "referenceAudioPath": "test-owned-reference.wav", "referenceText": "Retained reference text.",
        ]
    }

    static func stateFile(_ name: String) -> URL {
        OpenClawPaths.configURL.deletingLastPathComponent().appendingPathComponent(name)
    }

    // Ordinary app suites must never seed or clear the retained proof profile.
    // Only its resource owner writes this stage marker before a focused launch.
    static func isRequested(_ stage: String) -> Bool {
        guard AppProfile.current.name?.hasPrefix("test-") == true,
              ProcessInfo.processInfo.environment["CI"] == "true"
        else { return false }
        return (try? String(contentsOf: self.stateFile("mlx-settings-stage"), encoding: .utf8)) == stage
    }
}

@Suite(.serialized)
struct MLXSettingsSeedProofTests {
    @MainActor
    @Test(.enabled(if: MLXSettingsProof.isRequested("MLXSettingsSeedProofTests")))
    func seedStableSettings() throws {
        #expect(AppProfile.current.name?.hasPrefix("test-") == true)
        #expect(!FileManager.default.fileExists(atPath: OpenClawPaths.configURL.path))
        AppDefaults.standard.set(true, forKey: talkRealtimeRelayEnabledKey)
        #expect(AppDefaults.standard.synchronize())
        #expect(isTalkRealtimeRelayEnabled())
        #expect(OpenClawConfigFile.saveDict([
            "talk": [
                "provider": "mlx", "providers": ["mlx": MLXSettingsProof.provider],
                "interruptOnSpeech": false, "silenceTimeoutMs": 731, "speechLocale": "en-GB",
                "consultThinkingLevel": "high", "consultFastMode": true,
            ],
        ]))
        // Preserve the actual stable writer's defaults and metadata, not a projection.
        let bytes = try Data(contentsOf: OpenClawPaths.configURL)
        try bytes.write(to: MLXSettingsProof.stateFile("stable-written-config.json"), options: .atomic)
    }
}

@Suite(.serialized)
struct MLXSettingsConsumerProofTests {
    @MainActor
    @Test(.enabled(if: MLXSettingsProof.isRequested("MLXSettingsConsumerProofTests")))
    func loadRetainedSettingsThroughGateway() throws {
        let before = try Data(contentsOf: MLXSettingsProof.stateFile("stable-written-config.json"))
        #expect(try Data(contentsOf: OpenClawPaths.configURL) == before)
        let raw = try #require(OpenClawConfigFile.loadDictIfReadable())
        let talk = try #require(raw["talk"] as? [String: Any])
        #expect(talk["resolved"] == nil)
        #expect(isTalkRealtimeRelayEnabled())
        let bytes = try Data(contentsOf: MLXSettingsProof.stateFile("talk-config-response.json"))
        let snapshot = try JSONDecoder().decode(ConfigSnapshot.self, from: bytes)
        let state = TalkModeGatewayConfigParser.parse(
            snapshot: snapshot, defaultProvider: "elevenlabs",
            defaultModelIdFallback: "must-not-use-default-model", defaultSilenceTimeoutMs: 9876,
            envVoice: nil, sagVoice: nil, envApiKey: nil)
        #expect(state.snapshot.normalizedPayload)
        #expect(!state.snapshot.missingResolvedPayload)
        #expect(state.snapshot.activeProvider == "mlx")
        #expect(state.modelId == MLXSettingsProof.model)
        #expect(state.voiceId == "retained-proof-voice")
        #expect(state.outputFormat == "pcm_32000")
        #expect(state.referenceAudioPath == "test-owned-reference.wav")
        #expect(state.referenceText == "Retained reference text.")
        #expect(!state.interruptOnSpeech)
        #expect(state.snapshot.silenceTimeoutMs == 731)
        #expect(state.snapshot.speechLocaleID == "en-GB")
        let returned = try JSONSerialization.jsonObject(with: bytes) as? [String: Any]
        let config = returned?["config"] as? [String: Any]
        let returnedTalk = config?["talk"] as? [String: Any]
        #expect(returnedTalk?["consultThinkingLevel"] as? String == "high")
        #expect(returnedTalk?["consultFastMode"] as? Bool == true)
        #expect(try Data(contentsOf: OpenClawPaths.configURL) == before)
    }
}

@Suite(.serialized)
struct MLXSettingsCleanupProofTests {
    @MainActor
    @Test(.enabled(if: MLXSettingsProof.isRequested("MLXSettingsCleanupProofTests")))
    func removeOwnedPreferenceSuite() throws {
        let suite = try #require(AppProfile.current.defaultsSuiteName)
        #expect(AppProfile.current.name?.hasPrefix("test-") == true)
        AppDefaults.standard.removePersistentDomain(forName: suite)
        #expect(AppDefaults.standard.synchronize())
        #expect(AppDefaults.standard.persistentDomain(forName: suite)?.isEmpty != false)
    }
}
