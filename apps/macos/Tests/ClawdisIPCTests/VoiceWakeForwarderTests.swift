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

    @Test func renderedCommandReplacesPlaceholderAndEscapes() {
        let template = "clawdis-mac agent --message \"${text}\""
        let command = VoiceWakeForwarder.renderedCommand(template: template, transcript: "hi i'm here")
        #expect(command.contains("clawdis-mac agent"))
        #expect(command.contains("'hi i'\\''m here'"))
        #expect(!command.contains("${text}"))
    }

    @Test func renderedCommandPassthroughWhenNoPlaceholder() {
        let template = "echo noop"
        let command = VoiceWakeForwarder.renderedCommand(template: template, transcript: "ignored")
        #expect(command == template)
    }

    @Test func commandPrefersCliInstallPaths() {
        let command = VoiceWakeForwarder.commandWithCliPath("clawdis-mac status", target: "user@host")
        #expect(command.contains("PATH=\(cliHelperSearchPaths.joined(separator: ":"))"))
        #expect(command.contains("for c in clawdis-mac /usr/local/bin/clawdis-mac /opt/homebrew/bin/clawdis-mac"))
        #expect(command.contains("\"$CLI\" status"))
    }

    @Test func commandUsesCachedCliForSameTarget() {
        VoiceWakeForwarder.clearCliCache(); defer { VoiceWakeForwarder.clearCliCache() }
        VoiceWakeForwarder._testSetCliCache(target: "t1", path: "/tmp/custom-cli")

        let command = VoiceWakeForwarder.commandWithCliPath("clawdis-mac status", target: "t1")

        #expect(command.contains("CLI=\"/tmp/custom-cli\""))
    }

    @Test func commandIgnoresCacheForDifferentTarget() {
        VoiceWakeForwarder.clearCliCache(); defer { VoiceWakeForwarder.clearCliCache() }
        VoiceWakeForwarder._testSetCliCache(target: "t1", path: "/tmp/custom-cli")

        let command = VoiceWakeForwarder.commandWithCliPath("clawdis-mac status", target: "t2")

        #expect(!command.contains("/tmp/custom-cli"))
    }

    @Test func clearCliCacheRemovesCachedCli() {
        VoiceWakeForwarder._testSetCliCache(target: "t1", path: "/tmp/custom-cli")
        VoiceWakeForwarder.clearCliCache(); defer { VoiceWakeForwarder.clearCliCache() }

        let command = VoiceWakeForwarder.commandWithCliPath("clawdis-mac status", target: "t1")

        #expect(!command.contains("/tmp/custom-cli"))
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
}
