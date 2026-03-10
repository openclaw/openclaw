import Testing
@testable import OpenClaw

struct VoiceWakeHelpersTests {
    @Test func `sanitize triggers trims and drops empty`() {
        let cleaned = sanitizeVoiceWakeTriggers(["  hi  ", " ", "\n", "there"])
        #expect(cleaned == ["hi", "there"])
    }

    @Test func `sanitize triggers falls back to defaults`() {
        let cleaned = sanitizeVoiceWakeTriggers(["   ", ""])
        #expect(cleaned == defaultVoiceWakeTriggers)
    }

    @Test func `sanitize triggers limits word length`() {
        let long = String(repeating: "x", count: voiceWakeMaxWordLength + 5)
        let cleaned = sanitizeVoiceWakeTriggers(["ok", long])
        #expect(cleaned[1].count == voiceWakeMaxWordLength)
    }

    @Test func `sanitize triggers limits word count`() {
        let words = (1...voiceWakeMaxWords + 3).map { "w\($0)" }
        let cleaned = sanitizeVoiceWakeTriggers(words)
        #expect(cleaned.count == voiceWakeMaxWords)
    }

    @Test func `normalize locale strips collation`() {
        #expect(normalizeLocaleIdentifier("en_US@collation=phonebook") == "en_US")
    }

    @Test func `normalize locale strips unicode extensions`() {
        #expect(normalizeLocaleIdentifier("de-DE-u-co-phonebk") == "de-DE")
        #expect(normalizeLocaleIdentifier("ja-JP-t-ja") == "ja-JP")
    }

    // MARK: - TriggerWordEntry tests

    @Test func `sanitize trigger entries trims and drops empty`() {
        let entries = [
            TriggerWordEntry(word: "  hi  ", agentId: " leo "),
            TriggerWordEntry(word: " ", agentId: "x"),
            TriggerWordEntry(word: "there"),
        ]
        let cleaned = sanitizeVoiceWakeTriggerEntries(entries)
        #expect(cleaned.count == 2)
        #expect(cleaned[0].word == "hi")
        #expect(cleaned[0].agentId == "leo")
        #expect(cleaned[1].word == "there")
        #expect(cleaned[1].agentId == nil)
    }

    @Test func `sanitize trigger entries falls back to defaults`() {
        let cleaned = sanitizeVoiceWakeTriggerEntries([TriggerWordEntry(word: "   ")])
        #expect(cleaned.map(\.word) == defaultVoiceWakeTriggers)
        #expect(cleaned.allSatisfy { $0.agentId == nil })
    }

    @Test func `sanitize trigger entries clears empty agentId`() {
        let entries = [TriggerWordEntry(word: "hey", agentId: "  ")]
        let cleaned = sanitizeVoiceWakeTriggerEntries(entries)
        #expect(cleaned[0].agentId == nil)
    }

    @Test func `agentIdForTrigger returns matching agentId`() {
        let entries = [
            TriggerWordEntry(word: "Hey Sasha", agentId: nil),
            TriggerWordEntry(word: "Hi Leo", agentId: "leo"),
        ]
        #expect(agentIdForTrigger("Hi Leo", in: entries) == "leo")
        #expect(agentIdForTrigger("hi leo", in: entries) == "leo")
        #expect(agentIdForTrigger("Hey Sasha", in: entries) == nil)
    }

    @Test func `matchTriggerEntry finds correct entry`() {
        let entries = [
            TriggerWordEntry(word: "Hey Sasha"),
            TriggerWordEntry(word: "Hi Leo", agentId: "leo"),
            TriggerWordEntry(word: "Hi Kiki", agentId: "kiki"),
        ]
        let match1 = matchTriggerEntry(transcript: "Hi Leo do something", entries: entries)
        #expect(match1?.agentId == "leo")

        let match2 = matchTriggerEntry(transcript: "Hey Sasha what's up", entries: entries)
        #expect(match2?.agentId == nil)
        #expect(match2?.word == "Hey Sasha")

        let match3 = matchTriggerEntry(transcript: "hello world", entries: entries)
        #expect(match3 == nil)
    }

    @Test func `matchTriggerEntry prefers longest overlapping trigger`() {
        let entries = [
            TriggerWordEntry(word: "Hi", agentId: "short"),
            TriggerWordEntry(word: "Hi Leo", agentId: "leo"),
        ]
        // "Hi Leo" should match the longer trigger even though "Hi" also appears.
        let match = matchTriggerEntry(transcript: "Hi Leo do something", entries: entries)
        #expect(match?.word == "Hi Leo")
        #expect(match?.agentId == "leo")

        // Plain "Hi there" should still match the short trigger.
        let match2 = matchTriggerEntry(transcript: "Hi there", entries: entries)
        #expect(match2?.word == "Hi")
        #expect(match2?.agentId == "short")
    }
}
