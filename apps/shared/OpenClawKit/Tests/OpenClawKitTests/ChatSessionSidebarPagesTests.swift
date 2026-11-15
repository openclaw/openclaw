#if os(macOS)
import Foundation
import Testing
@testable import OpenClawChatUI

@MainActor
struct ChatSessionSidebarPagesTests {
    private func rows(_ json: String) throws -> [OpenClawChatSessionEntry] {
        try JSONDecoder().decode(OpenClawChatSessionsListResponse.self, from: Data("{\"sessions\":[\(json)]}".utf8))
            .sessions
    }

    @Test(arguments: [false, true])
    func `agent reveal keeps the selected tree and one bounded previous page`(nestedSelection: Bool) throws {
        var rows = try self
            .rows((0..<40).map { #"{"key":"agent:main:\#($0)","sessionId":"\#($0)"}"# }.joined(separator: ","))
        let selectedKey = nestedSelection ? "agent:main:selected" : "agent:main:39"
        if nestedSelection {
            rows[39].childSessions = ["agent:main:branch"]
            rows += try self.rows(#"""
            {"key":"agent:main:branch","childSessions":["agent:main:selected"]},
            {"key":"agent:main:selected"}
            """#)
        }
        let nodes = ChatSessionSidebarModel.tree(from: rows)
        var reveal = ChatSidebarAgentReveal()
        let selected = { (node: ChatSessionSidebarModel.Node) in node.id == selectedKey }
        let first = reveal.visible(nodes, agentID: "main", selected: selected)
        #expect(first.count == 10)
        #expect(first.last?.id == "agent:main:39")
        #expect(!first.contains { $0.id == "agent:main:9" })
        reveal.members["main"] = Set(first.map(\.id))
        let moved = reveal.visible(Array(nodes.reversed()), agentID: "main", selected: selected)
        #expect(moved.count == 19)
        #expect(Set(first.map(\.id)).isSubset(of: Set(moved.map(\.id))))
        reveal.members["main"] = Set(moved.map(\.id))
        let next = reveal.visible(
            Array(nodes.dropFirst(10)) + Array(nodes.prefix(10)),
            agentID: "main",
            selected: selected)
        #expect(next.count <= 20)
        reveal.limits["other"] = 30
        #expect(reveal.visible(nodes, agentID: "other", selected: selected).count == 30)
        #expect(reveal.visible(nodes, agentID: "main", selected: selected).count <= 20)
    }

    @Test
    func `expanded agent summaries include Home runs while collapsed summaries include hidden conversations`() throws {
        let rows = try self.rows(#"""
        {"key":"agent:main:main","hasActiveSubagentRun":true,
         "childSessions":["agent:main:subagent:run","agent:main:child","agent:main:pin"]},
        {"key":"agent:main:subagent:run","status":"queued","hasActiveRun":true,"unread":true},
        {"key":"agent:main:child","status":"running","hasActiveRun":true,"unread":true,"spawnedBy":"agent:main:main"},
        {"key":"agent:main:pin","status":"running","hasActiveRun":true,"pinned":true}
        """#)
        let home = try #require(ChatSessionSidebarModel.sidebarTree(
            roots: [rows[0]],
            rows: rows,
            home: (keys: [rows[0].key], excluded: false),
            selectedKey: rows[0].key,
            lineageRootKey: nil,
            membership: [:],
            options: .init()).first)
        let conversations = ChatSessionSidebarModel.sections(
            sessions: rows,
            currentSessionKey: rows[0].key,
            mainSessionKey: rows[0].key,
            activeAgentID: "main",
            excludesMainSession: true,
            query: "",
            viewOptions: .init())
            .filter { $0.id != "pinned" }.flatMap(\.nodes)
        let expanded = ChatSidebarTreeSummary(home: home, rows: conversations, collapsed: false)
        let collapsed = ChatSidebarTreeSummary(home: home, rows: conversations, collapsed: true)
        #expect(expanded.running == 0 && expanded.queued == 1 && expanded.unread == 1)
        #expect(collapsed.running == 1 && collapsed.queued == 1 && collapsed.unread == 2)
        let requests: [OpenClawChatAttentionRequest] = [
            .init(
                id: "pin",
                kind: .question,
                sessionKey: "agent:main:pin",
                agentID: "main",
                createdAtMs: 1,
                expiresAtMs: 1000,
                preview: "Pin"),
            .init(
                id: "child",
                kind: .question,
                sessionKey: "agent:main:child",
                agentID: "main",
                createdAtMs: 2,
                expiresAtMs: 1000,
                preview: "Child"),
            .init(
                id: "run",
                kind: .question,
                sessionKey: "agent:main:subagent:run",
                agentID: "main",
                createdAtMs: 3,
                expiresAtMs: 1000,
                preview: "Run"),
        ]
        for (summary, request) in [(expanded, "run"), (collapsed, "child")] {
            let attention = ChatSessionSidebarModel.attentionSummary(
                requests: requests,
                sessions: summary.sessions,
                mainSessionKey: rows[0].key,
                activeAgentID: "main",
                sessionRoutingContract: nil,
                now: Date(timeIntervalSince1970: 0))
            #expect(attention?.oldest.id == request)
        }
        let offline = ChatSidebarTreeSummary(home: home, rows: conversations, collapsed: true, isConnected: false)
        #expect(offline.running == 0 && offline.queued == 0)
        #expect(offline.unread == 2)
        let page = ChatSidebarTreeSummary(page: home, expanded: true, isConnected: true)
        #expect(page.running == 0 && page.queued == 1 && page.unread == 1)
        #expect(page.sessions.map(\.key) == ["agent:main:main", "agent:main:subagent:run"])
        let collapsedPage = ChatSidebarTreeSummary(page: home, expanded: false, isConnected: true)
        #expect(collapsedPage.running == 1 && collapsedPage.queued == 1 && collapsedPage.unread == 2)
    }
}
#endif
