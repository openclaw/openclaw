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
        let node = try #require(ChatSessionSidebarModel.sections(
            sessions: [session],
            currentSessionKey: session.key,
            query: "").flatMap(\.nodes).first)
        func button(
            selected: Bool = false,
            main: String = "main",
            categories: [String] = [],
            connected: Bool = true,
            minute: Int = 1) -> RootSidebarSessionButton
        {
            RootSidebarSessionButton(
                node: node,
                isSelected: selected,
                mainSessionKey: main,
                categories: categories,
                isConnected: connected,
                minute: minute,
                open: { _ in },
                performMutation: { _, _ in },
                fork: { _ in })
        }
        let base = button()
        #expect(base == button())
        #expect(base != button(selected: true))
        #expect(base != button(main: "other"))
        #expect(base != button(categories: ["Work"]))
        #expect(base != button(connected: false))
        #expect(base != button(minute: 2))
    }
}
