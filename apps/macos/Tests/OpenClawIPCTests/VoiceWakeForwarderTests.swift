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

    @Test func `forward invocation defaults`() {
        let opts = VoiceWakeForwarder.makeInvocation(transcript: "hello world")
        #expect(opts.sessionKey == "main")
        #expect(opts.thinking == nil)
        #expect(opts.deliver == false)
        #expect(opts.to == nil)
        #expect(opts.channel == .webchat)
        #expect(opts.message.hasSuffix("\n\nhello world"))
    }

    @Test func `selected forward options use session delivery context`() {
        let entry = VoiceWakeForwarder.SessionRouteEntry(
            key: "agent:main:telegram:group:6812765697",
            channel: "telegram",
            lastChannel: "telegram",
            lastTo: "telegram:6812765697",
            deliveryContext: .init(channel: "telegram", to: "telegram:6812765697"))

        let opts = VoiceWakeForwarder.makeInvocation(
            transcript: "hello world",
            sessionKey: entry.key,
            routeEntries: [entry],
            voiceWakeTrigger: "open claw")

        #expect(opts.sessionKey == "agent:main:telegram:group:6812765697")
        #expect(opts.channel == .telegram)
        #expect(opts.to == "telegram:6812765697")
        #expect(opts.voiceWakeTrigger == "open claw")
        #expect(opts.thinking == nil)
        #expect(opts.deliver == true)
    }

    @Test func `selected forward options parse channel scoped session fallback`() {
        let opts = VoiceWakeForwarder.makeInvocation(
            transcript: "hello world",
            sessionKey: "agent:main:discord:channel:123:456")

        #expect(opts.channel == .discord)
        #expect(opts.to == "123:456")
        #expect(opts.deliver == true)
    }

    @Test func `selected forward options keep internal sessions on webchat`() {
        let opts = VoiceWakeForwarder.makeInvocation(
            transcript: "hello world",
            sessionKey: "agent:main:work")

        #expect(opts.channel == .webchat)
        #expect(opts.to == nil)
        #expect(opts.deliver == false)
    }

    @Test func `selected forward options do not alias another agents main route`() {
        let entry = VoiceWakeForwarder.SessionRouteEntry(
            key: "agent:main:main",
            channel: "telegram",
            lastChannel: nil,
            lastTo: nil,
            deliveryContext: .init(channel: "telegram", to: "telegram:other-agent"))

        let opts = VoiceWakeForwarder.makeInvocation(
            transcript: "hello world",
            sessionKey: "main",
            routeEntries: [entry])

        #expect(opts.sessionKey == "main")
        #expect(opts.channel == .webchat)
        #expect(opts.to == nil)
        #expect(!opts.deliver)
    }

    @Test(arguments: ["main", "MAIN"])
    func `selected forward options preserve opaque Signal group identity`(agent: String) {
        let selectedKey = "agent:main:signal:group:AbC123="
        let foreign = VoiceWakeForwarder.SessionRouteEntry(
            key: "agent:main:signal:group:abc123=",
            channel: "signal",
            lastChannel: nil,
            lastTo: nil,
            deliveryContext: .init(channel: "signal", to: "group:foreign"))
        let selected = VoiceWakeForwarder.SessionRouteEntry(
            key: "agent:\(agent):signal:group:AbC123=",
            channel: "signal",
            lastChannel: nil,
            lastTo: nil,
            deliveryContext: .init(channel: "signal", to: "group:selected"))

        let opts = VoiceWakeForwarder.makeInvocation(
            transcript: "hello world",
            sessionKey: selectedKey,
            routeEntries: [foreign, selected])

        #expect(opts.sessionKey == selectedKey)
        #expect(opts.channel == .signal)
        #expect(opts.to == "group:selected")
        #expect(opts.deliver)
    }
}
