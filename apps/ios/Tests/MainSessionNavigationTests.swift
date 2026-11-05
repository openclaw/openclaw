import Foundation
import OpenClawChatUI
import Testing
@testable import OpenClaw

@MainActor
struct MainSessionNavigationTests {
    enum MainPlacement: CaseIterable, Equatable, Sendable {
        case recent, group, pinned
    }

    @Test(arguments: ["main", "work"], MainPlacement.allCases)
    func `sidebar retains the active agents existing main conversation`(base: String, placement: MainPlacement) {
        let mainKey = "agent:one:\(base)"
        var main = OpenClawChatSessionEntry(key: mainKey)
        main.sessionId = "existing-main-history"
        main.label = "Original topic"
        main.updatedAt = 1
        main.category = placement == .group ? "Research" : nil
        main.pinned = placement == .pinned
        let newer = (0..<25).map { index -> OpenClawChatSessionEntry in
            var session = OpenClawChatSessionEntry(key: "agent:one:conversation-\(index)")
            session.updatedAt = Double(index + 10)
            return session
        }
        let other = OpenClawChatSessionEntry(key: "agent:one:conversation")
        let otherAgent = OpenClawChatSessionEntry(key: "agent:two:\(base)")
        let sections = RootSidebarModel.sections(
            sessions: [main, other, otherAgent] + newer,
            query: "",
            currentSessionKey: other.key,
            mainSessionKey: base,
            activeAgentID: "one",
            groups: [.init(id: "Research", name: "Research", order: 0)],
            rosterIsComplete: true)
        let rows = sections.flatMap {
            RootSidebar.sessionNodes(for: $0, mainSessionKey: mainKey, searchText: "")
        }.map { $0.node.session }
        #expect(rows.filter { $0.key == mainKey }.count == 1)
        #expect(rows.count == 21) // Main plus the unchanged budget of 20 ordinary recent rows.
        if placement == .recent {
            #expect(rows.first?.key == mainKey)
        }
        #expect(rows.first { $0.key == mainKey }?.sessionId == "existing-main-history")
        #expect(rows.first { $0.key == mainKey }?.pinned == main.pinned)
        #expect(rows.first { $0.key == mainKey }?.category == main.category)
        #expect(!rows.contains { $0.key == otherAgent.key })
        let resolvedMainKey = ChatSessionSidebarModel.selectedSessionKey(
            sessions: [main, other, otherAgent], currentSessionKey: "main", mainSessionKey: base, activeAgentID: "one")
        #expect(resolvedMainKey == mainKey)
        #expect(!ChatSessionSidebarModel.canDeleteSession(key: mainKey, mainSessionKey: resolvedMainKey))
        #expect(!ChatSessionSidebarModel.canArchiveSession(main, mainSessionKey: resolvedMainKey))
    }

    @Test(arguments: ["agent:one:main", "agent:one:work"])
    func `inventory and titles recognize only the resolved main conversation`(mainKey: String) {
        var main = OpenClawChatSessionEntry(key: mainKey)
        main.label = "Original topic"
        let other = OpenClawChatSessionEntry(key: "agent:one:conversation", label: "Another conversation")
        #expect(CommandCenterTab.isListedChatSession(mainKey, mainSessionKey: mainKey))
        #expect(!CommandCenterTab.isRecentChatSession(mainKey, defaultSessionKey: mainKey))
        #expect(CommandCenterTab.isListedChatSession(other.key, mainSessionKey: mainKey))
        #expect(!CommandCenterTab.isListedChatSession("agent:two:main", mainSessionKey: mainKey))
        let automation = OpenClawChatSessionEntry(key: "agent:one:cron:job")
        let now = Date(timeIntervalSince1970: 1000)
        #expect(CommandCenterTab.isListedChatSession(automation.key, mainSessionKey: mainKey))
        #expect(!SessionStatusScope.active.includes(automation, at: now, currentSessionKey: other.key))
        #expect(SessionStatusScope.automations.includes(automation, at: now, currentSessionKey: other.key))
        #expect(SessionStatusScope.active.includes(automation, at: now, currentSessionKey: automation.key))
        #expect(CommandCenterTab.sessionTitle(main, mainSessionKey: mainKey) == "Main Session")
        #expect(CommandCenterTab.sessionTitle(other, mainSessionKey: mainKey) == "Another conversation")
        #expect(main.label == "Original topic")
        let selectedKey = ChatSessionSidebarModel.selectedSessionKey(
            sessions: [main, other], currentSessionKey: "main", mainSessionKey: mainKey, activeAgentID: "one")
        let item = CommandCenterTab.sessionWorkItem(
            for: main, currentSessionKey: selectedKey, mainSessionKey: mainKey)
        #expect(item.icon == CommandCenterTab.mainSessionSymbol)
        #expect(item.state == "open")
    }

    @Test func mainReservationKeepsDescendantsTogetherAndRespectsSearch() throws {
        let mainKey = "agent:one:main"
        var main = OpenClawChatSessionEntry(key: mainKey)
        main.updatedAt = 1
        var child = OpenClawChatSessionEntry(key: "agent:one:followup")
        child.parentSessionKey = mainKey
        child.updatedAt = 2
        let newer = (0..<25).map { index -> OpenClawChatSessionEntry in
            var row = OpenClawChatSessionEntry(key: "agent:one:conversation-\(index)")
            row.updatedAt = Double(index + 10)
            return row
        }
        let sections = RootSidebarModel.sections(
            sessions: [main, child] + newer, query: "", currentSessionKey: newer[0].key,
            mainSessionKey: "main", activeAgentID: "one", groups: [], rosterIsComplete: true)
        let recent = try #require(sections.first { $0.id == "recent" })
        let mainNode = try #require(recent.nodes.first { $0.session.key == mainKey })
        let rows = RootSidebar.sessionNodes(for: recent, mainSessionKey: mainKey, searchText: "")
        #expect(rows.count == 21)
        #expect(rows.prefix(2).map { $0.node.session.key } == [mainKey, child.key])
        #expect(rows[1].depth == 1)
        let collapsed = RootSidebar.sessionNodes(
            for: recent, mainSessionKey: mainKey, searchText: "", collapsedParents: [mainNode.id])
        #expect(collapsed.count == 21)
        #expect(!collapsed.contains { $0.node.session.key == child.key })
        let uncapped = RootSidebar.sessionNodes(for: recent, mainSessionKey: mainKey, searchText: "conversation")
        #expect(uncapped == ChatSessionSidebarModel.rows(recent.nodes, showsChildren: { _ in true }))
    }
}
