import Foundation
import OpenClawChatUI
import Testing
@testable import OpenClaw

@MainActor
struct MainSessionNavigationTests {
    @Test(arguments: ["main", "work"])
    func `sidebar retains the active agents existing main conversation`(base: String) {
        let mainKey = "agent:one:\(base)"
        var main = OpenClawChatSessionEntry(key: mainKey)
        main.sessionId = "existing-main-history"
        main.label = "Original topic"
        main.updatedAt = 1
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
            groups: [],
            rosterIsComplete: true)
        let rows = sections.flatMap { ChatSessionSidebarModel.rows($0.nodes, showsChildren: { _ in true }) }
            .map { $0.node.session }
        #expect(rows.filter { $0.key == mainKey }.count == 1)
        #expect(rows.first?.key == mainKey) // Still visible before the sidebar's recent-row cap.
        #expect(rows.first { $0.key == mainKey }?.sessionId == "existing-main-history")
        #expect(rows.contains { $0.key == other.key })
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
        #expect(!CommandCenterTab.isListedChatSession("agent:one:cron:job", mainSessionKey: mainKey))
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

    @Test func `both main shortcuts follow the visible destination`() {
        let key = "agent:one:main"
        #expect(RootSidebar.isSessionSelected(key, selectedSessionKey: key, destination: .chat))
        #expect(!RootSidebar.isSessionSelected(key, selectedSessionKey: "agent:one:conversation", destination: .chat))
        #expect(!RootSidebar.isSessionSelected(key, selectedSessionKey: key, destination: .overview))
        #expect(!RootSidebar.isSessionSelected(key, selectedSessionKey: key, destination: .sessions))
    }
}
