import Foundation
import OpenClawKit
import Testing
@testable import OpenClaw

struct WebChatDocumentRouteTests {
    @Test func `Mac route API remains compatible with shared routes and private document navigation`() throws {
        let route: WebChatRoute = NativeConversationRoute(sessionKey: "agent:research:notes", agentID: " Research ")
        let shared: NativeConversationRoute = route.replacingSessionKey("agent:research:Global")
        #expect(shared.agentID == "research")
        #expect(WebChatRoute.dashboardPath(sessionKey: route.sessionKey, agentID: route.agentID) ==
            "/chat/research/~key/notes")
        let base = try #require(URL(string: "https://gateway.invalid/control/"))
        let url = try #require(WebChatRoute.documentURL(
            sessionKey: shared.sessionKey, agentID: shared.agentID, draft: nil, baseURL: base))
        let entry = try #require(URLComponents(url: url, resolvingAgainstBaseURL: false))
        #expect(entry.path == "/control/__openclaw__/session-entry")
        #expect(entry.queryItems == [.init(name: "path", value: "/control/chat/research/~key/Global")])
    }
}
