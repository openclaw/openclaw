import Foundation
import OpenClawKit
import Testing

struct NativeConversationRouteBuilderTests {
    @Test func `route identity normalizes only the agent and replacement preserves it`() {
        let route = NativeConversationRoute(sessionKey: "global", agentID: " Work \n")
        #expect(route.sessionKey == "global")
        #expect(route.agentID == "work")
        #expect(route == NativeConversationRoute(sessionKey: "global", agentID: "work"))
        #expect(route != NativeConversationRoute(sessionKey: "global", agentID: "main"))
        #expect(route.replacingSessionKey("agent:work:notes") ==
            NativeConversationRoute(sessionKey: "agent:work:notes", agentID: "work"))
        #expect(route != route.replacingSessionKey("main"))
        #expect(NativeConversationRoute(sessionKey: "global", agentID: " \n").agentID == nil)
        #expect(NativeConversationRoute(sessionKey: "global", agentID: "  ") ==
            NativeConversationRoute(sessionKey: "global", agentID: nil))
    }

    @Test(arguments: [
        ("", ""),
        ("/control", "/control"),
        ("/control/", "/control"),
        ("/my%20gateway/nested/", "/my%20gateway/nested"),
    ])
    func `private entry and canonical destination both retain the Gateway mount`(
        mount: String, expectedMount: String) throws
    {
        let base = try #require(URL(string: "https://gateway.invalid" + mount))
        let url = try #require(NativeConversationRoute.documentURL(
            sessionKey: "agent:main:main", agentID: nil, draft: nil, baseURL: base))
        let entry = try #require(URLComponents(url: url, resolvingAgainstBaseURL: false))
        #expect(entry.scheme == "https")
        #expect(entry.host == "gateway.invalid")
        #expect(entry.percentEncodedPath == expectedMount + "/__openclaw__/session-entry")
        #expect(entry.queryItems == [.init(name: "path", value: expectedMount + "/chat/main")])
    }

    @Test(arguments: [
        (" main ", " Work ", "/chat/work"),
        ("Main", "research", "/chat/research"),
        ("GLOBAL", "work", "/chat/work"),
        ("AGENT:WORK:Main", "ignored", "/chat/work"),
        ("agent:work:global", "main", "/chat/work/~key/global"),
        ("agent:research:Global", "main", "/chat/research/~key/Global"),
        ("AGENT:RESEARCH:GlObAl", "main", "/chat/research/~key/GlObAl"),
        ("agent:research:global:notes", "main", "/chat/research/global/notes"),
        ("agent:work:deadbeef", "main", "/chat/work/~key/deadbeef"),
        ("notes", "work", "/chat/work/~key/notes"),
        ("agent:work:thread:child", "main", "/chat/work/thread/child"),
        ("agent:work:.", "main", "/chat/work/~key/~dot"),
        ("agent:work:..", "main", "/chat/work/~key/~dotdot"),
        ("agent:work:~dot", "main", "/chat/work/~key/~~dot"),
        ("agent:work:~key", "main", "/chat/work/~key/~~key"),
        ("agent:work:thread:..:~child", "main", "/chat/work/thread/~dotdot/~~child"),
        ("agent:work:topic/+?#%", "main", "/chat/work/~key/topic%2F%2B%3F%23%25"),
    ])
    func `exact session keys survive canonical and mounted document routing`(
        sessionKey: String, agentID: String, expectedPath: String) throws
    {
        #expect(NativeConversationRoute.dashboardPath(sessionKey: sessionKey, agentID: agentID) == expectedPath)
        let base = try #require(URL(string: "https://gateway.invalid/control/"))
        let url = try #require(NativeConversationRoute.documentURL(
            sessionKey: sessionKey, agentID: agentID, draft: nil, baseURL: base))
        #expect(URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems == [
            .init(name: "path", value: "/control" + expectedPath),
        ])
    }

    @Test(arguments: [
        ("agent:work:notes", "/control/chat/work/~key/notes"),
        ("agent:work:topic/+?#%", "/control/chat/work/~key/topic%2F%2B%3F%23%25"),
    ])
    func `private entry preserves exact sessions and rich drafts without requesting composer focus`(
        sessionKey: String, expectedPath: String) throws
    {
        let base = try #require(URL(string: "https://gateway.invalid/control/"))
        let draft = "C++ +, &, ?, #, %, and\na second line 🦞"
        let url = try #require(NativeConversationRoute.documentURL(
            sessionKey: sessionKey, agentID: nil, draft: draft, baseURL: base))
        let entry = try #require(URLComponents(url: url, resolvingAgainstBaseURL: false))
        let path = try #require(entry.queryItems?.first { $0.name == "path" }?.value)
        let destination = try #require(URLComponents(string: path))
        #expect(entry.queryItems?.count == 1)
        #expect(destination.percentEncodedPath == expectedPath)
        #expect(destination.queryItems == [.init(name: "draft", value: draft)])
        #expect(path.contains("C%2B%2B%20%2B"))
        #expect(!path.contains("__openclawComposerFocus"))
        #expect(destination.fragment == nil)
    }

    @Test func `empty drafts omit queries and dashboard draft navigation retains focus`() throws {
        let base = try #require(URL(string: "https://gateway.invalid/"))
        let url = try #require(NativeConversationRoute.documentURL(
            sessionKey: "agent:work:main", agentID: nil, draft: "", baseURL: base))
        #expect(URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems == [
            .init(name: "path", value: "/chat/work"),
        ])
        #expect(NativeConversationRoute.dashboardSearch(draft: nil) == nil)
        #expect(NativeConversationRoute.dashboardSearch(draft: "") == nil)
        let search = try #require(NativeConversationRoute.dashboardSearch(draft: "C++ notes"))
        #expect(search.contains("C%2B%2B"))
        #expect(URLComponents(string: search)?.queryItems == [
            .init(name: "draft", value: "C++ notes"),
            .init(name: "__openclawComposerFocus", value: "1"),
        ])
    }

    @Test(arguments: [
        "",
        "main",
        "global",
        "notes",
        "agent",
        "agent:work",
        "agent::main",
        "agent:work:",
        "agent:work:thread:",
    ])
    func `missing identity and malformed sessions have no destination`(_ sessionKey: String) throws {
        let base = try #require(URL(string: "https://gateway.invalid/control/"))
        #expect(NativeConversationRoute.dashboardPath(sessionKey: sessionKey, agentID: nil) == nil)
        #expect(NativeConversationRoute.dashboardPath(sessionKey: sessionKey, agentID: " \n") == nil)
        #expect(NativeConversationRoute.documentURL(
            sessionKey: sessionKey, agentID: nil, draft: nil, baseURL: base) == nil)
    }
}
