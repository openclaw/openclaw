import Foundation
import OpenClawChatUI
import OpenClawProtocol
import Testing
@testable import OpenClaw

@MainActor
struct RootSidebarEqualityTests {
    @Test func `visible inputs invalidate button equality`() throws {
        let session = OpenClawChatSessionEntry(
            key: "agent:main:work",
            kind: "direct",
            updatedAt: 1,
            sessionId: "work",
            label: "Work")
        func node(for session: OpenClawChatSessionEntry) throws -> ChatSessionSidebarModel.Node {
            try #require(ChatSessionSidebarModel.sections(
                sessions: [session],
                currentSessionKey: session.key,
                query: "").flatMap(\.nodes).first)
        }
        func button(
            entry: OpenClawChatSessionEntry = session,
            selected: Bool = false,
            main: String = "main",
            categories: [String] = [],
            connected: Bool = true,
            minute: Int = 1) throws -> RootSidebarSessionButton
        {
            try RootSidebarSessionButton(
                node: node(for: entry),
                isSelected: selected,
                mainSessionKey: main,
                categories: categories,
                isConnected: connected,
                minute: minute,
                open: { _ in },
                performMutation: { _, _ in },
                fork: { _ in })
        }
        let base = try button()
        #expect(try base == button())
        #expect(try base != button(selected: true))
        #expect(try base != button(main: "other"))
        #expect(try base != button(categories: ["Work"]))
        #expect(try base != button(connected: false))
        #expect(try base != button(minute: 2))
        var changed = session
        changed.status = "running"
        #expect(try node(for: changed).badges.runningCount == 1)
        #expect(try base != button(entry: changed))
        changed = session
        changed.unread = true
        #expect(try base != button(entry: changed))
        changed = session
        changed.label = "Renamed"
        #expect(try base != button(entry: changed))
    }
}
