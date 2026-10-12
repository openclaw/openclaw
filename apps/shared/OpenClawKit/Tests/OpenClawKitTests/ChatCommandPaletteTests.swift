#if os(macOS)
import Foundation
import Testing
@testable import OpenClawChatUI

@MainActor
struct ChatCommandPaletteTests {
    private let agents: [OpenClawChatAgentChoice] = [
        .init(id: "research", name: "Research Assistant", emoji: "🔎"),
        .init(id: "writing", name: "Writer"),
    ]

    private func entry(_ key: String, title: String, updatedAt: Double = 1) -> OpenClawChatSessionEntry {
        var row = OpenClawChatSessionEntry(key: key)
        row.label = title
        row.updatedAt = updatedAt
        return row
    }

    private func items(
        _ rows: [OpenClawChatSessionEntry],
        remote: [OpenClawChatSessionEntry] = [],
        query: String = "",
        preview: (OpenClawChatSessionEntry) -> String? = { _ in nil }) -> [ChatCommandPaletteItem]
    {
        ChatCommandPaletteModel.items(
            agents: self.agents,
            activeAgentID: "research",
            sections: ChatSessionSidebarModel.sections(
                sessions: rows,
                currentSessionKey: rows.first?.key ?? "",
                activeAgentID: "research",
                query: ""),
            remote: remote,
            query: query,
            preview: preview)
    }

    private func threads(_ items: [ChatCommandPaletteItem]) -> [OpenClawChatSessionEntry] {
        items.compactMap {
            if case let .thread(node) = $0 {
                node.session
            } else { nil }
        }
    }

