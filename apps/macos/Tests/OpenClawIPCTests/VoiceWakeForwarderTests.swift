import Testing
@testable import OpenClaw

@Suite(.serialized) struct VoiceWakeForwarderTests {
    @Test func `prefixed transcript uses machine name`() {
        let transcript = "hello world"
        let prefixed = VoiceWakeForwarder.prefixedTranscript(transcript, machineName: "My-Mac")

        #expect(prefixed.starts(with: "User talked via voice recognition on"))
        #expect(prefixed.contains("My-Mac"))
        #expect(prefixed.hasSuffix("\n\nhello world"))
    }

    @Test func `forward options defaults`() {
        let opts = VoiceWakeForwarder.ForwardOptions()
        #expect(opts.sessionKey == "main")
        #expect(opts.thinking == "low")
        #expect(opts.deliver == true)
        #expect(opts.to == nil)
        #expect(opts.channel == .webchat)
        #expect(opts.channel.shouldDeliver(opts.deliver) == false)
    }

    @Test func `forward options sessionKey set by agentId`() {
        var opts = VoiceWakeForwarder.ForwardOptions()
        let agentId: String? = "leo"
        if let agentId {
            opts.sessionKey = agentId
        }
        #expect(opts.sessionKey == "leo")
    }

    @Test func `forward options sessionKey remains main when agentId is nil`() {
        var opts = VoiceWakeForwarder.ForwardOptions()
        let agentId: String? = nil
        if let agentId {
            opts.sessionKey = agentId
        }
        #expect(opts.sessionKey == "main")
    }
}
