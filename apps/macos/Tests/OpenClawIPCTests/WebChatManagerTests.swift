import Testing
@testable import OpenClaw

@Suite(.serialized)
@MainActor
struct WebChatManagerTests {
    @Test func `route identity includes the session and normalized agent`() {
        let work = WebChatRoute(sessionKey: "global", agentID: " Work ")
        let sameWork = WebChatRoute(sessionKey: "global", agentID: "work")
        let main = WebChatRoute(sessionKey: "global", agentID: "main")

        #expect(work == sameWork)
        #expect(work != main)
        #expect(work != WebChatRoute(sessionKey: "main", agentID: "work"))
    }

    @Test func `blank agent route normalizes to nil`() {
        #expect(WebChatRoute(sessionKey: "global", agentID: "  ") ==
            WebChatRoute(sessionKey: "global", agentID: nil))
    }

    @Test(arguments: [
        ("main", "research", "/chat/research"),
        ("Main", "research", "/chat/research"),
        ("global", "research", "/chat/research"),
        ("Global", "research", "/chat/research"),
        ("agent:research:main", "main", "/chat/research"),
        ("agent:research:Main", "main", "/chat/research"),
        ("agent:research:global", "main", "/chat/research/~key/global"),
        ("agent:research:Global", "main", "/chat/research/~key/Global"),
        ("AGENT:RESEARCH:GlObAl", "main", "/chat/research/~key/GlObAl"),
        ("agent:research:global:notes", "main", "/chat/research/global/notes"),
    ])
    func `Dashboard URLs distinguish home aliases from qualified literal sessions`(
        sessionKey: String,
        agentID: String,
        expectedPath: String)
    {
        #expect(WebChatRoute.dashboardPath(sessionKey: sessionKey, agentID: agentID) == expectedPath)
    }
}
