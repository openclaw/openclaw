import Foundation
import Testing
@testable import OpenClaw

struct TalkStopPhraseTests {
    @Test(arguments: [
        "stop talking", "Please stop talking.", " END\tTALKING, please! ",
    ])
    func `default phrases tolerate recognition formatting`(text: String) {
        #expect(TalkStopPhrase.matches(text, phrases: defaultTalkStopPhrases))
    }

    @Test(arguments: [
        ("terminer la conversation。", "terminer la conversation"),
        ("会話を終了！", "会話を終了"),
        ("arre\u{0302}te", "arrête"),
        ("finish (now)!", "finish (now)"),
        ("please finish now", "finish now"),
    ])
    func `custom phrases are literal and support recognized languages`(text: String, phrase: String) {
        #expect(TalkStopPhrase.matches(text, phrases: [phrase]))
        #expect(!TalkStopPhrase.matches("stop talking", phrases: [phrase]))
    }

    @Test(arguments: [
        "don't stop talking", "stop talking about the weather", "say stop talking",
        "\"stop talking\"", "‘end talking’", "goodbye", "", "please",
    ])
    func `conversation is not a stop command`(text: String) {
        #expect(!TalkStopPhrase.matches(text, phrases: defaultTalkStopPhrases))
    }

    @Test func `empty preferences disable spoken stopping and metacharacters stay literal`() {
        #expect(!TalkStopPhrase.matches("stop talking", phrases: []))
        #expect(!TalkStopPhrase.matches("stop talking", phrases: ["", " \n "]))
        #expect(!TalkStopPhrase.matches("anything", phrases: [".*"]))
    }

    @Test @MainActor func `defaults apply only to unset preferences`() async {
        for configured: [String]? in [nil, [], ["conversation finished"]] {
            await TestIsolation.withUserDefaultsValues([talkStopPhrasesKey: configured]) {
                #expect(AppState(preview: true).talkStopPhrases == (configured ?? defaultTalkStopPhrases))
            }
        }
    }
}
