#if os(macOS)
import Foundation
import Observation
import OpenClawProtocol
import SwiftUI
import Testing
@testable import OpenClawChatUI

private actor SidebarTreeRequests {
    struct Child: Sendable {
        let key: String
        let agentID: String?
        let reply: CheckedContinuation<OpenClawChatChildSessionsResult, any Error>
    }

    struct Request: Sendable {
        let request: OpenClawChatGatewayRequest
        let reply: CheckedContinuation<Data, any Error>
    }

    private var children: [Child] = []
    private var requests: [Request] = []
    private var childWaiter: CheckedContinuation<Child, Never>?
    private var requestWaiter: CheckedContinuation<Request, Never>?
    private(set) var childCount = 0
    private(set) var requestCount = 0
    private var replyImmediately = false

    func completeFurtherReads() {
        self.replyImmediately = true
    }

    func list(_ key: String, agentID: String?) async throws -> OpenClawChatChildSessionsResult {
        self.childCount += 1
        if self.replyImmediately { return .init(rows: [], isComplete: true) }
        return try await withCheckedThrowingContinuation { reply in
            let child = Child(key: key, agentID: agentID, reply: reply)
            if let waiter = self.childWaiter {
                self.childWaiter = nil
                waiter.resume(returning: child)
            } else { self.children.append(child) }
        }
    }

    func send(_ request: OpenClawChatGatewayRequest) async throws -> Data {
        self.requestCount += 1
        if self.replyImmediately { return Data(#"{"session":null}"#.utf8) }
        return try await withCheckedThrowingContinuation { reply in
            let call = Request(request: request, reply: reply)
            if let waiter = self.requestWaiter {
                self.requestWaiter = nil
                waiter.resume(returning: call)
            } else { self.requests.append(call) }
        }
    }

    func nextChild() async -> Child {
        if !self.children.isEmpty { return self.children.removeFirst() }
        return await withCheckedContinuation { self.childWaiter = $0 }
    }

    func nextRequest() async -> Request {
        if !self.requests.isEmpty { return self.requests.removeFirst() }
        return await withCheckedContinuation { self.requestWaiter = $0 }
    }
}

private struct SidebarTreeTransport: OpenClawChatSidebarTransport {
    func loadSidebarAgentAvatar(_: String) async -> Data? {
        nil
    }

    let requests: SidebarTreeRequests
    var agentID: String?

    func scoped(toAgentID agentID: String) -> (any OpenClawChatTransport)? {
        Self(requests: self.requests, agentID: agentID)
    }

    func acquireSwarmRouteLease() async -> OpenClawChatSwarmRouteLease? {
        .init(isEnabled: { _ in true }, listChildSessions: { try await self.requests.list($0, agentID: self.agentID) })
    }

    func acquireSidebarRequest() async throws -> @Sendable (OpenClawChatGatewayRequest) async throws -> Data {
        { try await self.requests.send($0) }
    }

    func requestHistory(sessionKey _: String) async throws -> OpenClawChatHistoryPayload {
        throw CancellationError()
    }

    func requestHealth(timeoutMs _: Int) async throws -> Bool {
        true
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
struct ChatSessionSidebarTreeTests {
    private let parent = #"{"key":"agent:main:parent","sessionId":"parent","agentId":"main"}"#

    private func rows(_ json: String) throws -> [OpenClawChatSessionEntry] {
        try JSONDecoder().decode([OpenClawChatSessionEntry].self, from: Data("[\(json)]".utf8))
    }

    private func withModel(
        key: String = "agent:main:parent",
        agentID: String = "main",
        rows: String? = nil,
        routingContract: String? = nil,
        body: (OpenClawChatViewModel, OpenClawChatSessionSidebarData, SidebarTreeRequests) async throws -> Void)
        async throws
    {
        let suite = "ChatSessionSidebarTreeTests.\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suite))
        let requests = SidebarTreeRequests()
        let model = OpenClawChatViewModel(
            sessionKey: key,
            transport: SidebarTreeTransport(requests: requests),
            activeAgentId: agentID,
            sessionRoutingContract: routingContract,
            modelPickerStore: ChatModelPickerStore(defaults: defaults))
        defer {
            model.detachTransport()
            defaults.removePersistentDomain(forName: suite)
        }
        model.enableSidebarData()
        let owner = try #require(model.sidebarData)
        try owner.receive(self.rows(rows ?? self.parent), read: owner.beginRead(), replacingAgent: agentID)
        model.healthOK = true
        try await body(model, owner, requests)
    }

    private func refresh(
        _ owner: OpenClawChatSessionSidebarData, _ requests: SidebarTreeRequests, rows: String) async
    {
        let task = Task { await owner.load() }
        let call = await requests.nextRequest()
        #expect(call.request.method == "sessions.list")
        call.reply.resume(returning: Data(#"{"sessions":[\#(rows)],"hasMore":false}"#.utf8))
        await task.value
    }

    private func projected(
        _ store: ChatSessionSidebarChildren,
        _ model: OpenClawChatViewModel,
        _ owner: OpenClawChatSessionSidebarData,
        excludesMain: Bool = false) -> [ChatSessionSidebarModel.Node]
    {
        ChatSessionSidebarModel.sections(
            sessions: owner.rows,
            currentSessionKey: model.sessionKey,
            activeAgentID: model.selectedAgentID,
            excludesMainSession: excludesMain,
            query: "",
            viewOptions: .init(),
            supplementalSessions: store.supplementaryRows(owner: owner),
            lineageRootKey: store.lineageRootKey(owner: owner),
            childMembership: store.childrenKeysByParent(owner: owner)).flatMap(\.nodes)
    }

    @Test func `failed active management reads exclude cached archives and other agents`() async throws {
        try await self.withModel { model, owner, requests in
            owner.setQuery(.init(agentID: nil, status: .all))
            await self.refresh(owner, requests, rows: #"""
            {"key":"agent:main:current","sessionId":"current"},
            {"key":"agent:other:active","sessionId":"active","label":"Research active"},
            {"key":"agent:other:archive","sessionId":"archive","label":"Research archive","archived":true}
            """#)
            #expect(owner.rows.count == 3)
            for query in [nil, "Research"] {
                let rows = await model.fetchSessionList(search: query, archived: false, agentID: "other")
                #expect(rows.map(\.key) == ["agent:other:active"])
            }
            #expect(await model.fetchSessionList(search: nil, archived: true, agentID: "other").isEmpty)
            #expect(model.sessionKey == "agent:main:parent")
        }
    }

    @Test func `another agent Home hydrates through its accepted descriptor without selecting it`() async throws {
        try await self.withModel(
            rows: self.parent + #",{"key":"agent:main:main","agentId":"main","sessionId":"home-main"}"#)
        { model, owner, requests in
            try owner.receive(self.rows(#"""
            {"key":"agent:other:main","agentId":"other","sessionId":"home-other",
             "childSessions":["agent:other:child"]}
            """#), read: owner.beginRead())
            let store = ChatSessionSidebarChildren()
            let other = store.homeSession(model: model, agentID: "other")
            try #require(other.sessionId == "home-other")
            #expect(store.homeSession(model: model).sessionId == "home-main")
            let task = Task { await store.synchronize(model: model, requiredParents: [other]) }
            let call = await requests.nextChild()
            #expect(call.key == "agent:other:main")
            #expect(call.agentID == nil)
            try call.reply.resume(returning: .init(rows: self.rows(
                #"{"key":"agent:other:child","sessionId":"child"}"#), isComplete: true))
            await task.value
            #expect(store.childrenKeysByParent(owner: owner)["agent:other:main"] == ["agent:other:child"])
            #expect(model.sessionKey == "agent:main:parent")
        }
    }

    @Test func `flat search does not start child or ancestry reads`() async throws {
        try await self.withModel { model, owner, requests in
            var query = owner.query
            query.search = "Research"
            owner.setQuery(query)
            let store = ChatSessionSidebarChildren()
            await store.synchronize(model: model, requiredParents: [])
            #expect(await requests.childCount == 0)
            #expect(await requests.requestCount == 0)
        }
    }

    @Test func `incomplete child pages retain canonical membership until explicit retry succeeds`() async throws {
        try await self.withModel { model, owner, requests in
            let store = ChatSessionSidebarChildren()
            let parent = try #require(owner.rows.first)
            let initial = Task { await store.synchronize(model: model, requiredParents: [parent]) }
            let first = await requests.nextChild()
            #expect(first.key == parent.key && first.agentID == nil)
            try first.reply.resume(returning: .init(rows: self.rows(
                #"{"key":"agent:main:old","sessionId":"old","label":"Original"}"#), isComplete: true))
            await initial.value
            try owner.receive(
                self.rows(
                    #"{"key":"agent:main:old","sessionId":"old","label":"Changed by another view"}"#),
                read: owner.beginRead())
            #expect(store.supplementaryRows(owner: owner).first { $0.sessionId == "old" }?.label ==
                "Changed by another view")

            await self.refresh(owner, requests, rows: self.parent)
            let refresh = Task { await store.synchronize(model: model, requiredParents: [parent]) }
            let second = await requests.nextChild()
            try second.reply.resume(returning: .init(rows: self.rows(
                #"{"key":"agent:main:partial","sessionId":"partial"}"#), isComplete: false))
            await refresh.value
            #expect(self.projected(store, model, owner).first?.children.map(\.id) == ["agent:main:old"])
            #expect(store.errors[ChatSessionSidebarChildren.key(for: parent)] != nil)
            #expect(owner.row(key: "agent:main:partial", agentID: "main") == nil)
            await store.synchronize(model: model, requiredParents: [parent])
            #expect(await requests.childCount == 2)

            let rootRefresh = Task { await owner.load() }
            let rootCall = await requests.nextRequest()
            await store.retry(parent: parent, model: model)
            #expect(store.errors[ChatSessionSidebarChildren.key(for: parent)] != nil)
            #expect(await requests.childCount == 2)
            rootCall.reply.resume(throwing: NSError(domain: "SidebarTreeFixture", code: 1))
            await rootRefresh.value
            #expect(owner.errorText != nil)

            let retry = Task { await store.retry(parent: parent, model: model) }
            let third = await requests.nextChild()
            #expect(self.projected(store, model, owner).first?.children.map(\.id) == ["agent:main:old"])
            try third.reply.resume(returning: .init(rows: self.rows(
                #"{"key":"agent:main:new","sessionId":"new"}"#), isComplete: true))
            await retry.value
            #expect(store.childrenKeysByParent(owner: owner)[parent.key] == ["agent:main:new"])
            #expect(store.errors.isEmpty && store.loading.isEmpty)
            await store.synchronize(model: model, requiredParents: [parent])
            #expect(await requests.childCount == 3)
        }
    }

    @Test(arguments: ["parentSessionKey", "spawnedBy"], [false, true])
    func `expanding unions roster children with the hydrated window`(
        parentField: String,
        returnsRows: Bool) async throws
    {
        let child = #"{"key":"agent:main:child","sessionId":"child","\#(parentField)":"agent:main:parent"}"#
        try await self.withModel(rows: self.parent + "," + child) { model, owner, requests in
            let parent = try #require(owner.row(key: "agent:main:parent", agentID: "main"))
            let store = ChatSessionSidebarChildren()
            let collapsed = try #require(self.projected(store, model, owner).first)
            #expect(collapsed.children.map(\.id) == ["agent:main:child"])
            #expect(collapsed.hasNavigationChildren)
            var modes: [String: ChatSidebarChildMode] = [:]
            let binding = ChatSidebarChildMode.expansionBinding(
                modes: Binding(get: { modes }, set: { modes = $0 }),
                key: collapsed.id,
                automaticallyExpanded: false)
            #expect(!binding.wrappedValue)
            binding.wrappedValue = true
            #expect(binding.wrappedValue)

            let expansion = Task { await store.synchronize(model: model, requiredParents: [parent]) }
            let call = await requests.nextChild()
            #expect(binding.wrappedValue)
            let loaded = returnsRows ? try self.rows(child + "," +
                #"{"key":"agent:main:loaded","sessionId":"loaded","parentSessionKey":"agent:main:parent"}"#) : []
            call.reply.resume(returning: .init(rows: loaded, isComplete: true))
            await expansion.value

            let roots = self.projected(store, model, owner)
            let expanded = try #require(roots.first)
            #expect(roots.map(\.id) == [parent.key])
            #expect(Set(expanded.children.map(\.id)) == (returnsRows
                    ? ["agent:main:child", "agent:main:loaded"] : ["agent:main:child"]))
            #expect(expanded.hasNavigationChildren)
            #expect(expanded.loadParentKeys == [parent.key])
            #expect(binding.wrappedValue)
            binding.wrappedValue = false
            #expect(!binding.wrappedValue)
            binding.wrappedValue = true
            #expect(binding.wrappedValue)
        }
    }

    @Test func `complete child refresh retires omitted siblings but preserves the selected ancestry`() async throws {
        let active = #"{"key":"agent:main:active","sessionId":"active","parentSessionKey":"agent:main:parent"}"#
        try await self.withModel(key: "agent:main:active", rows: self.parent + "," + active) { model, owner, requests in
            let parent = try #require(owner.row(key: "agent:main:parent", agentID: "main"))
            let store = ChatSessionSidebarChildren()
            let initial = Task { await store.synchronize(model: model, requiredParents: [parent]) }
            let first = await requests.nextChild()
            try first.reply.resume(returning: .init(rows: self.rows(active + "," +
                    #"{"key":"agent:main:quiet","sessionId":"quiet"}"#), isComplete: true))
            await initial.value
            await self.refresh(owner, requests, rows: self.parent)
            let refresh = Task { await store.synchronize(model: model, requiredParents: [parent]) }
            let second = await requests.nextChild()
            second.reply.resume(returning: .init(rows: [], isComplete: true))
            await refresh.value
            #expect(store.childrenKeysByParent(owner: owner)[parent.key] == ["agent:main:active"])
            #expect(store.lineageRootKey(owner: owner) == parent.key)
        }
    }

    @Test(arguments: ["demand", "query", "scope", "incarnation", "detach", "health", "invalidate"])
    func `retired child reads cannot populate the roster`(retirement: String) async throws {
        try await self.withModel { model, owner, requests in
            let parent = try #require(owner.rows.first)
            let store = ChatSessionSidebarChildren()
            let task = Task { await store.synchronize(model: model, requiredParents: [parent]) }
            let call = await requests.nextChild()
            switch retirement {
            case "demand": await store.synchronize(model: model, requiredParents: [])
            case "query": owner.setQuery(.init(agentID: "research"))
            case "scope": owner.invalidate(clear: true)
            case "incarnation":
                try owner.receive(
                    self.rows(
                        #"{"key":"agent:main:parent","sessionId":"replacement","agentId":"main"}"#),
                    read: owner.beginRead(),
                    replacingAgent: "main")
            case "detach": model.detachTransport()
            case "health": model.healthOK = false
            default: store.invalidate()
            }
            try call.reply.resume(returning: .init(rows: self.rows(
                #"{"key":"agent:main:late","sessionId":"late"}"#), isComplete: true))
            await task.value
            #expect(owner.row(key: "agent:main:late", agentID: "main") == nil)
            let childKeys = store.childrenKeysByParent(owner: owner).values.flatMap(\.self)
            #expect(childKeys.isEmpty)
            await requests.completeFurtherReads()
            await store.retry(parent: parent, model: model)
            #expect(await requests.childCount == 1)
        }
    }

    @Test func `ancestry follows accepted canonical rows and preserves owners for raw parent keys`() async throws {
        try await self.withModel(key: "leaf", agentID: "research", rows: "") { model, owner, requests in
            let store = ChatSessionSidebarChildren()
            let task = Task { await store.synchronize(model: model, requiredParents: []) }
            let leaf = await requests.nextRequest()
            #expect(leaf.request.method == "sessions.describe")
            #expect(leaf.request.params["key"]?.value as? String == "leaf")
            #expect(leaf.request.params["agentId"]?.value as? String == "research")
            try owner.receive(
                self.rows(#"""
                {"key":"leaf","agentId":"research","sessionId":"leaf","parentSessionKey":"branch","updatedAt":20}
                """#),
                read: owner.beginRead())
            leaf.reply.resume(returning: Data(#"""
            {"session":{"key":"leaf","agentId":"research","sessionId":"leaf",
              "parentSessionKey":"wrong-old-parent","updatedAt":10}}
            """#.utf8))
            let branch = await requests.nextRequest()
            #expect(branch.request.params["key"]?.value as? String == "branch")
            #expect(branch.request.params["agentId"]?.value as? String == "research")
            branch.reply.resume(returning: Data(#"""
            {"session":{"key":"branch","agentId":"research","sessionId":"branch",
              "parentSessionKey":"agent:ops:root"}}
            """#.utf8))
            let root = await requests.nextRequest()
            #expect(root.request.params["key"]?.value as? String == "agent:ops:root")
            #expect(root.request.params["agentId"] == nil)
            root.reply.resume(returning: Data(#"{"session":{"key":"agent:ops:root","sessionId":"root"}}"#.utf8))
            await task.value
            #expect(store.lineageRootKey(owner: owner) == "agent:ops:root")
            let tree = try #require(self.projected(store, model, owner).first { $0.id == "agent:ops:root" })
            #expect(tree.children.map(\.id) == ["branch"])
            #expect(tree.children.first?.children.map(\.id) == ["leaf"])
        }
    }

    @Test(arguments: [false, true])
    func `ancestry lookup bounds persisted cycles and deep chains`(cycle: Bool) async throws {
        try await self.withModel(key: "agent:main:node-0", rows: "") { model, owner, requests in
            let store = ChatSessionSidebarChildren()
            let task = Task { await store.synchronize(model: model, requiredParents: []) }
            for index in 0..<(cycle ? 2 : 16) {
                let call = await requests.nextRequest()
                #expect(call.request.params["key"]?.value as? String == "agent:main:node-\(index)")
                let next = cycle ? (index + 1) % 2 : index + 1
                call.reply.resume(returning: Data(#"""
                {"session":{"key":"agent:main:node-\#(index)","sessionId":"node-\#(index)",
                  "parentSessionKey":"agent:main:node-\#(next)"}}
                """#.utf8))
            }
            await task.value
            #expect(store.supplementaryRows(owner: owner).count == (cycle ? 2 : 16))
            #expect(store.errors.isEmpty)
        }
    }

    @Test func `unknown selected ancestry exposes an explicit retry without a cached row`() async throws {
        try await self.withModel(key: "leaf", agentID: "research", rows: "") { model, owner, requests in
            let store = ChatSessionSidebarChildren()
            let initial = Task { await store.synchronize(model: model, requiredParents: []) }
            let failure = await requests.nextRequest()
            failure.reply.resume(throwing: NSError(domain: "SidebarTreeFixture", code: 1))
            await initial.value
            var selected = OpenClawChatSessionEntry(key: "leaf")
            selected.agentId = "research"
            #expect(store.lineageError != nil)
            let retry = Task { await store.retry(parent: selected, model: model) }
            let call = await requests.nextRequest()
            #expect(call.request.params["agentId"]?.value as? String == "research")
            call.reply
                .resume(returning: Data(#"{"session":{"key":"leaf","agentId":"research","sessionId":"leaf"}}"#.utf8))
            await retry.value
            #expect(store.errors.isEmpty && store.lineageError == nil)
            #expect(store.lineageRootKey(owner: owner) == "leaf")
            #expect(await requests.childCount == 0)
        }
    }

    @Test func `only a complete child window replaces parent discovery`() async throws {
        let parentJSON = #"""
        {"key":"agent:main:parent","sessionId":"parent","agentId":"main",
         "childSessions":["agent:main:first","agent:main:second"]}
        """#
        try await self.withModel(rows: parentJSON) { model, owner, requests in
            let store = ChatSessionSidebarChildren()
            let parent = try #require(owner.rows.first)
            let task = Task { await store.synchronize(model: model, requiredParents: [parent]) }
            let call = await requests.nextChild()
            #expect(self.projected(store, model, owner).first?.hasNavigationChildren == true)
            try call.reply.resume(returning: .init(rows: self.rows(
                #"{"key":"agent:main:first","sessionId":"first"}"#), isComplete: false))
            await task.value
            #expect(self.projected(store, model, owner).first?.hasNavigationChildren == true)
            let retry = Task { await store.retry(parent: parent, model: model) }
            let completed = await requests.nextChild()
            completed.reply.resume(returning: .init(rows: [], isComplete: true))
            await retry.value
            #expect(self.projected(store, model, owner).first?.hasNavigationChildren == false)
        }
    }

    @Test func `selected ancestry does not certify sibling absence`() async throws {
        let rows = #"""
        {"key":"agent:main:parent","sessionId":"parent","childSessions":["agent:main:active","agent:main:sibling"]},
        {"key":"agent:main:active","sessionId":"active","parentSessionKey":"agent:main:parent"},
        {"key":"agent:main:sibling","sessionId":"sibling"}
        """#
        try await self.withModel(key: "agent:main:active", rows: rows) { model, owner, _ in
            let store = ChatSessionSidebarChildren()
            await store.synchronize(model: model, requiredParents: [])
            let parent = try #require(self.projected(store, model, owner).first { $0.id == "agent:main:parent" })
            #expect(Set(parent.children.map(\.id)) == ["agent:main:active", "agent:main:sibling"])
        }
    }

    @Test func `accepted child placement updates ancestry within the same root query generation`() async throws {
        let rows = #"""
        {"key":"agent:main:parent-a","sessionId":"parent-a","childSessions":["agent:main:active"]},
        {"key":"agent:main:parent-b","sessionId":"parent-b"},
        {"key":"agent:main:active","sessionId":"active","parentSessionKey":"agent:main:parent-a","updatedAt":10}
        """#
        try await self.withModel(key: "agent:main:active", rows: rows) { model, owner, requests in
            let store = ChatSessionSidebarChildren()
            let generation = owner.queryState?.generation
            let parent = try #require(owner.row(key: "agent:main:parent-a", agentID: "main"))
            let task = Task { await store.synchronize(model: model, requiredParents: [parent]) }
            let call = await requests.nextChild()
            try call.reply.resume(returning: .init(rows: self.rows(#"""
            {"key":"agent:main:active","sessionId":"active","parentSessionKey":"agent:main:parent-b","updatedAt":20}
            """#), isComplete: true))
            await task.value
            await store.synchronize(model: model, requiredParents: [])
            #expect(owner.queryState?.generation == generation)
            #expect(store.lineageRootKey(owner: owner) == "agent:main:parent-b")
            let tree = try #require(self.projected(store, model, owner).first { $0.id == "agent:main:parent-b" })
            #expect(tree.children.map(\.id) == ["agent:main:active"])
        }
    }

    @Test func `failed ancestor discovery does not block the selected session child window`() async throws {
        let parentJSON = #"""
        {"key":"agent:main:parent","sessionId":"parent","parentSessionKey":"agent:main:missing",
         "childSessions":["agent:main:quiet"]}
        """#
        try await self.withModel(rows: parentJSON) { model, owner, requests in
            let store = ChatSessionSidebarChildren()
            let parent = try #require(owner.rows.first)
            let task = Task { await store.synchronize(model: model, requiredParents: [parent]) }
            let ancestor = await requests.nextRequest()
            #expect(ancestor.request.params["key"]?.value as? String == "agent:main:missing")
            await requests.completeFurtherReads()
            ancestor.reply.resume(throwing: NSError(domain: "SidebarTreeFixture", code: 1))
            await task.value
            #expect(await requests.childCount == 1)
            #expect(store.childrenKeysByParent(owner: owner)[parent.key]?.isEmpty == true)
            #expect(self.projected(store, model, owner).first { $0.id == parent.key }?.hasNavigationChildren == false)
            #expect(store.lineageError != nil)
            #expect(store.lineageRootKey(owner: owner) == parent.key)
        }
    }

    @Test func `a collapsed child window cannot outlive its parent incarnation`() async throws {
        try await self.withModel { model, owner, requests in
            let store = ChatSessionSidebarChildren()
            let parent = try #require(owner.rows.first)
            let generation = owner.queryState?.generation
            let task = Task { await store.synchronize(model: model, requiredParents: [parent]) }
            let call = await requests.nextChild()
            try call.reply.resume(returning: .init(rows: self.rows(#"""
            {"key":"agent:main:old-child","sessionId":"old-child","parentSessionKey":"agent:main:parent"}
            """#), isComplete: true))
            await task.value
            try owner.receive(
                self.rows(#"""
                {"key":"agent:main:parent","sessionId":"replacement","agentId":"main",
                 "childSessions":["agent:main:fresh-child"]}
                """#),
                read: owner.beginRead(),
                replacingAgent: "main")
            await store.synchronize(model: model, requiredParents: [])
            #expect(owner.queryState?.generation == generation)
            #expect(!store.supplementaryRows(owner: owner).contains { $0.key == "agent:main:old-child" })
            #expect(store.childrenKeysByParent(owner: owner)[parent.key] == nil)
            let replacement = try #require(self.projected(store, model, owner).first { $0.id == parent.key })
            #expect(replacement.session.sessionId == "replacement")
            #expect(replacement.hasNavigationChildren)
        }
    }

    @Test func `an unlisted Home discovers children across owners through its literal key`() async throws {
        let row = #"{"key":"agent:research:thread","agentId":"research","sessionId":"thread"}"#
        try await self
            .withModel(key: "agent:research:thread", agentID: "research", rows: row) { model, owner, requests in
                let store = ChatSessionSidebarChildren()
                var home = OpenClawChatSessionEntry(key: "main")
                home.agentId = "research"
                let task = Task { await store.synchronize(model: model, requiredParents: [home]) }
                let first = await requests.nextChild()
                #expect(first.key == "main" && first.agentID == nil)
                first.reply.resume(returning: .init(rows: [], isComplete: false))
                await task.value
                let retry = Task { await store.retry(parent: home, model: model) }
                let second = await requests.nextChild()
                #expect(second.key == "main" && second.agentID == nil)
                try second.reply.resume(returning: .init(rows: self.rows(
                    #"{"key":"agent:other:discovered","sessionId":"discovered"}"#), isComplete: true))
                await retry.value
                #expect(self.projected(store, model, owner, excludesMain: true)
                    .contains { $0.id == "agent:other:discovered" })
                #expect(owner.row(key: "main", agentID: "research") == nil)
            }
    }

    @Test(arguments: ["agent:main:main", "global"])
    func `a described Home retains its accepted incarnation after navigating away`(homeKey: String) async throws {
        try await self.withModel(
            key: homeKey,
            rows: "",
            routingContract: homeKey == "global" ? "global|main|main" : nil)
        { model, owner, requests in
            let store = ChatSessionSidebarChildren()
            let task = Task { await store.synchronize(model: model, requiredParents: []) }
            let descriptor = await requests.nextRequest()
            #expect(descriptor.request.params["key"]?.value as? String == homeKey)
            descriptor.reply.resume(returning: Data(#"""
            {"session":{"key":"\#(homeKey)","agentId":"main","sessionId":"accepted-home",
              "childSessions":["agent:main:child"]}}
            """#.utf8))
            await task.value
            #expect(model.sessions.isEmpty)
            let home = store.homeSession(model: model)
            #expect(home.sessionId == "accepted-home")
            #expect(home.childSessions == ["agent:main:child"])
            await requests.completeFurtherReads()
            await store.synchronize(model: model, requiredParents: [home])
            #expect(await requests.childCount == 1)

            try owner.receive(
                self.rows(#"{"key":"agent:main:away","agentId":"main","sessionId":"away"}"#),
                read: owner.beginRead(),
                replacingAgent: "main")
            model.switchSession(to: "agent:main:away", agentID: "main")
            await model.bootstrapTask?.value
            model.healthOK = true
            await store.synchronize(model: model, requiredParents: [])
            #expect(model.sessions.allSatisfy { $0.key != homeKey })
            #expect(owner.row(key: homeKey, agentID: "main")?.sessionId == "accepted-home")
            let retained = store.homeSession(model: model)
            #expect(retained.key == homeKey)
            #expect(retained.sessionId == "accepted-home")
            #expect(retained.childSessions == ["agent:main:child"])
            await store.synchronize(model: model, requiredParents: [retained])
            #expect(store.childrenKeysByParent(owner: owner)[homeKey]?.isEmpty == true)
        }
    }

    @Test(arguments: [false, true])
    func `failed ancestry retires when selected placement or incarnation changes`(newIncarnation: Bool) async throws {
        let initial = #"""
        {"key":"agent:main:parent","sessionId":"parent","parentSessionKey":"agent:main:ancestor","updatedAt":10}
        """#
        try await self.withModel(rows: initial) { model, owner, requests in
            let store = ChatSessionSidebarChildren()
            let generation = owner.queryState?.generation
            let task = Task { await store.synchronize(model: model, requiredParents: []) }
            let ancestor = await requests.nextRequest()
            #expect(ancestor.request.params["key"]?.value as? String == "agent:main:ancestor")
            ancestor.reply.resume(throwing: NSError(domain: "SidebarTreeFixture", code: 1))
            await task.value
            #expect(store.lineageError != nil)

            let parentKey = newIncarnation ? "agent:main:ancestor" : "agent:main:new-parent"
            let sessionID = newIncarnation ? "replacement" : "parent"
            try owner.receive(
                self.rows(#"""
                {"key":"agent:main:parent","sessionId":"\#(sessionID)",
                 "parentSessionKey":"\#(parentKey)","updatedAt":20},
                {"key":"\#(parentKey)","sessionId":"ancestor"}
                """#),
                read: owner.beginRead(),
                replacingAgent: "main")
            await store.synchronize(model: model, requiredParents: [])
            #expect(owner.queryState?.generation == generation)
            #expect(store.lineageError == nil)
            #expect(store.lineageRootKey(owner: owner) == parentKey)
        }
    }

    @Test func `hydrated raw child selection and highlighting retain the child agent`() async throws {
        try await self.withModel { model, owner, requests in
            let store = ChatSessionSidebarChildren()
            let parent = try #require(owner.rows.first)
            try owner.receive(self.rows(
                #"{"key":"leaf","agentId":"main","sessionId":"main-leaf"}"#), read: owner.beginRead())
            let task = Task { await store.synchronize(model: model, requiredParents: [parent]) }
            let call = await requests.nextChild()
            try call.reply.resume(returning: .init(rows: self.rows(#"""
            {"key":"leaf","agentId":"research","sessionId":"research-leaf",
             "parentSessionKey":"agent:main:parent"}
            """#), isComplete: true))
            await task.value
            let child = try #require(self.projected(store, model, owner).first { $0.id == parent.key }?
                .children.first { $0.session.key == "leaf" })
            let tag = ChatSessionSidebarModel.selectionTarget(
                for: child.session,
                fallbackAgentID: model.selectedAgentID)
            let binding = ChatSessionSidebar.selectionBinding(model: model)
            await requests.completeFurtherReads()
            await withCheckedContinuation { (changed: CheckedContinuation<Void, Never>) in
                withObservationTracking {
                    _ = model.sessionKey
                    _ = model.selectedAgentID
                } onChange: {
                    changed.resume()
                }
                binding.wrappedValue = tag
            }
            #expect(model.sessionKey == "leaf")
            #expect(model.selectedAgentID == "research")
            model.switchSession(to: "leaf", agentID: "main")
            #expect(binding.wrappedValue != tag)
        }
    }

    @Test func `presentation updates preserve pending hydration while lifecycle changes retire it`() async throws {
        let initial = #"""
        {"key":"agent:main:parent","agentId":"main","sessionId":"parent","updatedAt":10,
         "status":"idle","unread":false,"lastMessagePreview":"Before","childSessions":["agent:main:child"]}
        """#
        try await self.withModel(rows: initial) { model, owner, requests in
            @MainActor func request(
                _ selected: OpenClawChatSessionEntry, _ parents: [OpenClawChatSessionEntry])
                -> ChatSessionSidebar.HydrationRequest
            {
                .init(
                    scope: .init(owner),
                    generation: owner.queryState?.generation,
                    loading: owner.isLoading,
                    healthy: model.healthOK,
                    selection: selected,
                    parents: parents,
                    inlineParents: Set(parents.map(ChatSessionSidebarChildren.key)),
                    homeParents: [])
            }
            let store = ChatSessionSidebarChildren()
            let parent = try #require(owner.rows.first)
            let before = request(parent, [parent])
            let task = Task { await store.synchronize(model: model, requiredParents: before.parents) }
            let pending = await requests.nextChild()
            try owner.receive(
                self.rows(#"""
                {"key":"agent:main:parent","agentId":"main","sessionId":"parent","updatedAt":20,
                 "status":"running","unread":true,"lastMessagePreview":"Latest","hasActiveRun":true,
                 "activeRunIds":["run"],"childSessions":["agent:main:child"],
                 "observerDigest":{"agentId":"main","runId":"run","revision":2,"updatedAt":20,
                   "headline":"Working","health":"on-track"}}
                """#),
                read: owner.beginRead(),
                replacingAgent: "main")
            let enriched = try #require(owner.rows.first)
            let refreshed = request(enriched, [enriched])
            if before != refreshed {
                await requests.completeFurtherReads()
                await store.synchronize(model: model, requiredParents: refreshed.parents)
            }
            try pending.reply.resume(returning: .init(rows: self.rows(#"""
            {"key":"agent:main:child","sessionId":"child","parentSessionKey":"agent:main:parent"}
            """#), isComplete: true))
            await task.value
            #expect(before == refreshed)
            #expect(owner.row(key: "agent:main:child", agentID: "main")?.sessionId == "child")
            #expect(store.childrenKeysByParent(owner: owner)[parent.key] == ["agent:main:child"])

            let replacement = try #require(self.rows(#"""
            {"key":"agent:main:parent","agentId":"main","sessionId":"replacement",
             "childSessions":["agent:main:child"]}
            """#).first)
            let moved = try #require(self.rows(#"""
            {"key":"agent:main:parent","agentId":"main","sessionId":"parent",
             "parentSessionKey":"agent:main:ancestor","childSessions":["agent:main:child"]}
            """#).first)
            #expect(refreshed != request(enriched, [replacement]))
            #expect(refreshed != request(moved, [enriched]))
            #expect(refreshed != request(enriched, []))
        }
    }
}
#endif
