import Foundation
import SwabbleKit
import Testing
@testable import OpenClaw

struct VoiceWakeRuntimeTests {
    @Test func `trims after trigger keeps post speech`() {
        let triggers = ["claude", "openclaw"]
        let text = "hey Claude how are you"
        #expect(VoiceWakeRuntime._testTrimmedAfterTrigger(text, triggers: triggers) == "how are you")
    }

    @Test func `trims after trigger returns original when no trigger`() {
        let triggers = ["claude"]
        let text = "good morning friend"
        #expect(VoiceWakeRuntime._testTrimmedAfterTrigger(text, triggers: triggers) == text)
    }

    @Test func `trims after first matching trigger`() {
        let triggers = ["buddy", "claude"]
        let text = "hello buddy this is after trigger claude also here"
        #expect(VoiceWakeRuntime
            ._testTrimmedAfterTrigger(text, triggers: triggers) == "this is after trigger claude also here")
    }

    @Test func `has content after trigger false when only trigger`() {
        let triggers = ["openclaw"]
        let text = "hey openclaw"
        #expect(!VoiceWakeRuntime._testHasContentAfterTrigger(text, triggers: triggers))
    }

    @Test func `has content after trigger true when speech continues`() {
        let triggers = ["claude"]
        let text = "claude write a note"
        #expect(VoiceWakeRuntime._testHasContentAfterTrigger(text, triggers: triggers))
    }

    @Test func `trims after chinese trigger keeps post speech`() {
        let triggers = ["小爪", "openclaw"]
        let text = "嘿 小爪 帮我打开设置"
        #expect(VoiceWakeRuntime._testTrimmedAfterTrigger(text, triggers: triggers) == "帮我打开设置")
    }

    @Test func `trims after trigger handles width insensitive forms`() {
        let triggers = ["openclaw"]
        let text = "ＯｐｅｎＣｌａｗ 请帮我"
        #expect(VoiceWakeRuntime._testTrimmedAfterTrigger(text, triggers: triggers) == "请帮我")
    }

    @Test func `gate requires gap between trigger and command`() {
        let transcript = "hey openclaw do thing"
        let segments = makeWakeWordSegments(
            transcript: transcript,
            words: [
                ("hey", 0.0, 0.1),
                ("openclaw", 0.2, 0.1),
                ("do", 0.35, 0.1),
                ("thing", 0.5, 0.1),
            ])
        let config = WakeWordGateConfig(triggers: ["openclaw"], minPostTriggerGap: 0.3)
        #expect(WakeWordGate.match(transcript: transcript, segments: segments, config: config) == nil)
    }

    @Test func `gate accepts gap and extracts command`() {
        let transcript = "hey openclaw do thing"
        let segments = makeWakeWordSegments(
            transcript: transcript,
            words: [
                ("hey", 0.0, 0.1),
                ("openclaw", 0.2, 0.1),
                ("do", 0.9, 0.1),
                ("thing", 1.1, 0.1),
            ])
        let config = WakeWordGateConfig(triggers: ["openclaw"], minPostTriggerGap: 0.3)
        #expect(WakeWordGate.match(transcript: transcript, segments: segments, config: config)?.command == "do thing")
    }

    // MARK: - Agent routing via TriggerWordEntry

    @Test func `matchTriggerEntry routes to correct agent from transcript`() {
        let entries = [
            TriggerWordEntry(word: "Hey Sasha"),
            TriggerWordEntry(word: "Hi Leo", agentId: "leo"),
            TriggerWordEntry(word: "Hi Kiki", agentId: "kiki"),
        ]

        let match1 = matchTriggerEntry(transcript: "Hi Leo tell me a joke", entries: entries)
        #expect(match1?.agentId == "leo")

        let match2 = matchTriggerEntry(transcript: "Hi Kiki what time is it", entries: entries)
        #expect(match2?.agentId == "kiki")

        let match3 = matchTriggerEntry(transcript: "Hey Sasha how are you", entries: entries)
        #expect(match3?.word == "Hey Sasha")
        #expect(match3?.agentId == nil)
    }

    @Test func `matchTriggerEntry returns nil for unmatched transcript`() {
        let entries = [TriggerWordEntry(word: "Claude", agentId: "main")]
        #expect(matchTriggerEntry(transcript: "hello world", entries: entries) == nil)
    }

    @Test func `triggerWords computed property extracts words`() {
        let config = VoiceWakeRuntime.RuntimeConfig(
            triggers: [
                TriggerWordEntry(word: "Hey Sasha"),
                TriggerWordEntry(word: "Hi Leo", agentId: "leo"),
            ],
            micID: nil,
            localeID: nil,
            triggerChime: .none,
            sendChime: .none)
        #expect(config.triggerWords == ["Hey Sasha", "Hi Leo"])
    }

    @Test func `matchTriggerEntry routes longest overlapping trigger correctly`() {
        let entries = [
            TriggerWordEntry(word: "Hi", agentId: "generic"),
            TriggerWordEntry(word: "Hi Leo", agentId: "leo"),
            TriggerWordEntry(word: "Hi Kiki", agentId: "kiki"),
        ]

        // "Hi Leo" must match the longer, more specific trigger.
        let match1 = matchTriggerEntry(transcript: "Hi Leo play some music", entries: entries)
        #expect(match1?.agentId == "leo")

        // "Hi Kiki" must match the longer trigger.
        let match2 = matchTriggerEntry(transcript: "Hi Kiki what's the weather", entries: entries)
        #expect(match2?.agentId == "kiki")

        // "Hi everyone" should fall back to the short trigger.
        let match3 = matchTriggerEntry(transcript: "Hi everyone", entries: entries)
        #expect(match3?.word == "Hi")
        #expect(match3?.agentId == "generic")
    }
}
