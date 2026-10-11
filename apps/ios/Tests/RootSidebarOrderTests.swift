import Foundation
import OpenClawChatUI
import Testing
@testable import OpenClaw

@MainActor
struct RootSidebarOrderTests {
    @Test func `unqualified keys in different agents do not share an ordering slot`() throws {
        let rows = try JSONDecoder().decode(OpenClawChatSessionsListResponse.self, from: Data(#"""
        {"sessions":[{"key":"global","agentId":"alpha"},{"key":"global","agentId":"beta"},
        {"key":"agent:alpha:global","agentId":"alpha"}]}
        """#.utf8)).sessions
        let entries = rows.map { RootTabs.SidebarEntry.session(RootTabs.sidebarSessionSlot(for: $0)) }
        #expect(Set(entries).count == 3)
        #expect(entries[2].id == "session:agent:alpha:global")
        #expect(RootTabs.sidebarEntries(from: RootTabs.sidebarEntriesStorage(entries)) == entries)
    }

    @Test func `mixed canonical storage preserves opaque keys and unloaded agent slots`() {
        let entries: [RootTabs.SidebarEntry] = [
            .route(.agents), .session("agent:not-loaded:thread,key"), .route(.usage),
        ]
        #expect(RootTabs.sidebarEntries(from: RootTabs.sidebarEntriesStorage(entries)) == entries)
        #expect(entries.first?.id == "route:agents-home")
        #expect(RootTabs.sidebarEntries(from: "usage,workboard,docs") == [
            .route(.usage), .route(.workboard), .route(.docs),
        ])
        #expect(RootTabs.sidebarEntries(from: "none").isEmpty)
        #expect(RootTabs.sidebarEntries(from: "") == RootTabs.defaultSidebarEntries)
    }

    @Test func `page preferences migrate in pin order and discard duplicate or unpinnable values`() {
        #expect(RootTabs.sidebarEntries(from: "usage,overview,docs") == [
            .route(.usage), .route(.overview), .route(.docs),
        ])
        let pages: [RootTabs.SidebarEntry] = [.route(.docs), .route(.overview), .route(.usage)]
        #expect(RootTabs.sidebarEntries(from: RootTabs.sidebarEntriesStorage(pages)) == pages)
        #expect(RootTabs.sidebarEntries(from: RootTabs.sidebarEntriesStorage([])).isEmpty)
        #expect(RootTabs.sidebarEntries(from: "usage,usage,docs") == [.route(.usage), .route(.docs)])
        #expect(RootTabs.sidebarEntries(from: "chat,bogus").isEmpty)
        #expect(RootTabs.sidebarEntries(from: "chat,overview") == [.route(.overview)])
        #expect(!RootTabs.pinnableSidebarPages.contains(.chat))
    }

    @Test func `reset preserves every saved session slot even when no sessions are loaded`() {
        let entries: [RootTabs.SidebarEntry] = [
            .session("agent:other:older"), .route(.usage),
            .session("agent:missing:newer"),
        ]
        #expect(RootTabs.resetSidebarEntries(entries) == RootTabs.defaultSidebarEntries + [
            .session("agent:other:older"), .session("agent:missing:newer"),
        ])
    }

    @Test func `move crosses page and session boundaries without deleting hidden slots`() {
        let route = RootTabs.SidebarEntry.route(.usage)
        let page = RootTabs.SidebarEntry.route(.workboard)
        let session = RootTabs.SidebarEntry.session("agent:main:visible")
        let hidden = RootTabs.SidebarEntry.session("agent:other:hidden")
        let entries = [route, hidden, page, session]
        let moved = RootTabs.movingSidebarEntry(
            page,
            by: -1,
            entries: entries,
            visibleEntries: [route, page, session])
        #expect(moved == [page, hidden, route, session])
        #expect(RootTabs.movingSidebarEntry(
            session,
            by: -1,
            entries: moved,
            visibleEntries: [page, route, session]) == [
            page,
            hidden,
            session,
            route,
        ])
        #expect(RootTabs.movingSidebarEntry(
            route,
            by: -1,
            entries: entries,
            visibleEntries: [route, page, session]) == entries)
    }

    @Test func `reconcile adds newly pinned rows without replacing saved order or unknown agents`() {
        let entries: [RootTabs.SidebarEntry] = [.session("agent:other:saved"), .route(.usage)]
        let reconciled = RootTabs.reconciledSidebarEntries(
            entries,
            pinnedSessionKeys: ["agent:main:new", "agent:main:new"])
        #expect(reconciled == entries + [.session("agent:main:new")])
        #expect(RootTabs.settingSidebarEntry(
            .session("agent:main:new"),
            pinned: false,
            entries: reconciled) == entries)
    }

    @Test func `shipped defaults survive first launch and reset of the mixed sidebar`() {
        let shipped: [RootTabs.SidebarEntry] = [.route(.overview), .route(.usage), .route(.cron)]
        #expect(RootTabs.sidebarEntries(from: "") == shipped)
        #expect(RootTabs.resetSidebarEntries([.route(.systems), .session("agent:main:saved")]) ==
            shipped + [.session("agent:main:saved")])
    }

    @Test func `shipped page choices remain editable after mixed order is saved`() {
        // v2026.9.9's writer stores raw values in pin order, including native
        // Workboard. Saving the mixed order must not hide that saved choice.
        let storage = "docs,overview,workboard,skillWorkshop,instances,files,dreaming,terminal," +
            "usage,cron,agents,activity,sessions,desktop"
        let upgraded = RootTabs.sidebarEntries(from: storage)
        let savedPages = upgraded.compactMap { entry -> RootTabs.SidebarDestination? in
            if case let .route(page) = entry { return page }
            return nil
        }
        #expect(savedPages.map(\.rawValue).joined(separator: ",") == storage)
        for page in savedPages {
            #expect(RootTabs.sidebarCustomizablePages.contains(page))
            let unpinned = RootTabs.settingSidebarEntry(.route(page), pinned: false, entries: upgraded)
            #expect(!unpinned.contains(.route(page)))
            let repinned = RootTabs.settingSidebarEntry(.route(page), pinned: true, entries: unpinned)
            #expect(RootTabs.sidebarEntries(from: RootTabs.sidebarEntriesStorage(repinned)) == repinned)
        }
        let extended = upgraded + [.route(.systems), .session("agent:main:saved")]
        #expect(RootTabs.sidebarEntries(from: RootTabs.sidebarEntriesStorage(extended)) == extended)
        #expect(RootTabs.sidebarEntries(from: "none").isEmpty)
    }
}
