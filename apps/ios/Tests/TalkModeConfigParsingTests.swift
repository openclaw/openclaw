import Foundation
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

    @Test func detectsPCMFormatRejectionFromElevenLabsError() {
        let error = NSError(
            domain: "ElevenLabsTTS",
            code: 403,
            userInfo: [
                NSLocalizedDescriptionKey: "ElevenLabs failed: 403 subscription_required output_format=pcm_44100",
            ])
        #expect(TalkModeManager._test_isPCMFormatRejectedByAPI(error))
    }

    @Test func ignoresGenericPlaybackFailuresForPCMFormatRejection() {
        let error = NSError(
            domain: "StreamingAudio",
            code: -1,
            userInfo: [NSLocalizedDescriptionKey: "queue enqueue failed"])
        #expect(TalkModeManager._test_isPCMFormatRejectedByAPI(error) == false)
    }
}
