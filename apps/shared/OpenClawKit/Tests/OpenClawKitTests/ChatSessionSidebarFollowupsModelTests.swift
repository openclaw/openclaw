import Foundation
import Testing
@testable import OpenClawChatUI

@MainActor
struct ChatSessionSidebarFollowupsModelTests {
    @Test(arguments: ["global", "main"])
    func `sidebar projection keeps same named roots and descendants with their owning agents`(key: String) throws {
        let sessions = try JSONDecoder().decode(OpenClawChatSessionsListResponse.self, from: Data("""
        {"sessions":[
          {"key":"\(key)","agentId":"research","sessionId":"research-root","childSessions":["agent:research:child"]},
          {"key":"\(key)","agentId":"ops","sessionId":"ops-root","childSessions":["agent:ops:child"]},
          {"key":"agent:research:child","agentId":"research","sessionId":"research-child","unread":true},
          {"key":"agent:ops:child","agentId":"ops","sessionId":"ops-child","hasActiveRun":true}
        ]}
        """.utf8)).sessions
        let nodes = ChatSessionSidebarModel.sections(
            sessions: sessions, currentSessionKey: "", query: "", viewOptions: .init())
            .flatMap(\.nodes)
        #expect(nodes.count == 2)
        let research = try #require(nodes.first { $0.session.agentId == "research" })
        let ops = try #require(nodes.first { $0.session.agentId == "ops" })
        #expect(research.children.map(\.session.sessionId) == ["research-child"])
        #expect(ops.children.map(\.session.sessionId) == ["ops-child"])
        #expect(research.badges.hasUnread && research.badges.runningCount == 0)
        #expect(!ops.badges.hasUnread && ops.badges.runningCount == 1)
        let homeOmitted = ChatSessionSidebarModel.sections(
            sessions: sessions, currentSessionKey: "agent:research:main", mainSessionKey: key,
            excludesMainSession: true, query: "",
            sessionRoutingContract: "\(key == "global" ? "global" : "per-sender")|main|main",
            viewOptions: .init()).flatMap(\.nodes)
        #expect(Set(homeOmitted.compactMap(\.session.sessionId)) == ["ops-root", "research-child"])
        #expect(homeOmitted.first { $0.session.sessionId == "ops-root" }?.children
            .map(\.session.sessionId) == ["ops-child"])
        var order = ChatSessionSidebarModel.ObservedOrder()
        order.observe(sessions.map(OpenClawChatSessionSidebarData.identity))
        let refreshed = ChatSessionSidebarModel.sections(
            sessions: sessions.reversed(), currentSessionKey: "", query: "", viewOptions: .init(), observedOrder: order)
            .flatMap(\.nodes)
        #expect(refreshed.compactMap(\.session.sessionId) == ["research-root", "ops-root"])
        #if os(macOS)
        let roots = nodes.map { ChatSidebarSelection.Node($0, identity: OpenClawChatSessionSidebarData.identity) }
        var selection = ChatSidebarSelection()
        let researchID = try #require(roots.first { $0.row.session.agentId == "research" }?.id)
        #expect(selection.update([researchID], roots: Set(roots.map(\.id)), multiple: false) == researchID)
        let target = try #require(roots.first { $0.id == researchID }?.row.session)
        let request = OpenClawChatGatewayRequests.sessionMenu("sessions.patch", session: target, fields: [:])
        #expect(request.params["key"]?.value as? String == key)
        #expect(request.params["agentId"]?.value as? String == "research")
        #expect(request.params["expectedSessionId"]?.value as? String == "research-root")
        #endif
    }

    @Test(arguments: ["research", "ops"], [false, true])
    func `all agent sidebar selected visibility preserves the current global owner`(owner: String, bare: Bool) throws {
        let sessions = try JSONDecoder().decode(OpenClawChatSessionsListResponse.self, from: Data(#"""
        {"sessions":[
          {"key":"global","agentId":"research","sessionId":"research","archived":true},
          {"key":"global","agentId":"ops","sessionId":"ops","archived":true},
          {"key":"agent:ops:visible","agentId":"ops","sessionId":"visible"}
        ]}
        """#.utf8)).sessions
        let rows = ChatSessionSidebarModel.sections(
            sessions: sessions.sorted { $0.agentId != owner && $1.agentId == owner },
            currentSessionKey: bare ? "global" : "agent:\(owner):main", mainSessionKey: "global",
            query: "", sessionRoutingContract: "global|main|main", viewOptions: .init(selectedAgentID: owner))
            .flatMap(\.nodes).map(\.session)
        #expect(Set(rows.compactMap(\.sessionId)) == [owner, "visible"])
        #expect(rows.first { $0.key == "global" }?.agentId == owner)
        #expect(rows.count == 2)
    }

    @Test(arguments: [false, true], ["global", "agent:ops:main"])
    func `empty active and archived sidebar rosters omit the selected home`(archived: Bool, key: String) throws {
        let sessions = try JSONDecoder().decode(OpenClawChatSessionsListResponse.self, from: Data(#"""
        {"count":0,"sessions":[]}
        """#.utf8)).sessions
        let sidebar = ChatSessionSidebarModel.sections(
            sessions: sessions, currentSessionKey: key, mainSessionKey: "agent:ops:main", activeAgentID: "ops",
            excludesMainSession: true, query: "", sessionRoutingContract: "global|main|main",
            viewOptions: .init(showArchived: archived, selectedAgentID: "ops"))
        #expect(sidebar.isEmpty)
        let legacy = ChatSessionSidebarModel.sections(
            sessions: sessions, currentSessionKey: key, mainSessionKey: "agent:ops:main", activeAgentID: "ops",
            excludesMainSession: true, query: "", sessionRoutingContract: "global|main|main")
        #expect(legacy.flatMap(\.nodes).map(\.session.key) == [key])
    }
}
