import Testing
@testable import Clawdis

@Suite struct VoiceWakeForwarderTests {
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
}
