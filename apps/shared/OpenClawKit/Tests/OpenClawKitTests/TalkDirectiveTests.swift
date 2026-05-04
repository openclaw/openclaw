import Testing
@testable import OpenClawKit

struct TalkDirectiveTests {
    @Test func parsesDirectiveAndStripsLine() {
        let text = """
        {"voice":"abc123","once":true}
        Hello there.
        """
        let result = TalkDirectiveParser.parse(text)
        #expect(result.directive?.voiceId == "abc123")
        #expect(result.directive?.once == true)
        #expect(result.stripped == "Hello there.")
    }

    @Test func ignoresNonDirective() {
        let text = "Hello world."
        let result = TalkDirectiveParser.parse(text)
        #expect(result.directive == nil)
        #expect(result.stripped == text)
    }

    @Test func keepsDirectiveLineIfNoRecognizedFields() {
        let text = """
        {"unknown":"value"}
        Hello.
        """
        let result = TalkDirectiveParser.parse(text)
        #expect(result.directive == nil)
        #expect(result.stripped == text)
    }

    @Test func parsesExtendedOptions() {
        let text = """
        {"voice_id":"v1","model_id":"m1","rate":200,"stability":0.5,"similarity":0.8,"style":0.2,"speaker_boost":true,"seed":1234,"normalize":"auto","lang":"en","output_format":"mp3_44100_128"}
        Hello.
        """
        let result = TalkDirectiveParser.parse(text)
        #expect(result.directive?.voiceId == "v1")
        #expect(result.directive?.modelId == "m1")
        #expect(result.directive?.rateWPM == 200)
        #expect(result.directive?.stability == 0.5)
        #expect(result.directive?.similarity == 0.8)
        #expect(result.directive?.style == 0.2)
        #expect(result.directive?.speakerBoost == true)
        #expect(result.directive?.seed == 1234)
        #expect(result.directive?.normalize == "auto")
        #expect(result.directive?.language == "en")
        #expect(result.directive?.outputFormat == "mp3_44100_128")
        #expect(result.stripped == "Hello.")
    }

    @Test func skipsLeadingEmptyLinesWhenParsingDirective() {
        let text = """


        {"voice":"abc123"}
        Hello there.
        """
        let result = TalkDirectiveParser.parse(text)
        #expect(result.directive?.voiceId == "abc123")
        #expect(result.stripped == "Hello there.")
    }

    @Test func tracksUnknownKeys() {
        let text = """
        {"voice":"abc","mystery":"value","extra":1}
        Hi.
        """
        let result = TalkDirectiveParser.parse(text)
        #expect(result.directive?.voiceId == "abc")
        #expect(result.unknownKeys == ["extra", "mystery"])
    }
}
