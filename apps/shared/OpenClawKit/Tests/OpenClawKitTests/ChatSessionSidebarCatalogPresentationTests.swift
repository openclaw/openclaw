#if os(macOS)
import Foundation
import OpenClawProtocol
import Testing
@testable import OpenClawChatUI

private struct CatalogPresentationTransport: OpenClawChatSidebarTransport {
    func loadSidebarAgentAvatar(_: String) async -> Data? {
        nil
    }

    func acquireSidebarRequest() async throws -> @Sendable (OpenClawChatGatewayRequest) async throws -> Data {
        throw CancellationError()
    }

    func requestHistory(sessionKey _: String) async throws -> OpenClawChatHistoryPayload {
        throw CancellationError()
    }

    func requestHealth(timeoutMs _: Int) async throws -> Bool {
        false
    }

    func events() -> AsyncStream<OpenClawChatTransportEvent> {
        AsyncStream { $0.finish() }
    }

    func sendMessage(
        sessionKey _: String,
        message _: String,
        thinking _: String,
        idempotencyKey _: String,
        attachments _: [OpenClawChatAttachmentPayload]) async throws -> OpenClawChatSendResponse
    {
        throw CancellationError()
    }
}

@MainActor
struct ChatSessionSidebarCatalogPresentationTests {
    private let sourceJSON = #"""
    {"catalogs":[
      {"id":"empty","label":"Empty","capabilities":{"continueSession":false,"archive":false},"hosts":[]},
      {"id":"source","label":"Source","capabilities":{"continueSession":true,"archive":true},"hosts":[
        {"hostId":"empty-host","label":"Empty host","kind":"gateway","connected":true,"sessions":[]},
        {"hostId":"host","label":"Host","kind":"node","connected":true,"sessions":[
          {"threadId":"other","sessionKey":"agent:main:other","name":"Stale source title","status":"stored",
           "archived":false,"canContinue":true,"canArchive":true,"createdActor":{"type":"human","id":"alice"}},
          {"threadId":"unset","sessionKey":"agent:main:unset","status":"stored","archived":false,
           "canContinue":true,"canArchive":true,"createdActor":{"type":"human","id":"alice"}},
          {"threadId":"native","name":"","status":"stored","archived":false,
           "canContinue":true,"canArchive":true,"createdActor":{"type":"human","id":"alice"}}
        ]}
      ]}
    ]}
    """#

    private func sources() throws -> [SessionCatalog] {
        try JSONDecoder().decode(SessionsCatalogListResult.self, from: Data(self.sourceJSON.utf8)).catalogs
    }

    private func rows(_ json: String) throws -> [OpenClawChatSessionEntry] {
        try JSONDecoder().decode(OpenClawChatSessionsListResponse.self, from: Data(json.utf8)).sessions
    }

    @Test func `catalog exclusion happens after ordinary projection and promotes retained children`() throws {
        let rows = try self.rows(#"""
        {"sessions":[
          {"key":"agent:main:adopted","childSessions":["agent:main:child"]},
          {"key":"agent:main:child","parentSessionKey":"agent:main:adopted","childSessions":["agent:main:grandchild"]},
          {"key":"agent:main:grandchild","parentSessionKey":"agent:main:child"},
          {"key":"agent:main:pinned","pinned":true,"childSessions":["agent:main:pinned-child"]},
          {"key":"agent:main:pinned-child","pinned":true,"parentSessionKey":"agent:main:pinned"}
        ]}
        """#)
        let current = "agent:main:adopted"
        let sections = ChatSessionSidebarModel.sections(
            sessions: rows, currentSessionKey: current, activeAgentID: "main", query: "")
        let projected = ChatSidebarCatalogPresentation.ordinarySections(
            sections, excluding: [current], currentKey: current, currentIsKnown: true)
        #expect(!projected.flatMap(\.nodes).flatMap(\.previewSessions).contains { $0.key == current })
        let child = try #require(projected.flatMap(\.nodes).first { $0.id == "agent:main:child" })
        #expect(child.children.map(\.id) == ["agent:main:grandchild"])
        let pinned = try #require(projected.first { $0.id == "pinned" })
        #expect(pinned.nodes.map(\.id) == ["agent:main:pinned"])
        #expect(pinned.nodes.first?.children.map(\.id) == ["agent:main:pinned-child"])
    }

    @Test(arguments: [
        ("agent:main:catalog:Source:Host:Thread", true),
        ("catalog:Source:Host:Thread%3AOne", true),
        ("agent::catalog:Source:Host:Thread", false),
        ("catalog:Source:Host:%ZZ", false),
        ("catalog:Source:Host:Thread:extra", false),
    ])
    func `only valid unknown catalog routes suppress the ordinary selected placeholder`(
        route: String,
        catalog: Bool) throws
    {
        let sections = ChatSessionSidebarModel.sections(sessions: [], currentSessionKey: route, query: "")
        #expect(sections.flatMap(\.nodes).map(\.id) == [route])
        let projected = ChatSidebarCatalogPresentation.ordinarySections(
            sections, excluding: [], currentKey: route, currentIsKnown: false)
        #expect(projected.flatMap(\.nodes).isEmpty == catalog)
        let stored = try self.rows(#"{"sessions":[{"key":"\#(route)","label":"Stored conversation"}]}"#)
        let knownSections = ChatSessionSidebarModel.sections(sessions: stored, currentSessionKey: route, query: "")
        let known = ChatSidebarCatalogPresentation.ordinarySections(
            knownSections, excluding: [], currentKey: route, currentIsKnown: true)
        #expect(known.flatMap(\.nodes).map(\.id) == [route])
        #expect(known.flatMap(\.nodes).first?.session.label == "Stored conversation")
    }

    @Test func `catalog exclusion preserves folded activity child hydration and empty groups`() throws {
        let rows = try self.rows(#"""
        {"sessions":[
          {"key":"agent:main:adopted","childSessions":["agent:main:child"]},
          {"key":"agent:main:child","parentSessionKey":"agent:main:adopted",
           "childSessions":["agent:main:subagent:run"]},
          {"key":"agent:main:subagent:run","parentSessionKey":"agent:main:child",
           "status":"running","unread":true,"childSessions":["agent:main:grandchild"]},
          {"key":"agent:main:grandchild","parentSessionKey":"agent:main:subagent:run"},
          {"key":"agent:main:page","pinned":true,"hasActiveSubagentRun":true,
           "childSessions":["agent:main:unloaded"]}
        ]}
        """#)
        let sections = ChatSessionSidebarModel.sections(
            sessions: rows,
            currentSessionKey: "agent:main:adopted",
            activeAgentID: "main",
            groups: [.init(name: "Empty", position: 0)],
            query: "",
            viewOptions: .init(emptyGroups: .never))
        let projected = ChatSidebarCatalogPresentation.ordinarySections(
            sections,
            excluding: ["agent:main:adopted"],
            currentKey: "agent:main:adopted",
            currentIsKnown: true)

        let child = try #require(projected.flatMap(\.nodes).first { $0.id == "agent:main:child" })
        #expect(child.children.map(\.id) == ["agent:main:grandchild"])
        #expect(child.foldedSessions.map(\.key) == ["agent:main:subagent:run"])
        #expect(child.loadParentKeys == ["agent:main:child", "agent:main:subagent:run"])
        #expect(child.hasNavigationChildren)
        #expect(child.badges.runningCount == 1)
        #expect(child.badges.hasUnread)
        let page = try #require(projected.first { $0.id == "pinned" }?.nodes.first)
        #expect(page.children.isEmpty)
        #expect(page.loadParentKeys == ["agent:main:page"])
        #expect(page.hasNavigationChildren)
        #expect(page.badges.runningCount == 1)
        #expect(projected.contains { $0.id == "group:Empty" && $0.nodes.isEmpty })
    }

    @Test func `catalog ownership uses canonical facts outside filtered roster membership`() throws {
        let owner = OpenClawChatSessionSidebarData()
        let query = OpenClawChatSidebarQuery(agentID: "main", ownerId: "alice")
        owner.configureQueries(transport: CatalogPresentationTransport(), query: query)
        let rows = try self.rows(#"""
        {"sessions":[
          {"key":"agent:main:other","label":"Canonical other","owner":{"actor":{"type":"human","id":"bob"}}},
          {"key":"agent:main:unset","label":"Canonical unset"},
          {"key":"agent:main:owned","owner":{"actor":{"type":"human","id":"alice"}}}
        ]}
        """#)
        owner.receive(rows, read: owner.beginRead(), replacingAgent: "main")
        #expect(owner.rows.map(\.key) == ["agent:main:owned"])
        let sources = try self.sources()
        let projection = ChatSidebarCatalogPresentation(
            sources: sources, query: query, allAgents: false, lookup: { owner.row(key: $0, agentID: "main") })
        #expect(projection.catalogs.flatMap(\.hosts).flatMap(\.rows).map(\.threadid) == ["native"])
        #expect(projection.liveRows["agent:main:other"]?.label == "Canonical other")
        #expect(projection.liveRows["agent:main:unset"]?.label == "Canonical unset")
        var involving = query
        involving.involvingMe = true
        let involved = ChatSidebarCatalogPresentation(
            sources: sources, query: involving, allAgents: false, lookup: { owner.row(key: $0, agentID: "main") })
        #expect(involved.catalogs.flatMap(\.hosts).flatMap(\.rows).map(\.threadid) == ["other", "unset", "native"])
    }

    @Test func `catalog section admission shares hidden archived and all agent visibility`() async throws {
        let suite = "ChatSessionSidebarCatalogPresentationTests.\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let ready = AsyncStream<Void>.makeStream(), events = AsyncStream<OpenClawSidebarCatalogEvent>.makeStream()
        let owner = ChatSessionSidebarCatalogs(defaults: defaults, sleep: { _ in
            ready.continuation.yield(())
            throw CancellationError()
        })
        let observer = Task { await owner.observe(events.stream, agentID: "main") }
        defer { owner.stop()
            events.continuation.finish()
            ready.continuation.finish()
            observer.cancel()
        }
        let response = Data(self.sourceJSON.utf8)
        events.continuation.yield(.connected(.init(
            profileID: "profile",
            changedEvents: false,
            allowsArchive: true,
            request: { _ in response },
            isCurrent: { true },
            openSources: {})))
        for await _ in ready.stream {
            break
        }
        func present(
            status: OpenClawChatSidebarStatus = .active,
            allAgents: Bool = false) -> ChatSidebarCatalogPresentation
        {
            .init(
                sources: owner.visible(archived: status == .archived),
                query: .init(agentID: "main", status: status),
                allAgents: allAgents,
                lookup: { _ in nil })
        }
        #expect(present().catalogs.map(\.id) == ["source"])
        #expect(present().catalogs.first?.hosts.map(\.id) == ["host"])
        #expect(present(status: .archived).catalogs.isEmpty)
        #expect(present(allAgents: true).catalogs.isEmpty)
        owner.setHidden("source", true)
        #expect(present().catalogs.isEmpty)
        owner.setHidden("source", false)
        #expect(present(status: .all).catalogs.map(\.id) == ["source"])
    }

    @Test func `catalog rows follow retained archive and snooze facts after leaving the active roster`() throws {
        let owner = OpenClawChatSessionSidebarData()
        owner.configureQueries(transport: CatalogPresentationTransport(), query: .init(agentID: "main"))
        let rows = try self.rows(#"""
        {"sessions":[
          {"key":"agent:main:other","sessionId":"archived-copy"},
          {"key":"agent:main:unset","sessionId":"snoozed-copy"}
        ]}
        """#)
        owner.receive(rows, read: owner.beginRead(), replacingAgent: "main")
        #expect(owner.rows.map(\.key) == rows.map(\.key))
        _ = owner.beginMutation(target: rows[0], field: .archived) { $0.archived = true }
        _ = owner.beginMutation(target: rows[1], field: .snoozed) { $0.snoozedUntil = 3_000_000 }
        #expect(owner.rows(at: Date(timeIntervalSince1970: 2000)).isEmpty)

        let sources = try self.sources()
        for (status, clock, expected) in [
            (OpenClawChatSidebarStatus.active, 2000.0, ["native"]),
            (.snoozed, 2000, ["unset", "native"]),
            (.active, 4000, ["unset", "native"]),
            (.all, 2000, ["other", "unset", "native"]),
        ] {
            let projection = ChatSidebarCatalogPresentation(
                sources: sources,
                query: .init(agentID: "main", status: status),
                allAgents: false,
                now: Date(timeIntervalSince1970: clock),
                lookup: { owner.row(key: $0, agentID: "main") })
            #expect(projection.catalogs.flatMap(\.hosts).flatMap(\.rows).map(\.threadid) == expected)
        }
    }

    @Test func `first load source errors stay visible without rows while offline hosts stay quiet`() throws {
        let sources = try JSONDecoder().decode(SessionsCatalogListResult.self, from: Data(#"""
        {"catalogs":[
          {"id":"provider","label":"Provider","capabilities":{"continueSession":true,"archive":true},
           "hosts":[],"error":{"code":"UNAVAILABLE","message":"Provider failed"}},
          {"id":"host","label":"Host","capabilities":{"continueSession":true,"archive":true},"hosts":[
            {"hostId":"remote","label":"Remote","kind":"node","connected":true,"sessions":[],
             "error":{"code":"UNAVAILABLE","message":"Host failed"}}]},
          {"id":"offline","label":"Offline","capabilities":{"continueSession":true,"archive":true},"hosts":[
            {"hostId":"remote","label":"Remote","kind":"node","connected":false,"sessions":[],
             "error":{"code":"NODE_OFFLINE","message":"Disconnected"}}]}
        ]}
        """#.utf8)).catalogs
        let projection = ChatSidebarCatalogPresentation(
            sources: sources, query: .init(agentID: "main"), allAgents: false, lookup: { _ in nil })
        #expect(projection.catalogs.map(\.id) == ["provider", "host"])
        #expect(projection.catalogs.flatMap(\.hosts).isEmpty)
        #expect(ChatSidebarCatalogPresentation
            .errors(sources[0], requestError: nil) == ["[UNAVAILABLE] Provider failed"])
        #expect(ChatSidebarCatalogPresentation.errors(sources[1], requestError: nil) == ["[UNAVAILABLE] Host failed"])
        let empty = try self.sources()[0]
        let failedPage = ChatSidebarCatalogPresentation(
            sources: [empty],
            requestErrors: [empty.id: "Page request failed"],
            query: .init(agentID: "main"),
            allAgents: false,
            lookup: { _ in nil })
        #expect(failedPage.catalogs.map(\.id) == ["empty"])
    }

    @Test func `catalog projection does not reshape the ordinary forest without adopted exclusions`() throws {
        let rows = try self.rows(#"""
        {"sessions":[
          {"key":"global","agentId":"research","childSessions":["agent:research:child"]},
          {"key":"agent:research:child","agentId":"research"},
          {"key":"global","agentId":"ops","childSessions":["agent:ops:child"]},
          {"key":"agent:ops:child","agentId":"ops"}
        ]}
        """#)
        let raw = "agent:research:catalog:source:host:thread"
        for current in ["agent:research:child", raw] {
            let sections = ChatSessionSidebarModel.sections(sessions: rows, currentSessionKey: current, query: "")
            let projected = ChatSidebarCatalogPresentation.ordinarySections(
                sections, excluding: [], currentKey: current, currentIsKnown: current != raw)
            func layout(_ sections: [ChatSessionSidebarModel.Section]) -> [[String]] {
                sections.flatMap(\.nodes).filter { $0.session.key != raw }.map {
                    [$0.session.agentId ?? "", $0.id] + $0.children.map(\.id)
                }
            }
            // The catalog opt-in must not compound the prerequisite's key-only global hierarchy.
            #expect(layout(projected) == layout(sections))
        }
    }

    @Test func `ranked search keeps flat relevance order and adopted hits without a raw catalog placeholder`() throws {
        let hit = "agent:main:catalog-hit"
        let child = "agent:main:child-hit"
        let rows = try self.rows(#"""
        {"sessions":[
          {"key":"agent:main:child-hit","label":"Best match","parentSessionKey":"agent:main:catalog-hit"},
          {"key":"agent:main:catalog-hit","label":"Parent match","childSessions":["agent:main:child-hit"]}
        ]}
        """#)
        for current in [hit, "agent:main:catalog:source:host:open"] {
            let sections = ChatSessionSidebarModel.sections(
                sessions: rows, currentSessionKey: current, activeAgentID: "main", query: "", rankedSearch: true)
            let projected = ChatSidebarCatalogPresentation.ordinarySections(
                sections, excluding: [hit], rankedSearch: true, currentKey: current, currentIsKnown: current == hit)
            #expect(projected.flatMap(\.nodes).map(\.id) == [child, hit])
            #expect(projected.flatMap(\.nodes).flatMap(\.children).isEmpty)
        }
    }

    @Test func `deleting a source leaves adopted conversations and later selections open`() throws {
        let raw = OpenClawChatSessionTarget(sessionKey: "agent:main:catalog:source:host:thread", agentID: "main")
        let adopted = OpenClawChatSessionTarget(sessionKey: "agent:main:gateway-copy", agentID: "main")
        let row = try JSONDecoder().decode(SessionCatalogSession.self, from: Data(#"""
        {"threadId":"thread","sessionKey":"agent:main:gateway-copy","status":"stored", "archived":false,
         "canContinue":true,"canArchive":true}
        """#.utf8))
        let source = ChatSidebarCatalogPresentation.sourceTarget(
            catalogID: "source", hostID: "host", row: row, agentID: "main")
        #expect(ChatSidebarCatalogPresentation.shouldLeaveDeletedSource(source, current: raw))
        #expect(ChatSidebarCatalogPresentation.shouldLeaveDeletedSource(
            source, current: .init(sessionKey: "catalog:source:host:%74hread", agentID: "main")))
        #expect(!ChatSidebarCatalogPresentation.shouldLeaveDeletedSource(source, current: adopted))
        #expect(!ChatSidebarCatalogPresentation.shouldLeaveDeletedSource(
            .init(sessionKey: "catalog:source:host:caf%C3%A9", agentID: "main"),
            current: .init(sessionKey: "catalog:source:host:cafe%CC%81", agentID: "main")))
        #expect(ChatSidebarCatalogPresentation.shouldLeaveDeletedSource(raw, current: raw))
        #expect(!ChatSidebarCatalogPresentation.shouldLeaveDeletedSource(adopted, current: adopted))
        #expect(!ChatSidebarCatalogPresentation.shouldLeaveDeletedSource(raw, current: adopted))
        #expect(!ChatSidebarCatalogPresentation.shouldLeaveDeletedSource(
            raw, current: .init(sessionKey: raw.sessionKey, agentID: "other")))
    }

    @Test func `adopted navigation retains the canonical agent and empty names remain visible`() throws {
        let rows = try JSONDecoder().decode([SessionCatalogSession].self, from: Data(#"""
        [{"threadId":"source-thread","sessionKey":"agent:ops:adopted","name":"Adopted title","status":"stored",
          "archived":false,"canContinue":true,"canArchive":true},
         {"threadId":"unnamed-thread","name":"","status":"stored","archived":false,
          "canContinue":true,"canArchive":false}]
        """#.utf8))
        let target = ChatSidebarCatalogPresentation.target(
            catalogID: "source",
            hostID: "host",
            row: rows[0],
            agentID: "research")
        #expect(target.sessionKey == "agent:ops:adopted" && target.agentID == "ops")
        #expect(ChatSidebarCatalogPresentation.title(rows[0]) == "Adopted title")
        #expect(ChatSidebarCatalogPresentation.title(rows[1]) == "unnamed-thread")
    }
}
#endif
