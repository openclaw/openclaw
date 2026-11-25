import Foundation
import OpenClawChatUI
import Testing
@testable import OpenClaw

@MainActor
struct SessionListSubagentTests {
    private static func row(
        _ key: String,
        at time: Double = 1,
        pinned: Bool = false,
        running: Bool = false,
        parent: String? = nil,
        children: [String]? = nil) -> OpenClawChatSessionEntry
    {
        var entry = OpenClawChatSessionEntry(key: key, updatedAt: time, label: key)
        entry.pinned = pinned
        entry.hasActiveRun = running
        entry.parentSessionKey = parent
        entry.childSessions = children
        return entry
    }

    /// Every key on the sidebar, each with its depth, in display order.
    private static func listed(_ rows: [OpenClawChatSessionEntry]) -> [String] {
        func flatten(_ node: ChatSessionSidebarModel.Node, depth: Int) -> [String] {
            [String(repeating: ">", count: depth) + node.session.key] +
                node.children.flatMap { flatten($0, depth: depth + 1) }
        }
        return RootSidebarModel.sections(
            sessions: CommandCenterTab.listedSessions(rows),
            query: "",
            currentSessionKey: "agent:main:main",
            mainSessionKey: "agent:main:main",
            activeAgentID: "main",
            groups: [])
            .flatMap(\.nodes).flatMap { flatten($0, depth: 0) }
    }

    @Test func `subagent keys follow the Control UI rule`() {
        for key in [
            "subagent:abc", "SubAgent:abc", "agent:main:subagent:abc", " agent:Main:SUBAGENT:abc ",
            "agent:main:subagent:abc:thread:1", "agent::main:subagent:abc",
        ] {
            #expect(CommandCenterTab.isSubagentSessionKey(key), "\(key)")
        }
        for key in [
            "agent:main:main", "agent:main:dashboard:child", "agent:main:ios-subagent", "agent:main",
            "agent::subagent:abc", "main", "agent:main:thread:subagent:x",
        ] {
            #expect(!CommandCenterTab.isSubagentSessionKey(key), "\(key)")
        }
    }

    @Test func `a hidden subagent is never a row, in any of the three cases that left it loose`() {
        let pinnedParent = Self.row("agent:main:pinned", pinned: true, children: ["agent:main:subagent:a"])
        let underPinned = Self.row("agent:main:subagent:a", parent: "agent:main:pinned")
        let main = Self.row("agent:main:main", children: ["agent:main:subagent:b"])
        let underMain = Self.row("agent:main:subagent:b", parent: "agent:main:main")
        // The parent no longer lists this child (the Gateway's child roster is freshness-filtered).
        let dropped = Self.row("agent:main:research", children: [])
        let droppedChild = Self.row("agent:main:subagent:c", parent: "agent:main:research")
        let rows = [pinnedParent, underPinned, main, underMain, dropped, droppedChild]
        #expect(Self.listed(rows) == ["agent:main:pinned", "agent:main:research"])
    }

    @Test func `a visible child a person opened still nests under its parent`() {
        let parent = Self.row(
            "agent:main:plan",
            children: ["agent:main:dashboard:direction-1", "agent:main:subagent:d"])
        let visible = Self.row("agent:main:dashboard:direction-1", parent: "agent:main:plan")
        let hidden = Self.row("agent:main:subagent:d", parent: "agent:main:plan")
        let main = Self.row("agent:main:main")
        #expect(Self.listed([main, parent, visible, hidden]) == [
            "agent:main:plan", ">agent:main:dashboard:direction-1",
        ])
    }

    @Test func `a running hidden subagent makes its nearest listed ancestor read as working`() {
        let parent = Self.row("agent:main:plan")
        let nested = Self.row("agent:main:subagent:outer", parent: "agent:main:plan")
        let running = Self.row("agent:main:subagent:inner", running: true, parent: "agent:main:subagent:outer")
        let idleParent = Self.row("agent:main:other")
        let idle = Self.row("agent:main:subagent:idle", parent: "agent:main:other")
        let listed = CommandCenterTab.listedSessions([parent, nested, running, idleParent, idle])
        #expect(listed.map(\.key) == ["agent:main:plan", "agent:main:other"])
        #expect(SessionListGrouping.isWorking(listed[0]))
        #expect(!SessionListGrouping.isWorking(listed[1]))
        let sections = SessionListGrouping.sections(listed, knownCategories: [], needsApproval: { _ in false })
        #expect(sections.map(\.id) == [.group(.working), .group(.recent)])
        #expect(sections.flatMap(\.sessions).count == 2)
    }

    private static func page(
        _ rows: [OpenClawChatSessionEntry],
        total: Int,
        offset: Int) -> OpenClawChatSessionsListResponse
    {
        OpenClawChatSessionsListResponse(
            ts: nil,
            path: nil,
            count: rows.count,
            totalCount: total,
            offset: offset,
            nextOffset: offset + rows.count,
            hasMore: offset + rows.count < total,
            defaults: nil,
            sessions: rows)
    }

    @Test func `a complete roster with hidden subagents shows no load notice`() async throws {
        // 40 sessions a person can see plus 20 hidden runs: the Gateway's total counts all 60.
        let visible = (0..<40).map { Self.row("agent:main:ios-\($0)") }
        let hidden = (0..<20).map { Self.row("agent:main:subagent:\($0)", parent: "agent:main:ios-0") }
        let all = visible + hidden
        let snapshot = try await ChatSessionRosterSnapshot.collect { offset in
            Self.page(Array(all[offset..<min(all.count, offset + 30)]), total: all.count, offset: offset)
        }
        #expect(snapshot.isComplete)
        let model = RootSidebarModel()
        model.applyRoster(snapshot)
        #expect(model.sessions.count == 40)
        #expect(model.sessionErrorText == nil)
    }

    @Test func `a missing page says so without a count of hidden runs`() async throws {
        let all = (0..<40).map { Self.row("agent:main:ios-\($0)") } +
            (0..<20).map { Self.row("agent:main:subagent:\($0)", parent: "agent:main:ios-0") }
        let snapshot = try await ChatSessionRosterSnapshot.collect { offset in
            guard offset == 0 else { throw URLError(.networkConnectionLost) }
            return Self.page(Array(all[0..<30]), total: all.count, offset: 0)
        }
        #expect(!snapshot.isComplete)
        let model = RootSidebarModel()
        model.applyRoster(snapshot)
        #expect(model.sessionErrorText == "Couldn’t load some sessions. Try again.")
    }
}
