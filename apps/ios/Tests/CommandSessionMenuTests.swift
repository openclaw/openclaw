import Foundation
import OpenClawChatUI
import OpenClawProtocol
import Testing
@testable import OpenClaw

@MainActor
struct CommandSessionMenuTests {
    @Test func `shared links use canonical gateway mount and never include credentials`() {
        let session = OpenClawChatSessionEntry(key: "agent:research:release/plan")
        let link = CommandSessionLink.url(
            config: nil, canonicalBase: "wss://user:password@gateway.example/control/?token=secret#secret",
            session: session, preview: true)
        #expect(link?.absoluteString == "https://gateway.example/control/share/chat/research/~key/release%2Fplan")
        #expect(CommandSessionLink.url(
            config: nil, canonicalBase: "javascript:alert(1)", session: session, preview: false) == nil)
    }

    @Test func `global and bare session links require the clicked owner rather than selected agent`() {
        var session = OpenClawChatSessionEntry(key: "global")
        #expect(CommandSessionLink.url(
            config: nil,
            canonicalBase: "https://gateway.example",
            session: session,
            preview: false) == nil)
        session.agentId = "research"
        #expect(CommandSessionLink.url(
            config: nil,
            canonicalBase: "https://gateway.example",
            session: session,
            preview: false)?.path == "/chat/research")
        session.key = "~dot"
        #expect(CommandSessionLink.url(
            config: nil,
            canonicalBase: "https://gateway.example",
            session: session,
            preview: false)?.path == "/chat/research/~key/~~dot")
    }
}
