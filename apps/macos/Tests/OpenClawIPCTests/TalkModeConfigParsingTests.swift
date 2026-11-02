import Foundation
import OpenClawKit
import OpenClawProtocol
import Testing
@testable import OpenClaw

struct TalkModeConfigParsingTests {
    @Test(arguments: [
        ("ja-JP", "en-US", 700, "ja-JP", 2.0),
        ("en-US", "ko-KR", 700, "en-US", 0.7),
        ("zz-ZZ", "ja-JP", 700, "ja-JP", 2.0),
        ("zz-ZZ", "en-US", 700, "en-US", 0.7),
        ("ko-KR", "en-US", 2500, "ko-KR", 2.5),
        ("zh-TW", "en-US", 700, "zh-TW", 2.0),
    ])
    func `native pause window follows the supported recognition language`(
        preferred: String,
        voiceWake: String,
        configuredTimeoutMs: Int,
        expectedLocale: String,
        expectedWindow: Double) throws
    {
        let selected = try #require(TalkConfigParsing.resolvedSpeechRecognitionLocaleID(
            preferredLocaleIDs: [preferred, voiceWake],
            supportedLocaleIDs: ["en-US", "ja-JP", "ko-KR", "zh-TW"]))
        #expect(selected == expectedLocale)
        #expect(TalkModeRuntime.nativeSilenceWindow(
            configuredTimeoutMs: configuredTimeoutMs,
            recognitionLocale: Locale(identifier: selected)) == expectedWindow)
    }

    @Test func `rejects normalized talk provider payload without resolved`() {
        let talk: [String: AnyCodable] = [
            "provider": AnyCodable("elevenlabs"),
            "providers": AnyCodable([
                "elevenlabs": [
                    "voiceId": "voice-normalized",
                ],
            ]),
            "voiceId": AnyCodable("voice-legacy"),
        ]

        let selection = TalkConfigParsing.selectProviderConfig(
            talk,
            defaultProvider: TalkModeRuntime.defaultTalkProvider)
        #expect(selection == nil)
    }

    @Test func `falls back to legacy talk fields when normalized payload missing`() {
        let talk: [String: AnyCodable] = [
            "voiceId": AnyCodable("voice-legacy"),
            "apiKey": AnyCodable("legacy-key"),
        ]

        let selection = TalkConfigParsing.selectProviderConfig(
            talk,
            defaultProvider: TalkModeRuntime.defaultTalkProvider)
        #expect(selection?.provider == "elevenlabs")
        #expect(selection?.normalizedPayload == false)
        #expect(selection?.config["voiceId"]?.stringValue == "voice-legacy")
        #expect(selection?.config["apiKey"]?.stringValue == "legacy-key")
    }

    @Test func `reads configured silence timeout ms`() {
        let talk: [String: AnyCodable] = [
            "silenceTimeoutMs": AnyCodable(1500),
        ]

        #expect(TalkConfigParsing.resolvedSilenceTimeoutMs(talk, fallback: TalkDefaults.silenceTimeoutMs) == 1500)
    }

    @Test func `defaults silence timeout ms when missing`() {
        #expect(TalkConfigParsing.resolvedSilenceTimeoutMs(nil, fallback: TalkDefaults.silenceTimeoutMs) == TalkDefaults
            .silenceTimeoutMs)
    }

    @Test func `defaults silence timeout ms when invalid`() {
        let talk: [String: AnyCodable] = [
            "silenceTimeoutMs": AnyCodable(0),
        ]

        #expect(TalkConfigParsing
            .resolvedSilenceTimeoutMs(talk, fallback: TalkDefaults.silenceTimeoutMs) == TalkDefaults.silenceTimeoutMs)
    }
}