    @Test func `empty query keeps sidebar pin and hierarchy order between agents and actions`() {
        var pinned = self.entry("pinned", title: "Pinned", updatedAt: 1)
        pinned.pinned = true
        var parent = self.entry("parent", title: "Parent", updatedAt: 10)
        parent.childSessions = ["child"]
        let rows = [
            self.entry("recent", title: "Recent", updatedAt: 30),
            parent,
            self.entry("child", title: "Child", updatedAt: 20),
            pinned,
        ]
        let result = self.items(rows, remote: [self.entry("older", title: "Older")])
        #expect(Array(result.prefix(2).map(\.id)) == ["agent:research", "agent:writing"])
        #expect(self.threads(result).map(\.key) == ["pinned", "recent", "parent", "child"])
        #expect(Array(result.suffix(4).map(\.id)) == [
            "action:newThread", "action:threads", "action:find", "action:export",
        ])
    }

    @Test func `search ranks exact then prefix then substring and uses available previews and agent names`() {
        let rows = [
            self.entry("substring", title: "A release note", updatedAt: 30),
            self.entry("prefix", title: "Release notes", updatedAt: 20),
            self.entry("exact", title: "Release", updatedAt: 10),
            self.entry("preview", title: "Planning", updatedAt: 5),
            self.entry("other", title: "Unrelated", updatedAt: 50),
        ]
        let result = self.items(rows, query: "  RELEASE  ") { $0.key == "preview" ? "Next release checklist" : nil }
        #expect(self.threads(result).map(\.key) == ["exact", "prefix", "substring", "preview"])
        #expect(self.threads(self.items(rows, query: "Research Assistant")).count == rows.count)
        #expect(self.items(rows, query: "writer").map(\.id) == ["agent:writing"])
    }

    @Test func `server matches merge without replacing live rows or admitting archived and foreign sessions`() {
        var live = self.entry("live", title: "Current title", updatedAt: 30)
        live.unread = true
        var stale = self.entry("live", title: "Stale title", updatedAt: 1)
        stale.agentId = "research"
        let older = self.entry("older", title: "Older match", updatedAt: 2)
        var archived = self.entry("archived", title: "Hidden")
        archived.archived = true
        let foreign = self.entry("agent:writing:foreign", title: "Wrong agent")
        let remote = [stale, older, older, archived, foreign, self.entry("onboarding", title: "Internal")]
        // A server-only metadata match still admits an already loaded row, but
        // its delayed snapshot must not erase the live label or unread marker.
        let result = self.threads(self.items([live], remote: remote, query: "server-only"))
        #expect(result.map(\.key) == ["live", "older"])
        #expect(result.first?.label == "Current title")
        #expect(result.first?.unread == true)
    }

    @Test func `late responses cannot repaint A changed query or agent even when the query repeats`() {
        let first = ChatCommandPaletteSearch.Request(
            query: "release", target: .init(sessionKey: "global", agentID: "research"))
        let second = ChatCommandPaletteSearch.Request(
            query: "notes", target: first.target)
        let otherAgent = ChatCommandPaletteSearch.Request(
            query: first.query, target: .init(sessionKey: "global", agentID: "writing"))
        var search = ChatCommandPaletteSearch()
        let oldGeneration = search.begin(first)
        let intermediate = search.begin(second)
        let latest = search.begin(first)
        let oldRows = [self.entry("old", title: "Old result")]
        search.complete(oldRows, generation: oldGeneration)
        search.complete(oldRows, generation: intermediate)
        #expect(search.rows(for: first).isEmpty)
        #expect(search.isLoading)
        let rows = [self.entry("new", title: "Current result")]
        search.complete(rows, generation: latest)
        #expect(search.rows(for: first).map(\.key) == ["new"])
        #expect(!search.isLoading)
        #expect(search.rows(for: second).isEmpty)
        #expect(search.rows(for: otherAgent).isEmpty)
        _ = search.begin(otherAgent)
        search.complete(oldRows, generation: latest)
        #expect(search.rows(for: otherAgent).isEmpty)
        let empty = ChatCommandPaletteSearch.Request(query: "", target: first.target)
        _ = search.begin(empty)
        #expect(!search.isLoading)
        #expect(search.rows(for: empty).isEmpty)
    }

    @Test func `thread secondary text preserves attention activity and cached preview priority`() {
        let now = Date(timeIntervalSince1970: 1)
        var row = self.entry("thread", title: "Thread")
        row.status = "running"
        row.agentStatus = .init(note: "Collecting sources", expiresAt: 2000, attention: nil)
        #expect(ChatSessionRowPresentation(
            session: row, isConnected: true, preview: "Previous answer", now: now).subtitle == "Collecting sources")
        #expect(ChatSessionRowPresentation(
            session: row, isConnected: false, preview: "Previous answer", now: now).subtitle == "Previous answer")
        row.agentStatus = .init(note: "Choose a source", expiresAt: 2000, attention: "hand")
        #expect(ChatSessionRowPresentation(
            session: row, isConnected: false, preview: "Previous answer", now: now).subtitle == "Choose a source")
        row.agentStatus = nil
        row.status = "failed"
        row.lastRunError = "Source unavailable"
        row.endedAt = 1000
        #expect(ChatSessionRowPresentation(
            session: row, isConnected: true, preview: "Previous answer", now: now).subtitle == "Source unavailable")
        row.lastReadAt = 1000
        #expect(ChatSessionRowPresentation(
            session: row, isConnected: true, preview: "Previous answer", now: now).subtitle == "Previous answer")
        row.status = "idle"
        #expect(ChatSessionRowPresentation(
            session: row, isConnected: true, preview: nil, now: now).subtitle == nil)
    }

    @Test func `keyboard selection wraps and keeps the chosen identity as results arrive`() {
        let ids = ["agent:research", "thread:one", "action:find"]
        #expect(ChatCommandPaletteModel.selection(in: ids, current: nil) == ids.first)
        #expect(ChatCommandPaletteModel.selection(in: ids, current: ids.first, direction: -1) == ids.last)
        #expect(ChatCommandPaletteModel.selection(in: ids, current: ids.last, direction: 1) == ids.first)
        #expect(ChatCommandPaletteModel.selection(in: ["new"] + ids, current: ids[1]) == ids[1])
        #expect(ChatCommandPaletteModel.selection(in: ids, current: "removed") == ids.first)
        #expect(ChatCommandPaletteModel.selection(in: [], current: ids.first) == nil)
    }
}
#endif
