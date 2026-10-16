import OpenClawChatUI
import Testing
@testable import OpenClaw

@MainActor
struct SubsessionFoldingTests {
    @Test func `pinned parent keeps children in one tree rather than duplicate page roots`() {
        let sections = ChatSessionSidebarModel.sections(
            sessions: [
                OpenClawChatSessionEntry(key: "parent", pinned: true, childSessions: ["child"]),
                OpenClawChatSessionEntry(key: "child", pinned: true, parentSessionKey: "parent"),
            ],
            currentSessionKey: "parent",
            query: "")
        let layout = RootSidebar.sessionLayout(sections)
        #expect(layout.pinnedNodes.map(\.id) == ["parent"])
        #expect(layout.pinnedNodes.first?.children.map(\.id) == ["child"])
        #expect(!layout.sections.contains { $0.id == "pinned" })
    }

    @Test func `pinned descendant branches retain their ancestry for independent folding`() throws {
        let sections = ChatSessionSidebarModel.sections(
            sessions: [
                OpenClawChatSessionEntry(key: "parent", pinned: true, childSessions: ["child"]),
                OpenClawChatSessionEntry(
                    key: "child", pinned: true, parentSessionKey: "parent", childSessions: ["grandchild"]),
                OpenClawChatSessionEntry(key: "grandchild", pinned: true, parentSessionKey: "child"),
            ],
            currentSessionKey: "parent",
            query: "")
        let layout = RootSidebar.sessionLayout(sections)
        #expect(layout.pinnedNodes.map(\.id) == ["parent"])
        let child = try #require(layout.pinnedNodes.first?.children.first)
        #expect(child.id == "child")
        #expect(child.children.map(\.id) == ["grandchild"])
        #expect(layout.sections.isEmpty)
    }
}
