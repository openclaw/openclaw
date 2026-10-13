#if os(macOS)
import Foundation
import OpenClawProtocol
import SwiftUI
import Testing
@testable import OpenClawChatUI

@MainActor
private final class CatalogTestQueue<Value: Sendable> {
    private var values: [Value] = []
    private var waiter: CheckedContinuation<Value, Never>?

    func send(_ value: Value) {
        if let waiter {
            self.waiter = nil
            waiter.resume(returning: value)
        } else { self.values.append(value) }
    }

    func next() async -> Value {
        if !self.values.isEmpty { return self.values.removeFirst() }
        return await withCheckedContinuation { self.waiter = $0 }
    }
}

@MainActor
private final class CatalogAcknowledgedEvents {
    private let input = CatalogTestQueue<OpenClawSidebarCatalogEvent?>()
    private let demands = CatalogTestQueue<Void>()

    func next() async -> OpenClawSidebarCatalogEvent? {
        self.demands.send(())
        return await self.input.next()
    }

    func ready() async {
        await self.demands.next()
    }

    func send(_ event: OpenClawSidebarCatalogEvent) async {
        self.input.send(event)
        // Asking for the next event acknowledges that the prior event was fully handled.
        await self.demands.next()
    }

    func finish() {
        self.input.send(nil)
    }
}

@MainActor
private final class CatalogTestClock {
    struct Wait: Sendable {
        let id: UUID
        let duration: Duration
    }

    let waits = CatalogTestQueue<Wait>()
    let cancellations = CatalogTestQueue<UUID>()
    private var pending: [UUID: CheckedContinuation<Void, any Error>] = [:]

    func sleep(_ duration: Duration) async throws {
        let id = UUID()
        try await withTaskCancellationHandler {
            try Task.checkCancellation()
            try await withCheckedThrowingContinuation { continuation in
                self.pending[id] = continuation
                self.waits.send(Wait(id: id, duration: duration))
            }
        } onCancel: {
            Task { @MainActor in
                if let pending = self.pending.removeValue(forKey: id) {
                    pending.resume(throwing: CancellationError())
                    self.cancellations.send(id)
                }
            }
        }
    }

    func advance(_ wait: Wait) {
        self.pending.removeValue(forKey: wait.id)?.resume()
    }
}

@MainActor
private final class CatalogTestFixture {
    struct Call: Sendable {
        let request: OpenClawChatGatewayRequest
        let reply: CheckedContinuation<Data, any Error>
        let completion: CatalogTestQueue<Bool>
    }

    let calls = CatalogTestQueue<Call>()
    let clock = CatalogTestClock()
    let owner: ChatSessionSidebarCatalogs
    let events = AsyncStream<OpenClawSidebarCatalogEvent>.makeStream()
    var intercept: ((Call) -> Bool)?
    private let suite = "ChatSessionSidebarCatalogsTests.\(UUID().uuidString)"
    private let defaults: UserDefaults
    private let acknowledgedEvents: CatalogAcknowledgedEvents?
    private var observer: Task<Void, Never>?

    init(events: CatalogAcknowledgedEvents? = nil) throws {
        self.defaults = try #require(UserDefaults(suiteName: self.suite))
        self.acknowledgedEvents = events
        let clock = self.clock
        self.owner = ChatSessionSidebarCatalogs(defaults: self.defaults, sleep: { try await clock.sleep($0) })
        let stream = events.map { source in AsyncStream(unfolding: { await source.next() }) } ?? self.events.stream
        self.observer = Task { await self.owner.observe(stream, agentID: "main") }
    }

    func stop() {
        self.owner.stop()
        self.events.continuation.finish()
        self.acknowledgedEvents?.finish()
        self.observer?.cancel()
        self.defaults.removePersistentDomain(forName: self.suite)
    }

    func cancelObservation() async {
        self.observer?.cancel()
        await self.observer?.value
    }

