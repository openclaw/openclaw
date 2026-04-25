import Testing
@testable import OpenClawKit

@MainActor
struct TalkSystemSpeechSynthesizerTests {
    @Test func watchdogTimeoutDefaultsToLatinProfile() {
        let timeout = TalkSystemSpeechSynthesizer.watchdogTimeoutSeconds(
            text: String(repeating: "a", count: 100),
            language: nil)

        #expect(abs(timeout - 24.0) < 0.001)
    }

    @Test func watchdogTimeoutUsesKoreanProfile() {
        let timeout = TalkSystemSpeechSynthesizer.watchdogTimeoutSeconds(
            text: String(repeating: "가", count: 100),
            language: "ko-KR")

        #expect(abs(timeout - 75.0) < 0.001)
    }

    @Test func watchdogTimeoutUsesChineseProfile() {
        let timeout = TalkSystemSpeechSynthesizer.watchdogTimeoutSeconds(
            text: String(repeating: "你", count: 100),
            language: "zh-CN")

        #expect(abs(timeout - 84.0) < 0.001)
    }

    @Test func watchdogTimeoutUsesJapaneseProfile() {
        let timeout = TalkSystemSpeechSynthesizer.watchdogTimeoutSeconds(
            text: String(repeating: "あ", count: 100),
            language: "ja-JP")

        #expect(abs(timeout - 60.0) < 0.001)
    }

    @Test func watchdogTimeoutClampsVeryLongUtterances() {
        let timeout = TalkSystemSpeechSynthesizer.watchdogTimeoutSeconds(
            text: String(repeating: "a", count: 10_000),
            language: "en-US")

        #expect(abs(timeout - 900.0) < 0.001)
    }
}
