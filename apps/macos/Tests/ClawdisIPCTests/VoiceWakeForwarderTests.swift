import Testing
@testable import Clawdis

@Suite(.serialized) struct VoiceWakeForwarderTests {
    @Test func parsesUserHostPort() {
        let parsed = VoiceWakeForwarder.parse(target: "[redacted-email]:2222")
        #expect(parsed?.user == "user")
        #expect(parsed?.host == "example.local")
        #expect(parsed?.port == 2222)
    }

    @Test func parsesHostOnlyDefaultsPort() {
        let parsed = VoiceWakeForwarder.parse(target: "primary.local")
        #expect(parsed?.user == nil)
        #expect(parsed?.host == "primary.local")
        #expect(parsed?.port == defaultVoiceWakeForwardPort)
    }

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
}