    @discardableResult
    func connect(
        _ data: Data, profile: String = "profile-a", changedEvents: Bool = false, allowsArchive: Bool = true) async
        -> CatalogTestClock.Wait
    {
        let event = OpenClawSidebarCatalogEvent.connected(.init(
            profileID: profile,
            changedEvents: changedEvents,
            allowsArchive: allowsArchive,
            request: { request in
                let completion = CatalogTestQueue<Bool>()
                let response = try await withCheckedThrowingContinuation {
                    let call = Call(request: request, reply: $0, completion: completion)
                    if self.intercept?(call) != true { self.calls.send(call) }
                }
                completion.send(Task.isCancelled)
                return response
            },
            isCurrent: { true },
            openSources: {}))
        if let acknowledgedEvents {
            await acknowledgedEvents.send(event)
        } else {
            self.events.continuation.yield(event)
        }
        let call = await self.calls.next()
        #expect(call.request.method == "sessions.catalog.list")
        #expect(call.request.params["agentId"]?.value as? String == "main")
        call.reply.resume(returning: data)
        return await self.clock.waits.next()
    }
}

@MainActor
struct ChatSessionSidebarCatalogsTests {
    private func row(_ id: String, extra: String = "") -> String {
        #"{"threadId":"\#(id)","status":"stored","archived":false,"canContinue":true,"canArchive":true\#(extra)}"#
    }

