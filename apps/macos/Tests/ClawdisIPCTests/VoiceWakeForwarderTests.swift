import Testing
@testable import Clawdis

@Suite(.serialized) struct VoiceWakeForwarderTests {
    @Test func shellEscapeHandlesQuotesAndParens() {
        let text = "Debug test works (and a funny pun)"
        let escaped = VoiceWakeForwarder.shellEscape(text)
        #expect(escaped == "'Debug test works (and a funny pun)'")

        let textWithQuote = "Debug test works (and a funny pun)'"
        let escapedQuote = VoiceWakeForwarder.shellEscape(textWithQuote)
        #expect(escapedQuote == "'Debug test works (and a funny pun)'\\'''")
    }

    @Test func prefixedTranscriptUsesMachineName() {
        let transcript = "hello world"
        let prefixed = VoiceWakeForwarder.prefixedTranscript(transcript, machineName: "My-Mac")

        #expect(prefixed.starts(with: "User talked via voice recognition on"))
        #expect(prefixed.contains("My-Mac"))
        #expect(prefixed.hasSuffix("\n\nhello world"))
    }

    @Test func parsesCommandTemplateOverrides() {
        let opts = VoiceWakeForwarder._testParseCommandTemplate(
            "clawdis-mac agent --session alt --thinking high --no-deliver --to +123 --message \"${text}\"")
        #expect(opts.session == "alt")
        #expect(opts.thinking == "high")
        #expect(opts.deliver == false)
        #expect(opts.to == "+123")
    }

    @Test func parsesCommandTemplateDefaults() {
        let opts = VoiceWakeForwarder._testParseCommandTemplate("clawdis-mac agent --message \"${text}\"")
        #expect(opts.session == "main")
        #expect(opts.thinking == "low")
        #expect(opts.deliver == true)
        #expect(opts.to == nil)
    }

    @Test func parsesCommandTemplateWithQuotedValues() {
        let opts = VoiceWakeForwarder._testParseCommandTemplate(
            "clawdis-mac agent --session \"team chat\" --thinking \"deep focus\" --to \"+1 555 1212\" --message \"${text}\"")
        #expect(opts.session == "team chat")
        #expect(opts.thinking == "deep focus")
        #expect(opts.deliver == true)
        #expect(opts.to == "+1 555 1212")
    }
}
