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
        let pinned = ChatSessionSidebarModel.sections(
            sessions: sessions.map { row in
                var row = row
                if row.key == key { row.pinned = true }
                return row
            },
            currentSessionKey: "",
            query: "",
            viewOptions: .init())
            .first { $0.id == "pinned" }?.nodes ?? []
        #expect(Set(pinned.compactMap(\.session.sessionId)) == ["research-root", "ops-root"])
        #if os(macOS)
        let homeOmitted = ChatSessionSidebarModel.sections(
            sessions: sessions,
            currentSessionKey: "agent:research:main",
            mainSessionKey: key,
            excludesMainSession: true,
            query: "",
            sessionRoutingContract: "\(key == "global" ? "global" : "per-sender")|main|main",
            viewOptions: .init()).flatMap(\.nodes)
        #expect(Set(homeOmitted.compactMap(\.session.sessionId)) == ["research-child", "ops-child"])
        #endif
        var order = ChatSessionSidebarModel.ObservedOrder()
        order.observe(sessions.map(OpenClawChatSessionSidebarData.identity))
        let refreshed = ChatSessionSidebarModel.sections(
            sessions: sessions.reversed(), currentSessionKey: "", query: "", viewOptions: .init(), observedOrder: order)
            .flatMap(\.nodes)
        #expect(refreshed.compactMap(\.session.sessionId) == ["research-root", "ops-root"])
        #if os(macOS)
        let roots = ChatSidebarSelection.visibleRoots(
            in: [.init(id: "recent", title: nil, nodes: nodes)], searching: false, isCollapsed: { _ in false })
        var selection = ChatSidebarSelection()
        let researchID = OpenClawChatSessionSidebarData.identity(research.session)
        #expect(selection.update(
            [researchID],
            roots: Set(roots.map(OpenClawChatSessionSidebarData.identity)),
            multiple: false) == researchID)
        let target = try #require(roots.first { OpenClawChatSessionSidebarData.identity($0) == researchID })
        let request = OpenClawChatGatewayRequests.sessionMenu("sessions.patch", session: target, fields: [:])
        #expect(request.params["key"]?.value as? String == key)
        #expect(request.params["agentId"]?.value as? String == "research")
        #expect(request.params["expectedSessionId"]?.value as? String == "research-root")
        #endif
    }

    #if os(macOS)
    @Test(arguments: ["research", "ops"])
    func `selected child reveal and automatic expansion retain only the current owner`(owner: String) throws {
        let rows = try JSONDecoder().decode(OpenClawChatSessionsListResponse.self, from: Data(#"""
        {"sessions":[
          {"key":"global","agentId":"research","sessionId":"research"},
          {"key":"global","agentId":"ops","sessionId":"ops"}
        ]}
        """#.utf8)).sessions
        let candidates = ChatSessionSidebarModel.sections(
            sessions: rows, currentSessionKey: "", query: "", viewOptions: .init()).flatMap(\.nodes)
        let quiet = ChatSessionSidebarModel.tree(from: (0..<4).map { .init(key: "quiet-\($0)") })
        let parent = ChatSessionSidebarModel.Node(
            session: .init(key: "parent"),
            children: quiet + candidates,
            badges: .init(queuedCount: 0, runningCount: 0, failedCount: 0, hasUnread: false))
        let selected = candidates.filter { $0.containsSelection("global", agentID: owner) }
        #expect(selected.compactMap(\.session.sessionId) == [owner])
        let visible = parent.visibleChildren(
            selectedKey: "global", selectedAgentID: owner, fullyShown: false, now: .now) { _ in nil }
        #expect(visible.map(\.session.key) == ["quiet-0", "quiet-1", "quiet-2", "quiet-3", "global"])
        #expect(visible.last?.session.agentId == owner)
    }
    #endif

    @Test(arguments: ["research", "ops"], [false, true])
    func `all agent sidebar selected visibility preserves the current global owner`(owner: String, bare: Bool) throws {
        let sessions = try JSONDecoder().decode(OpenClawChatSessionsListResponse.self, from: Data(#"""
        {"sessions":[
          {"key":"global","agentId":"research","sessionId":"research","createdVia":"internal"},
          {"key":"global","agentId":"ops","sessionId":"ops","createdVia":"internal"},
          {"key":"agent:ops:visible","agentId":"ops","sessionId":"visible"}
        ]}
        """#.utf8)).sessions
        let rows = ChatSessionSidebarModel.sections(
            sessions: sessions.sorted { $0.agentId != owner && $1.agentId == owner },
            currentSessionKey: bare ? "global" : "agent:\(owner):main",
            mainSessionKey: "global",
            query: "",
            sessionRoutingContract: "global|main|main",
            viewOptions: .init(selectedAgentID: owner))
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
            sessions: sessions,
            currentSessionKey: key,
            mainSessionKey: "agent:ops:main",
            activeAgentID: "ops",
            excludesMainSession: true,
            query: "",
            sessionRoutingContract: "global|main|main",
            viewOptions: .init(status: archived ? .all : .active, selectedAgentID: "ops"))
        #expect(sidebar.flatMap(\.nodes).isEmpty)
        let legacy = ChatSessionSidebarModel.sections(
            sessions: sessions,
            currentSessionKey: key,
            mainSessionKey: "agent:ops:main",
            activeAgentID: "ops",
            excludesMainSession: true,
            query: "",
            sessionRoutingContract: "global|main|main")
        #expect(legacy.flatMap(\.nodes).map(\.session.key) == [key])
    }
}
