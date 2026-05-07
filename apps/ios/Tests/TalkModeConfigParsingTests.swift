import Foundation
import Testing
@testable import OpenClaw

@MainActor
@Suite struct TalkModeManagerTests {
    @Test func defaultsTalkModeConfigToDeluxeEngineAndFlashVoiceModel() {
        let parsed = TalkModeGatewayConfigParser.parse(
            config: ["talk": [:]],
            defaultProvider: "elevenlabs",
            defaultModelIdFallback: "eleven_flash_v2_5",
            defaultSilenceTimeoutMs: 900)

        #expect(parsed.conversationEngine == "deluxe-thomas")
        #expect(parsed.defaultModelId == "eleven_flash_v2_5")
    }

    @Test func readsConfiguredConversationEngine() {
        let parsed = TalkModeGatewayConfigParser.parse(
            config: ["talk": ["conversationEngine": "local-thomas"]],
            defaultProvider: "elevenlabs",
            defaultModelIdFallback: "eleven_flash_v2_5",
            defaultSilenceTimeoutMs: 900)

        #expect(parsed.conversationEngine == "local-thomas")
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