    private func host(_ id: String, _ rows: [String], cursor: String? = nil, error: Bool = false) -> String {
        let paging = cursor.map { #", "nextCursor":"\#($0)""# } ?? ""
        let failure = error ? #", "error":{"code":"UNAVAILABLE","message":"Host unavailable"}"# : ""
        return #"{"hostId":"\#(id)","label":"\#(id)","kind":"gateway","connected":true,"sessions":["# +
            #"\#(rows.joined(separator: ","))]\#(paging)\#(failure)}"#
    }

    private func catalog(_ id: String, _ hosts: [String]) -> String {
        #"{"id":"\#(id)","label":"\#(id)","capabilities":{"continueSession":true,"archive":true},"hosts":["# +
            #"\#(hosts.joined(separator: ","))]}"#
    }

    private func page(_ catalogs: [String]) -> Data {
        Data(#"{"catalogs":[\#(catalogs.joined(separator: ","))]}"#.utf8)
    }

    private func rows(_ fixture: CatalogTestFixture, _ catalog: String, _ host: String) -> [String] {
        fixture.owner.catalogs.first { $0.id == catalog }?.hosts.first { $0.hostid == host }?.sessions
            .map(\.threadid) ?? []
    }

    @discardableResult
    private func load(_ fixture: CatalogTestFixture, _ id: String, _ page: Data) async -> OpenClawChatGatewayRequest {
        let task = Task { await fixture.owner.loadMore(id) }
        let call = await fixture.calls.next()
        call.reply.resume(returning: page)
        _ = await task.value
        return call.request
    }

    @Test
    func `catalog pages preserve failed hosts and independent catalogs while terminating cursor cycles`() async throws {
        let fixture = try CatalogTestFixture()
        defer { fixture.stop() }
        await fixture.connect(self.page([
            self.catalog("alpha", [
                self.host("local", [self.row("a")], cursor: "a1"),
                self.host("remote", [self.row("r")], cursor: "r1"),
            ]),
            self.catalog("beta", [self.host("local", [self.row("b")], cursor: "b1")]),
        ]))
        let first = await self.load(fixture, "alpha", self.page([self.catalog("alpha", [
            self.host("local", [self.row("a"), self.row("a2")], cursor: "a2"),
            self.host("remote", [], error: true),
        ])]))
        #expect(first.params["cursors"]?.value as? [String: String] == ["local": "a1", "remote": "r1"])
        #expect(self.rows(fixture, "alpha", "local") == ["a", "a2"])
        #expect(self.rows(fixture, "alpha", "remote") == ["r"])
        #expect(self.rows(fixture, "beta", "local") == ["b"])
        #expect(fixture.owner.errors["alpha"] != nil)
        await self.load(fixture, "beta", self.page([self.catalog("beta", [])]))
        #expect(fixture.owner.errors["beta"] != nil)
        let retry = await self.load(fixture, "alpha", self.page([self.catalog("alpha", [
            self.host("local", [self.row("a2")], cursor: "a1"),
            self.host("remote", [self.row("r2")]),
        ])]))
        #expect(retry.params["cursors"]?.value as? [String: String] == ["local": "a2", "remote": "r1"])
        #expect(self.rows(fixture, "alpha", "local") == ["a", "a2"])
        #expect(self.rows(fixture, "alpha", "remote") == ["r", "r2"])
        #expect(fixture.owner.errors["alpha"] != nil)
        await self.load(fixture, "alpha", self.page([self.catalog("alpha", [self.host("local", [self.row("a3")])])]))
        #expect(self.rows(fixture, "alpha", "local") == ["a", "a2", "a3"])
        #expect(fixture.owner.errors["alpha"] == nil && fixture.owner.errors["beta"] != nil)
    }

    @Test func `refresh replays expanded host windows before publishing replacement rows`() async throws {
        let fixture = try CatalogTestFixture()
        defer { fixture.stop() }
        let first = self.page([self.catalog("alpha", [self.host("local", [self.row("a")], cursor: "one")])])
        await fixture.connect(first)
        await self.load(fixture, "alpha", self.page([self.catalog("alpha", [self.host("local", [self.row("b")])])]))
        let refresh = Task { await fixture.owner.refresh() }
        let root = await fixture.calls.next()
        root.reply.resume(returning: first)
        let expanded = await fixture.calls.next()
        #expect(self.rows(fixture, "alpha", "local") == ["a", "b"])
        #expect(expanded.request.params["cursors"]?.value as? [String: String] == ["local": "one"])
        expanded.reply.resume(returning: self.page([self.catalog("alpha", [self.host("local", [self.row("c")])])]))
        await refresh.value
        #expect(self.rows(fixture, "alpha", "local") == ["a", "c"])
    }

    @Test func `refresh stops at an empty terminal cursor when a held window shrinks`() async throws {
        let fixture = try CatalogTestFixture()
        defer { fixture.stop() }
        let root = self.page([self.catalog("alpha", [self.host("local", [self.row("root")], cursor: "one")])])
        await fixture.connect(root)
        await self.load(
            fixture,
            "alpha",
            self.page([self.catalog("alpha", [self.host("local", [self.row("mid")], cursor: "two")])]))
        await self.load(fixture, "alpha", self.page([self.catalog("alpha", [self.host("local", [self.row("last")])])]))
        var cursors: [String] = []
        fixture.intercept = { call in
            guard let cursor = (call.request.params["cursors"]?.value as? [String: String])?["local"]
            else { return false }
            cursors.append(cursor)
            call.reply.resume(returning: self.page([self.catalog(
                "alpha",
                [self.host("local", [self.row("remaining")], cursor: "")])]))
            return true
        }
        let refresh = Task { await fixture.owner.refresh() }
        let call = await fixture.calls.next()
        call.reply.resume(returning: root)
        await refresh.value
        #expect(cursors == ["one"])
        #expect(self.rows(fixture, "alpha", "local") == ["root", "remaining"])
        #expect(fixture.owner.errors.isEmpty)
    }

    @Test func `discovery reaches rows behind empty prefixes and retains their replay window`() async throws {
        let fixture = try CatalogTestFixture()
        defer { fixture.stop() }
        var cursors: [String] = []
        fixture.intercept = { call in
            guard let cursor = (call.request.params["cursors"]?.value as? [String: String])?["local"]
            else { return false }
            cursors.append(cursor)
            call.reply.resume(returning: self.page([self.catalog("alpha", [
                cursor == "one" ? self.host("local", [], cursor: "two") : self.host("local", [self.row("found")]),
            ])]))
            return true
        }
        let head = self.page([self.catalog("alpha", [self.host("local", [], cursor: "one")])])
        let waiting = await fixture.connect(head)
        #expect(cursors == ["one", "two"])
        #expect(self.rows(fixture, "alpha", "local") == ["found"])
        fixture.clock.advance(waiting)
        let root = await fixture.calls.next()
        root.reply.resume(returning: head)
        _ = await fixture.clock.waits.next()
        #expect(cursors == ["one", "two", "one", "two"])
        #expect(self.rows(fixture, "alpha", "local") == ["found"])
    }

    @Test func `empty discovery prefixes resume after head probes and reset when the head changes`() async throws {
        let fixture = try CatalogTestFixture()
        defer { fixture.stop() }
        var cursors: [String] = []
        fixture.intercept = { call in
            guard let cursor = (call.request.params["cursors"]?.value as? [String: String])?["local"]
            else { return false }
            cursors.append(cursor)
            let host = switch cursor {
            case "a": self.host("local", [], cursor: "b")
            case "c": self.host("local", [], cursor: "d")
            default: self.host("local", [], error: true)
            }
            call.reply.resume(returning: self.page([self.catalog("alpha", [host])]))
            return true
        }
        let head = self.page([self.catalog("alpha", [self.host("local", [], cursor: "a")])])
        var waiting = await fixture.connect(head)
        #expect(cursors == ["a", "b"])
        for response in [
            head,
            self.page([self.catalog("alpha", [self.host("local", [], cursor: "c")])]),
            self.page([self.catalog("alpha", [self.host("local", [self.row("new-head")])])]),
        ] {
            fixture.clock.advance(waiting)
            let root = await fixture.calls.next()
            root.reply.resume(returning: response)
            waiting = await fixture.clock.waits.next()
        }
        #expect(cursors == ["a", "b", "b", "c", "d"])
        #expect(self.rows(fixture, "alpha", "local") == ["new-head"])
        #expect(fixture.owner.errors.isEmpty)
    }

    @Test func `discovery uses current owner visibility and stops when a matching row appears`() async throws {
        let fixture = try CatalogTestFixture()
        defer { fixture.stop() }
        fixture.owner.hasVisibleRows = { catalog in
            catalog.hosts.flatMap(\.sessions).contains { $0.createdactor?.id == "alice" }
        }
        var calls = 0
        fixture.intercept = { call in
            guard call.request.params["catalogId"] != nil else { return false }
            calls += 1
            call.reply.resume(returning: self.page([self.catalog("alpha", [self.host(
                "local",
                [self.row("match", extra: #", "createdActor":{"type":"human","id":"alice"}"#)],
                cursor: "still-more")])]))
            return true
        }
        await fixture.connect(self.page([self.catalog("alpha", [self.host(
            "local",
            [self.row("other", extra: #", "createdActor":{"type":"human","id":"bob"}"#)],
            cursor: "one")])]))
        #expect(calls == 1)
        #expect(self.rows(fixture, "alpha", "local") == ["other", "match"])
        #expect(fixture.owner.catalogs.first?.hosts.first?.nextcursor == "still-more")
    }

    @Test func `repeating discovery cursors stop only their host while another host progresses`() async throws {
        let fixture = try CatalogTestFixture()
        defer { fixture.stop() }
        fixture.owner.hasVisibleRows = { catalog in
            ChatSidebarCatalogPresentation(
                sources: [catalog], query: .init(agentID: "main"), allAgents: false, lookup: { _ in nil })
                .hasVisibleRows
        }
        var requests: [[String: String]] = []
        fixture.intercept = { call in
            guard let cursors = call.request.params["cursors"]?.value as? [String: String] else { return false }
            requests.append(cursors)
            let hosts = cursors["stuck"] == nil
                ? [self.host("healthy", [self.row("found")])]
                : [self.host("stuck", [], cursor: "repeat"), self.host("healthy", [], cursor: "next")]
            call.reply.resume(returning: self.page([self.catalog("alpha", hosts)]))
            return true
        }
        await fixture.connect(self.page([self.catalog("alpha", [
            self.host("stuck", [], cursor: "repeat"), self.host("healthy", [], cursor: "first"),
        ])]))
        #expect(requests == [["stuck": "repeat", "healthy": "first"], ["healthy": "next"]])
        #expect(self.rows(fixture, "alpha", "healthy") == ["found"])
        let stuck = try #require(fixture.owner.catalogs.first?.hosts.first { $0.hostid == "stuck" })
        #expect(stuck.error?["code"]?.value as? String == "PAGINATION_FAILED")
    }

    @Test(arguments: [false, true], ["NODE_OFFLINE", "UNAVAILABLE"])
    func `failed host pages retain their window and publish fresh host metadata`(
        refresh: Bool, code: String) async throws
    {
        let fixture = try CatalogTestFixture()
        defer { fixture.stop() }
        await fixture.connect(self.page([self.catalog("alpha", [self.host("local", [self.row("a")], cursor: "one")])]))
        await self.load(fixture, "alpha", self.page([self.catalog(
            "alpha", [self.host("local", [self.row("b")], cursor: "two")])]))
        let failedHost = #"""
        {"hostId":"local","label":"Renamed node","kind":"node","connected":false,
         "pending":false,"nodeId":"node-new","canStartTerminal":false,"sessions":[],
         "nextCursor":"discarded-new","error":{"code":"\#(code)","message":"Source host went away"}}
        """#
        let response = self.page([self.catalog("alpha", [failedHost])])
        if refresh {
            let task = Task { await fixture.owner.refresh() }
            let call = await fixture.calls.next()
            call.reply.resume(returning: response)
            _ = await task.value
        } else {
            await self.load(fixture, "alpha", response)
        }
        let host = try #require(fixture.owner.catalogs.first?.hosts.first)
        #expect(host.sessions.map(\.threadid) == ["a", "b"] && host.nextcursor == "two")
        #expect(host.label == "Renamed node" && host.kind.value as? String == "node" && !host.connected)
        #expect(host.pending == false && host.nodeid == "node-new" && host.canstartterminal == false)
        #expect(host.error?["code"]?.value as? String == code)
        if code == "NODE_OFFLINE" {
            #expect(fixture.owner.errors["alpha"] == nil)
        } else {
            #expect(fixture.owner.errors["alpha"]?.contains("Source host went away") == true)
        }
    }

    @Test func `reconnect retires an in flight catalog page without leaking rows or errors`() async throws {
        let fixture = try CatalogTestFixture()
        defer { fixture.stop() }
        await fixture.connect(self.page([self.catalog(
            "alpha",
            [self.host("local", [self.row("old")], cursor: "one")])]))
        let loading = Task { await fixture.owner.loadMore("alpha") }
        let stale = await fixture.calls.next()
        await fixture.connect(self.page([self.catalog("alpha", [self.host("local", [self.row("fresh")])])]))
        stale.reply.resume(returning: self.page([self.catalog("alpha", [self.host("local", [self.row("stale")])])]))
        _ = await loading.value
        #expect(self.rows(fixture, "alpha", "local") == ["fresh"])
        #expect(fixture.owner.errors.isEmpty && fixture.owner.loading.isEmpty)
    }

    @Test(arguments: [false, true])
    func `refresh clock uses advertised cadence and is cancelled on disconnect or stop`(advertised: Bool) async throws {
        let fixture = try CatalogTestFixture()
        defer { fixture.stop() }
        let first = await fixture.connect(self.page([]), changedEvents: advertised)
        #expect(first.duration == .seconds(advertised ? 600 : 30))
        fixture.clock.advance(first)
        let refresh = await fixture.calls.next()
        refresh.reply.resume(returning: self.page([]))
        let next = await fixture.clock.waits.next()
        #expect(next.duration == first.duration)
        if advertised { fixture.events.continuation.yield(.disconnected) } else { await fixture.cancelObservation() }
        #expect(await fixture.clock.cancellations.next() == next.id)
        #expect(fixture.owner.connection == nil)
    }

    @Test func `unavailable hello clears the prior scope while a transient disconnect retains it`() async throws {
        let fixture = try CatalogTestFixture()
        defer { fixture.stop() }
        let page = self.page([self.catalog("alpha", [self.host("local", [self.row("prior")])])])
        let first = await fixture.connect(page)
        fixture.owner.setHidden("alpha", true)
        fixture.owner.setGrouping(.person)
        fixture.events.continuation.yield(.disconnected)
        #expect(await fixture.clock.cancellations.next() == first.id)
        #expect(self.rows(fixture, "alpha", "local") == ["prior"])
        #expect(fixture.owner.hidden == ["alpha"] && fixture.owner.grouping == .person)

        let reconnected = await fixture.connect(page)
        let refresh = Task { await fixture.owner.refresh() }
        let pending = await fixture.calls.next()
        fixture.events.continuation.yield(.unavailable)
        #expect(await fixture.clock.cancellations.next() == reconnected.id)
        #expect(fixture.owner.connection == nil && fixture.owner.catalogs.isEmpty)
        #expect(fixture.owner.hidden.isEmpty && fixture.owner.grouping == .project)
        pending.reply.resume(returning: page)
        await refresh.value
        #expect(fixture.owner.catalogs.isEmpty && fixture.owner.errors.isEmpty)
    }

    @Test func `advertised catalog changes replace the safety wait with an authoritative refresh`() async throws {
        let fixture = try CatalogTestFixture()
        defer { fixture.stop() }
        let waiting = await fixture.connect(self.page([]), changedEvents: true)
        fixture.events.continuation.yield(.changed("MAIN"))
        let refresh = await fixture.calls.next()
        #expect(await fixture.clock.cancellations.next() == waiting.id)
        refresh.reply.resume(returning: self.page([self.catalog("alpha", [self.host("local", [self.row("new")])])]))
        let next = await fixture.clock.waits.next()
        #expect(self.rows(fixture, "alpha", "local") == ["new"])
        #expect(next.duration == .seconds(600))
    }

    @Test func `catalog event bursts settle the active refresh before one trailing read`() async throws {
        let events = CatalogAcknowledgedEvents()
        let fixture = try CatalogTestFixture(events: events)
        defer { fixture.stop() }
        await events.ready()
        await fixture.connect(self.page([]), changedEvents: true)
        await events.send(.changed("main"))
        let active = await fixture.calls.next()
        var trailingWindows: [[String]] = []
        let final = self.page([self.catalog("alpha", [self.host("local", [self.row("final")])])])
        fixture.intercept = { call in
            trailingWindows.append(self.rows(fixture, "alpha", "local"))
            call.reply.resume(returning: final)
            return true
        }
        for _ in 0..<3 {
            await events.send(.changed("main"))
        }
        #expect(trailingWindows.isEmpty)
        active.reply.resume(returning: self.page([self.catalog("alpha", [self.host("local", [self.row("first")])])]))
        #expect(await active.completion.next() == false)
        let waiting = await fixture.clock.waits.next()
        #expect(trailingWindows == [["first"]])
        #expect(self.rows(fixture, "alpha", "local") == ["final"])
        #expect(waiting.duration == .seconds(600))
    }

    @Test func `hidden sources and grouping persist per profile and return adopted rows to the roster`() async throws {
        let fixture = try CatalogTestFixture()
        defer { fixture.stop() }
        let page = self.page([self.catalog("alpha", [self.host("local", [
            self.row("adopted", extra: #", "sessionKey":"agent:main:live""#),
        ])])])
        await fixture.connect(page)
        #expect(fixture.owner.adoptedKeys(archived: false).isEmpty)
        fixture.owner.isRendered = true
        #expect(fixture.owner.adoptedKeys(archived: false) == ["agent:main:live"])
        #expect(fixture.owner.visible(archived: true).isEmpty && fixture.owner.adoptedKeys(archived: true).isEmpty)
        fixture.owner.setHidden("alpha", true)
        fixture.owner.setGrouping(.person)
        #expect(fixture.owner.adoptedKeys(archived: false).isEmpty)
        await fixture.connect(page, profile: "profile-b")
        #expect(fixture.owner.hidden.isEmpty && fixture.owner.grouping == .project)
        await fixture.connect(page)
        #expect(fixture.owner.hidden == ["alpha"] && fixture.owner.grouping == .person)
        fixture.owner.setHidden("alpha", false)
        #expect(fixture.owner.adoptedKeys(archived: false) == ["agent:main:live"])
    }

    @Test func `project and person groups preserve source identities and canonical live ownership`() throws {
        let fixture = try CatalogTestFixture()
        defer { fixture.stop() }
        let source = "[" + [
            self.row(
                "Thread:A/B",
                extra: #", "cwd":"/repo/.claude/worktrees/feature/src/", "createdActor":{"type":"human","# +
                    #""id":"alias-a","label":"Ada","identity":{"type":"profile","id":"same"}}"#),
            self.row(
                "alias",
                extra: #", "cwd":"/repo/", "createdActor":{"type":"human","id":"alias-b","label":"Ada","# +
                    #""identity":{"type":"profile","id":"same"}}"#),
            self.row(
                "custom",
                extra: #", "customGroup":" Research ", "cwd":"/other", "createdActor":{"type":"agent","id":"same","# +
                    #""label":"Worker","identity":{"type":"agent","id":"same"}}"#),
            self.row(
                "adopted",
                extra: #", "sessionKey":"agent:main:live", "createdActor":{"type":"human","id":"alias-a"}"#),
        ].joined(separator: ",") + "]"
        let rows = try JSONDecoder().decode([SessionCatalogSession].self, from: Data(source.utf8))
        #expect(fixture.owner.groups(rows).map(\.id) == ["custom:Research", "project:/repo", ""])
        #expect(fixture.owner.groups(rows)[1].rows.map(\.threadid) == ["Thread:A/B", "alias"])
        fixture.owner.setGrouping(.person)
        #expect(fixture.owner.groups(rows).map(\.id) == ["person:profile:same", "person:agent:same", ""])
        let live = try JSONDecoder().decode(
            OpenClawChatSessionEntry.self,
            from: Data(#"{"key":"agent:main:live"}"#.utf8))
        #expect(ChatSessionSidebarCatalogs.filtered(rows, owner: "alias-a", live: [live.key: live])
            .map(\.threadid) == ["Thread:A/B"])
        #expect(ChatSidebarCatalogPresentation.target(
            catalogID: "Source:A",
            hostID: "Host/B",
            row: rows[0],
            agentID: "MAIN").sessionKey ==
            "agent:main:catalog:Source%3AA:Host%2FB:Thread%3AA%2FB")
        #expect(ChatSidebarCatalogPresentation
            .target(catalogID: "a", hostID: "b", row: rows[3], agentID: "MAIN").sessionKey == "agent:main:live")
    }

    @Test(arguments: [false, true])
    func `catalog rows use native selection without joining ordinary batch roots`(adopted: Bool) async throws {
        let fixture = try CatalogTestFixture()
        defer { fixture.stop() }
        let key = adopted ? "agent:main:adopted" : "agent:main:catalog:alpha:local:source"
        await fixture.connect(self.page([self.catalog("alpha", [self.host("local", [
            self.row("source", extra: adopted ? #", "sessionKey":"agent:main:adopted""# : ""),
        ])])]))
        fixture.owner.isRendered = true
        let suite = "ChatCatalogSelection.\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suite))
        let model = OpenClawChatViewModel(
            sessionKey: key,
            transport: CatalogSelectionTransport(),
            activeAgentId: "main",
            modelPickerStore: ChatModelPickerStore(defaults: defaults))
        defer {
            model.detachTransport()
            defaults.removePersistentDomain(forName: suite)
        }
        let ordinary = OpenClawChatSessionEntry(key: "agent:main:ordinary", agentId: "main")
        let catalog = OpenClawChatSessionEntry(key: key, agentId: "main")
        model.sessions = adopted ? [ordinary, catalog] : [ordinary]
        let sidebar = ChatSessionSidebar(
            viewModel: model,
            query: .constant(""),
            groups: .constant([]),
            previews: ChatSessionSidebarPreviews(),
            menuActions: ChatSessionSidebarActions(),
            catalogData: fixture.owner)
        let catalogID = OpenClawChatSessionSidebarData.identity(catalog)
        #expect(sidebar.batchSelectionBinding.wrappedValue == [catalogID])
        sidebar.batchSelectionBinding.wrappedValue = [catalogID, OpenClawChatSessionSidebarData.identity(ordinary)]
        #expect(sidebar.selectedBatchRows.map(\.key) == [ordinary.key])
        #expect(!sidebar.batchSelectionBinding.wrappedValue.contains(catalogID))
    }

    @Test func `read only catalog connections refuse source deletion before issuing an RPC`() async throws {
        let fixture = try CatalogTestFixture()
        defer { fixture.stop() }
        await fixture.connect(
            self.page([self.catalog("alpha", [self.host("local", [self.row("source")])])]),
            allowsArchive: false)
        let catalog = try #require(fixture.owner.catalogs.first)
        let host = try #require(catalog.hosts.first)
        let row = try #require(host.sessions.first)
        var requests = 0
        fixture.intercept = { call in
            requests += 1
            call.reply.resume(returning: Data(#"{"ok":true}"#.utf8))
            return true
        }
        #expect(await fixture.owner.archive(catalog, host: host, row: row) == false)
        #expect(requests == 0)
        #expect(self.rows(fixture, "alpha", "local") == ["source"])
    }

    @Test(arguments: [false, true])
    func `archive carries exact source confirmation and cannot delete a replacement connection row`(
        reconnect: Bool) async throws
    {
        let fixture = try CatalogTestFixture()
        defer { fixture.stop() }
        let page = self.page([self.catalog("Source:A", [self.host("Host/B", [
            self.row("Thread:A/B", extra: #", "sourceHomeId":"home:Case""#),
        ])])])
        await fixture.connect(page)
        let catalog = try #require(fixture.owner.catalogs.first)
        let host = try #require(catalog.hosts.first)
        let row = try #require(host.sessions.first)
        let archive = Task { await fixture.owner.archive(catalog, host: host, row: row) }
        let call = await fixture.calls.next()
        #expect(call.request.method == "sessions.catalog.archive")
        #expect(call.request.params == [
            "agentId": .init("main"),
            "catalogId": .init("Source:A"),
            "hostId": .init("Host/B"),
            "threadId": .init("Thread:A/B"),
            "sourceHomeId": .init("home:Case"),
            "confirmNoOtherRunner": .init(true),
        ])
        if reconnect { await fixture.connect(page, profile: "replacement") }
        call.reply.resume(returning: Data(#"{"ok":true}"#.utf8))
        #expect(await archive.value == !reconnect)
        #expect(self.rows(fixture, "Source:A", "Host/B") == (reconnect ? ["Thread:A/B"] : []))
    }
}

private struct CatalogSelectionTransport: OpenClawChatTransport {
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

#endif
