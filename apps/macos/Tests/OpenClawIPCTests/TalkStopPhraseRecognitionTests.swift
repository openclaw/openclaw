import Testing
@testable import OpenClaw

struct TalkStopPhraseRecognitionTests {
    @Test(arguments: [
        "and talking", "AND TALKING", "  and\ttalking  ",
        "Please and talking.", "and talking, please!", "please, and talking, please！？",
    ])
    func `end talking accepts its whole command homophone`(text: String) {
        #expect(TalkStopPhrase.matches(text, phrases: ["end talking"]))
        #expect(TalkStopPhrase.matches(text, phrases: ["stop talking", " END\t TALKING "]))
    }

    @Test(arguments: [
        "\"and talking\"", "‘and talking’", "say and talking", "don't and talking",
        "and talking about the weather", "please and talking later", "and talking please now",
        "and walking", "hand talking", "end walking", "andtalking", "and, talking",
        "please and talking;", "please", "",
    ])
    func `homophone does not broaden the whole command grammar`(text: String) {
        #expect(!TalkStopPhrase.matches(text, phrases: ["end talking"]))
    }

    @Test(arguments: [
        [], [""], ["stop talking"], ["finish now"], ["end walking"],
        ["end talking now"], ["please end talking"], ["end talking!"], ["end.*talking"],
    ])
    func `homophone requires the normalized end talking preference`(phrases: [String]) {
        #expect(!TalkStopPhrase.matches("and talking", phrases: phrases))
        #expect(!TalkStopPhrase.matches("Please and talking, please!", phrases: phrases))
    }

    @Test(arguments: [
        ("stop talking", "stop talking"), ("END TALKING!", "end talking"),
        ("and talking", "and talking"), ("finish (now)!", "finish (now)"),
        ("terminer la conversation。", "terminer la conversation"),
        ("会話を終了！", "会話を終了"), ("arre\u{0302}te", "arrête"),
    ])
    func `literal phrases retain existing normalization`(text: String, phrase: String) {
        #expect(TalkStopPhrase.matches(text, phrases: [phrase]))
    }

    @Test func `homophone is not a general or reverse substitution`() {
        #expect(!TalkStopPhrase.matches("end talking", phrases: ["and talking"]))
        #expect(!TalkStopPhrase.matches("and walking", phrases: ["end walking"]))
        #expect(!TalkStopPhrase.matches("please and talking", phrases: ["please end talking"]))
        #expect(!TalkStopPhrase.matches("anything", phrases: [".*"]))
    }
}
