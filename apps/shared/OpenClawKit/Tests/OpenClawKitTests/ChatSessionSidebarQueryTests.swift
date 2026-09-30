import Foundation
import OpenClawProtocol
import SwiftUI
import Testing
@testable import OpenClawChatUI

private actor SidebarQueryTransport: OpenClawChatSidebarTransport {
    func loadSidebarAgentAvatar(_: String) async -> Data? {
        nil
    }

    struct Pending: Sendable {
        let request: OpenClawChatGatewayRequest
        let reply: CheckedContinuation<Data, any Error>
    }

    private var pending: [String: [Pending]] = [:]
    private var waiting: [String: CheckedContinuation<Pending, Never>] = [:]
    private var automaticReply: Data?
    private var responder: (@Sendable (OpenClawChatGatewayRequest) throws -> Data)?
    private var queuedReplies: [Data] = []
    private(set) var requests: [OpenClawChatGatewayRequest] = []

    func acquireSidebarRequest() async throws -> @Sendable (OpenClawChatGatewayRequest) async throws -> Data {
        { try await self.send($0) }
    }

    private func send(_ request: OpenClawChatGatewayRequest) async throws -> Data {
        self.requests.append(request)
        if let responder { return try responder(request) }
        if !self.queuedReplies.isEmpty { return self.queuedReplies.removeFirst() }
        if let automaticReply { return automaticReply }
        return try await withCheckedThrowingContinuation { reply in
            let call = Pending(request: request, reply: reply)
            if let waiter = self.waiting.removeValue(forKey: request.method) {
                waiter.resume(returning: call)
            } else {
                self.pending[request.method, default: []].append(call)
            }
        }
    }

    func next(_ method: String = "sessions.list") async -> Pending {
        if let call = self.pending[method]?.first {
            self.pending[method]?.removeFirst()
            return call
        }
        return await withCheckedContinuation { self.waiting[method] = $0 }
    }

    func replyAutomatically(with data: Data, after replies: [Data] = []) {
        self.automaticReply = data
        self.queuedReplies = replies
    }

    func replyUsing(_ responder: @escaping @Sendable (OpenClawChatGatewayRequest) throws -> Data) {
        self.responder = responder
    }

    nonisolated func scoped(toAgentID _: String) -> (any OpenClawChatTransport)? {
        self
    }

    func acquireSessionSettingsRouteLease() async -> OpenClawChatSessionSettingsRouteLease? {
        OpenClawChatSessionSettingsRouteLease { key, agentID, patch in
            let response = try await self.send(OpenClawChatGatewayRequests.patchSessionSettings(
                sessionKey: key, agentID: agentID, model: patch.model))
            return try JSONDecoder().decode(OpenClawChatModelPatchResult.self, from: response)
        }
    }

    func requestHistory(sessionKey _: String) async throws -> OpenClawChatHistoryPayload {
        throw CancellationError()
    }

    func requestHealth(timeoutMs _: Int) async throws -> Bool {
        true
    }

    nonisolated func events() -> AsyncStream<OpenClawChatTransportEvent> {
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
struct ChatSessionSidebarQueryTests {
    @Test(arguments: [false, true])
    func `owner tree context retains only currently linked loaded descendants`(allAgents: Bool) async throws {
        let transport = SidebarQueryTransport()
        let agentID = allAgents ? nil : "main"
        let owner = self.owner(transport, query: .init(agentID: agentID))
        let parent = #"""
        {"key":"agent:main:parent","sessionId":"parent","owner":{"actor":{"type":"human","id":"alice"}},
         "childSessions":["agent:main:child"]}
        """#
        let child = #"""
        {"key":"agent:main:child","sessionId":"child","owner":{"actor":{"type":"human","id":"bob"}},
         "unread":true,"status":"failed"}
        """#
        _ = await self.load(owner, transport, self.page([parent, child]))
        if owner.setQuery(.init(agentID: agentID, ownerId: "alice")) {
            _ = await self.load(owner, transport, self.page([parent]))
        }
        #expect(owner.rows.map(\.sessionId) == ["parent"])
        #expect(owner.rowsIncludingLoadedDescendants.map(\.sessionId) == ["parent", "child"])
        var updated = try #require(owner.rows.first)
        updated.childSessions = []
        owner.receive([updated], read: owner.beginRead())
        #expect(owner.rowsIncludingLoadedDescendants.map(\.sessionId) == ["parent"])
        updated.childSessions = ["agent:main:child"]
        owner.receive([updated], read: owner.beginRead())
        #expect(owner.rowsIncludingLoadedDescendants.count == 2)
        // Fractional seconds can round upward through the wire millisecond conversion.
        let wake = Date(timeIntervalSince1970: Date.now.timeIntervalSince1970.rounded(.up) + 3600)
        updated.snoozedUntil = wake.timeIntervalSince1970 * 1000
        owner.receive([updated], read: owner.beginRead())
        #expect(owner.rows(at: wake.addingTimeInterval(-1)).isEmpty)
        #expect(owner.rowsIncludingLoadedDescendants.map(\.sessionId) == ["parent", "child"])
        #expect(owner.rows(at: wake).map(\.sessionId) == ["parent"])
        owner.setQuery(.init(agentID: agentID, search: "parent", ownerId: "alice"))
        #expect(owner.rowsIncludingLoadedDescendants == owner.queryRows)
        owner.setQuery(.init(agentID: agentID, involvingMe: true))
        #expect(owner.rowsIncludingLoadedDescendants == owner.queryRows)
    }

    @Test func `paging and retained refresh preserve enrichment beyond the Gateway response cap`() async {
        let transport = SidebarQueryTransport()
        let owner = self.owner(transport)
        await transport.replyUsing { request in
            let offset = request.params["offset"]?.value as? Int ?? 0
            let limit = request.params["limit"]?.value as? Int ?? 0
            let end = min(205, offset + limit)
            let rows = (offset..<end).map { index -> [String: Any] in
                var row: [String: Any] = ["key": "agent:main:row-\(index)", "sessionId": "row-\(index)"]
                // The Gateway admits transcript fields for only the first 100 rows per response.
                if index - offset < 100 {
                    row["derivedTitle"] = "Title \(index)"
                    row["lastMessagePreview"] = "Preview \(index)"
                }
                return row
            }
            return try JSONSerialization.data(withJSONObject: [
                "sessions": rows, "hasMore": end < 205, "nextOffset": end, "totalCount": 205,
                "owners": [["type": "human", "id": "owner"]],
            ])
        }
        await owner.load()
        #expect(owner.rows.allSatisfy { $0.derivedTitle != nil && $0.lastMessagePreview != nil })
        await owner.load(append: true)
        await owner.load(append: true)
        #expect(owner.rows.count == 205)
        await owner.load()
        #expect(owner.rows.count == 205)
        #expect(owner.rows.allSatisfy { $0.derivedTitle != nil && $0.lastMessagePreview != nil })
        #expect(owner.owners?.map(\.id) == ["owner"])
        #expect(await transport.requests.allSatisfy { ($0.params["limit"]?.value as? Int ?? 0) <= 100 })
    }

    #if os(macOS)
    @Test func `unrelated batch activity does not swallow a single archive`() async throws {
        let suite = "ChatSessionSidebarQueryTests.ArchiveConcurrency.\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let transport = SidebarQueryTransport()
        let vm = OpenClawChatViewModel(
            sessionKey: "agent:main:main", transport: transport, activeAgentId: "main",
            modelPickerStore: ChatModelPickerStore(defaults: defaults))
        defer { vm.detachTransport() }
        vm.enableSidebarData()
        let row = try JSONDecoder().decode(OpenClawChatSessionEntry.self, from: Data(self.row("target").utf8))
        let batch = ChatSessionSidebarBatch()
        batch.running = true
        var calls = 0
        batch.connection = try ChatSessionSidebarArchiveUndoTests().connection { _ in
            calls += 1
            return Data(
                #"{"ok":true,"key":"agent:main:target","entry":{"sessionId":"target","archivedAt":20,"updatedAt":20}}"#
                    .utf8)
        }
        let sidebar = ChatSessionSidebar(
            viewModel: vm, query: .constant(""), groups: .constant([]), previews: .init(), batch: batch)
        await sidebar.archiveSidebarSession(row)
        #expect(calls == 1)
        #expect(batch.running)
    }

    @Test(arguments: [false, true], [false, true])
    func `archive completion leaves a replacement incarnation selected`(
        batchAction: Bool, replace: Bool) async throws
    {
        let suite = "ChatSessionSidebarQueryTests.ArchiveIdentity.\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let transport = SidebarQueryTransport()
        let vm = OpenClawChatViewModel(
            sessionKey: "agent:main:target", transport: transport, activeAgentId: "main",
            modelPickerStore: ChatModelPickerStore(defaults: defaults))
        defer { vm.detachTransport() }
        vm.enableSidebarData()
        vm.healthOK = true
        let owner = try #require(vm.sidebarData)
        let row = try JSONDecoder().decode(OpenClawChatSessionEntry.self, from: Data(self.row("target").utf8))
        owner.receive([row], read: owner.beginRead(), replacingAgent: "main")
        let batch = ChatSessionSidebarBatch()
        var completion: CheckedContinuation<Void, Never>?
        batch.connection = try ChatSessionSidebarArchiveUndoTests().connection { _ in
            if replace {
                var replacement = row
                replacement.sessionId = "replacement"
                replacement.updatedAt = 40
                owner.receive([replacement], read: owner.beginRead(), replacingAgent: "main")
            }
            defer { completion?.resume() }
            return batchAction ? Data(#"{"outcomes":[{"key":"agent:main:target","ok":true}]}"#.utf8) :
                Data(
                    #"{"ok":true,"key":"agent:main:target","entry":{"sessionId":"target","archivedAt":20,"updatedAt":20}}"#
                        .utf8)
        }
        await transport.replyAutomatically(with: self.page([]))
        let sidebar = ChatSessionSidebar(
            viewModel: vm, query: .constant(""), groups: .constant([]), previews: .init(), batch: batch)
        await withCheckedContinuation { completion = $0
            if batchAction { sidebar.runSidebarBatch(.archived(true), rows: [row]) }
            else { Task { await sidebar.archiveSidebarSession(row) } }
        }
        await owner.queryTask?.value
        #expect(vm.matchesCurrentSessionKey(incoming: row.key, agentId: "main", current: vm.sessionKey) == replace)
    }

    @Test(arguments: [false, true], [false, true])
    func `archive completion refreshes the current query once after navigation`(
        batchAction: Bool, changeQuery: Bool) async throws
    {
        let suite = "ChatSessionSidebarQueryTests.Archive.\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let transport = SidebarQueryTransport()
        let vm = OpenClawChatViewModel(
            sessionKey: "agent:main:main", transport: transport, activeAgentId: "main",
            modelPickerStore: ChatModelPickerStore(defaults: defaults))
        defer { vm.detachTransport() }
        vm.enableSidebarData()
        vm.healthOK = true
        let owner = try #require(vm.sidebarData)
        let row = try JSONDecoder().decode(OpenClawChatSessionEntry.self, from: Data(self.row("target").utf8))
        owner.receive([row], read: owner.beginRead(), replacingAgent: "main")
        let batch = ChatSessionSidebarBatch()
        var completion: CheckedContinuation<Void, Never>?
        batch.connection = try ChatSessionSidebarArchiveUndoTests().connection { _ in
            if changeQuery {
                owner.setQuery(.init(agentID: "research"))
                batch.reset(clearConnection: false)
            }
            defer { completion?.resume() }
            return batchAction ? Data(#"{"outcomes":[{"key":"agent:main:target","ok":true}]}"#.utf8) :
                Data(
                    #"{"ok":true,"key":"agent:main:target","entry":{"sessionId":"target","archivedAt":20,"updatedAt":20}}"#
                        .utf8)
        }
        await transport.replyAutomatically(with: self.page([]))
        let sidebar = ChatSessionSidebar(
            viewModel: vm, query: .constant(""), groups: .constant([]), previews: .init(), batch: batch)
        await withCheckedContinuation { completion = $0
            if batchAction { sidebar.runSidebarBatch(.archived(true), rows: [row]) }
            else { Task { await sidebar.archiveSidebarSession(row) } }
        }
        let refreshed = try #require(owner.queryTask)
        await refreshed.value
        #expect(owner.rows.isEmpty)
        #expect(await transport.requests.count == 1)
        #expect(await transport.requests.first?.params["agentId"]?
            .value as? String == (changeQuery ? "research" : "main"))
        #expect(batch.archiveUndo?.rows.map(\.key) == [row.key])
        #expect(batch.archiveUndo?.rows.first?.sessionId == row.sessionId)
    }

    @Test func `batch archive returns to the current agents main after navigation`() async throws {
        let suite = "ChatSessionSidebarQueryTests.ArchiveDestination.\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let transport = SidebarQueryTransport()
        let vm = OpenClawChatViewModel(
            sessionKey: "agent:main:main", transport: transport, activeAgentId: "main",
            modelPickerStore: ChatModelPickerStore(defaults: defaults))
        defer { vm.detachTransport() }
        vm.enableSidebarData()
        vm.updateSidebarQuery(agentScope: .all)
        let owner = try #require(vm.sidebarData)
        let row = try JSONDecoder().decode(OpenClawChatSessionEntry.self, from: Data(#"""
        {"key":"agent:research:target","agentId":"research","sessionId":"target","updatedAt":10}
        """#.utf8))
        owner.receive([row], read: owner.beginRead())
        let batch = ChatSessionSidebarBatch()
        var completion: CheckedContinuation<Void, Never>?
        batch.connection = try ChatSessionSidebarArchiveUndoTests().connection { _ in
            vm.switchSession(to: row.key, agentID: row.agentId)
            vm.updateSidebarQuery(agentScope: .selected)
            batch.reset(clearConnection: false)
            defer { completion?.resume() }
            return Data(#"{"outcomes":[{"key":"agent:research:target","ok":true}]}"#.utf8)
        }
        await transport.replyAutomatically(with: self.page([]))
        vm.healthOK = true
        let sidebar = ChatSessionSidebar(
            viewModel: vm, query: .constant(""), groups: .constant([]), previews: .init(), batch: batch)
        await withCheckedContinuation { completion = $0
            sidebar.runSidebarBatch(.archived(true), rows: [row])
        }
        await owner.queryTask?.value
        #expect(vm.sessionKey == "agent:research:main")
    }

    @Test func `queued undo restores the clicked receipt and preserves a newer notification`() async throws {
        let suite = "ChatSessionSidebarQueryTests.UndoClick.\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let transport = SidebarQueryTransport()
        let vm = OpenClawChatViewModel(
            sessionKey: "agent:main:main", transport: transport, activeAgentId: "main",
            modelPickerStore: ChatModelPickerStore(defaults: defaults))
        defer { vm.detachTransport() }
        let first = try JSONDecoder().decode(OpenClawChatSessionEntry.self, from: Data(self.row("first").utf8))
        let second = try JSONDecoder().decode(OpenClawChatSessionEntry.self, from: Data(self.row("second").utf8))
        let batch = ChatSessionSidebarBatch()
        var restored: [String] = []
        var completion: CheckedContinuation<Void, Never>?
        let connection = try ChatSessionSidebarArchiveUndoTests().connection { request in
            let key = try #require(request.params["key"]?.value as? String)
            let row = key == first.key ? first : second
            let archived = request.params["archived"]?.value as? Bool == true
            if !archived { restored.append(key) }
            defer { if !archived { completion?.resume() } }
            return try JSONSerialization.data(withJSONObject: [
                "ok": true, "key": key, "entry": ["sessionId": row.sessionId!, "updatedAt": 20],
            ])
        }
        let clicked = try #require(await batch.archive(first, mainKey: "main", connection: connection, owner: nil))
        let sidebar = ChatSessionSidebar(
            viewModel: vm, query: .constant(""), groups: .constant([]), previews: .init(), batch: batch)
        var newer: ChatSidebarArchiveReceipt?
        await withCheckedContinuation { completion = $0
            sidebar.undoSidebarArchive(clicked)
            newer = batch.offerArchiveUndo([second], connection: connection)
        }
        #expect(restored == [first.key])
        #expect(batch.archiveUndo?.id == newer?.id)
    }
    #endif

    private func owner(
        _ transport: SidebarQueryTransport,
        query: OpenClawChatSidebarQuery = .init(agentID: "main")) -> OpenClawChatSessionSidebarData
    {
        let owner = OpenClawChatSessionSidebarData()
        owner.configureQueries(transport: transport, query: query)
        return owner
    }

    private func row(_ name: String, label: String = "Work", updatedAt: Int = 10) -> String {
        #"{"key":"agent:main:\#(name)","sessionId":"\#(name)","label":"\#(label)","updatedAt":\#(updatedAt)}"#
    }

    private func page(_ rows: [String], paging: String = #""hasMore":false,"nextOffset":null"#) -> Data {
        Data(#"{"count":\#(rows.count),"sessions":[\#(rows.joined(separator: ","))],\#(paging)}"#.utf8)
    }

    private func load(
        _ owner: OpenClawChatSessionSidebarData,
        _ transport: SidebarQueryTransport,
        _ data: Data,
        append: Bool = false) async -> OpenClawChatGatewayRequest
    {
        let task = Task { await owner.load(append: append) }
        let call = await transport.next()
        call.reply.resume(returning: data)
        await task.value
        return call.request
    }

    @Test func `status projection wakes cached rows at the exact deadline without another request`() async {
        let transport = SidebarQueryTransport()
        let owner = self.owner(transport, query: .init(agentID: nil))
        _ = await self.load(owner, transport, self.page([
            self.row("awake"),
            #"{"key":"agent:main:snoozed","sessionId":"snoozed","snoozedUntil":101000}"#,
            #"{"key":"agent:main:expired","sessionId":"expired","snoozedUntil":99000}"#,
            #"{"key":"agent:main:archived","sessionId":"archived","archived":true,"snoozedUntil":102000}"#,
        ]))
        let cases: [(OpenClawChatSidebarStatus, [String], [String])] = [
            (.active, ["awake", "expired"], ["awake", "snoozed", "expired"]),
            (.snoozed, ["snoozed"], []),
            (.archived, ["archived"], ["archived"]),
            (.all, ["awake", "snoozed", "expired", "archived"], ["awake", "snoozed", "expired", "archived"]),
        ]
        for (status, beforeWake, atWake) in cases {
            #expect(!owner.setQuery(.init(agentID: nil, status: status)))
            #expect(owner.rows(at: Date(timeIntervalSince1970: 100)).compactMap(\.sessionId) == beforeWake)
            #expect(owner.rows(at: Date(timeIntervalSince1970: 101)).compactMap(\.sessionId) == atWake)
        }
        #expect(await transport.requests.count == 1)
    }

    @Test func `active and snoozed queries share the non archived request and loaded membership`() async {
        let transport = SidebarQueryTransport()
        let owner = self.owner(transport)
        let activeRequest = await self.load(owner, transport, self.page([
            #"{"key":"agent:main:snoozed","sessionId":"snoozed","snoozedUntil":101000}"#,
        ]))
        #expect(owner.rows(at: Date(timeIntervalSince1970: 100)).isEmpty)
        #expect(!owner.setQuery(.init(agentID: "main", status: .snoozed)))
        #expect(owner.rows(at: Date(timeIntervalSince1970: 100)).map(\.sessionId) == ["snoozed"])
        let snoozedRequest = OpenClawChatGatewayRequests.sidebarSessions(query: owner.query, limit: 100)
        #expect(activeRequest.params["archived"] == nil)
        #expect(snoozedRequest.params == activeRequest.params)
        #expect(await transport.requests.count == 1)
    }

    @Test func `selected rows cannot bypass snooze status or reappear as placeholders`() throws {
        let sessions = try JSONDecoder().decode(OpenClawChatSessionsListResponse.self, from: self.page([
            self.row("awake"),
            #"{"key":"agent:main:snoozed","sessionId":"snoozed","snoozedUntil":101000}"#,
        ])).sessions
        let cases: [(OpenClawChatSidebarStatus, String, [String])] = [
            (.active, "snoozed", ["awake"]),
            (.snoozed, "awake", ["snoozed"]),
            (.snoozed, "missing", ["snoozed"]),
            (.all, "snoozed", ["awake", "snoozed"]),
        ]
        for (status, selected, expected) in cases {
            let sections = ChatSessionSidebarModel.sections(
                sessions: sessions,
                currentSessionKey: "agent:main:\(selected)",
                activeAgentID: "main",
                query: "",
                viewOptions: .init(status: status),
                now: Date(timeIntervalSince1970: 100))
            #expect(sections.flatMap(\.nodes).map(\.id).sorted() == expected.map { "agent:main:\($0)" })
        }
    }

    @Test(arguments: [("global", String?.none), ("global", "ops"), ("agent:ops:main", "ops")])
    func `model selection preserves one global placeholder until its roster row arrives`(
        _ input: (String, String?)) async throws
    {
        let (key, agentID) = input
        let suite = "ChatSessionSidebarQueryTests.ModelPlaceholder.\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let transport = SidebarQueryTransport()
        await transport.replyAutomatically(with: self.modelReply())
        let vm = OpenClawChatViewModel(
            sessionKey: key, transport: transport, activeAgentId: agentID,
            sessionRoutingContract: agentID == nil ? nil : "global|main|main",
            modelPickerStore: ChatModelPickerStore(defaults: defaults))
        defer { vm.detachTransport() }
        vm.enableSidebarData()
        #expect(vm.sessions.isEmpty)
        let target = vm.currentModelPatchTarget()
        vm.selectModel("fixture/next")
        await vm.waitForPendingSessionSettings(for: target)
        #expect(vm.errorText == nil)
        let owner = try #require(vm.sidebarData)
        let sessions = owner.isQueryEnabled ? owner.rows : vm.sessions
        #expect(sessions.count == 1)
        #expect(sessions.first?.model == "next")
        #expect(sessions.first?.agentId == agentID)
        for hasHome in agentID == nil ? [false] : [false, true] {
            let rows = ChatSessionSidebarModel.sections(
                sessions: sessions, currentSessionKey: vm.sessionKey,
                mainSessionKey: vm.selectedAgentMainSessionKey, activeAgentID: owner.query.agentID,
                excludesMainSession: hasHome, query: "", sessionRoutingContract: vm.sessionRoutingContract,
                viewOptions: .init(selectedAgentID: vm.selectedAgentID))
                .flatMap(\.nodes).map(\.session)
            #expect(rows == (hasHome ? [] : sessions))
        }
    }

    private func modelReply() -> Data {
        Data(#"""
        {"ok":true,"key":"global","entry":{"model":"next","modelProvider":"fixture"}}
        """#.utf8)
    }

    @Test func `late model acknowledgement cannot update a different explicit global owner`() async throws {
        let suite = "ChatSessionSidebarQueryTests.ModelOwner.\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let transport = SidebarQueryTransport()
        let vm = OpenClawChatViewModel(
            sessionKey: "global", transport: transport, activeAgentId: "ops",
            sessionRoutingContract: "global|main|main", modelPickerStore: ChatModelPickerStore(defaults: defaults))
        defer { vm.detachTransport() }
        vm.enableSidebarData()
        let target = vm.currentModelPatchTarget()
        vm.selectModel("fixture/next")
        let pending = await transport.next("sessions.patch")
        #expect(pending.request.params["agentId"]?.value as? String == "ops")
        let owner = try #require(vm.sidebarData)
        let research = try JSONDecoder().decode(OpenClawChatSessionEntry.self, from: Data(#"""
        {"key":"global","agentId":"research","sessionId":"research","model":"current","modelProvider":"fixture"}
        """#.utf8))
        owner.receive([research], read: owner.beginRead(), replacingAgent: "research")
        vm.switchSession(to: "global", agentID: "research")
        #expect(vm.currentSessionSnapshot().deliveryAgentID == "research")
        #expect(vm.activeAgentId == "ops")
        pending.reply.resume(returning: self.modelReply())
        await vm.waitForPendingSessionSettings(for: target)
        #expect(owner.row(key: "global", agentID: "research")?.model == "current")
        #expect(owner.row(key: "global", agentID: "ops") == nil)
    }

    @Test func `model acknowledgement retains shared defaults without the sidebar opt in`() async throws {
        let suite = "ChatSessionSidebarQueryTests.LegacyModel.\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let transport = SidebarQueryTransport()
        await transport.replyAutomatically(with: self.modelReply())
        let vm = OpenClawChatViewModel(
            sessionKey: "global", transport: transport, activeAgentId: "ops",
            sessionRoutingContract: "global|main|main", modelPickerStore: ChatModelPickerStore(defaults: defaults))
        defer { vm.detachTransport() }
        let target = vm.currentModelPatchTarget()
        vm.selectModel("fixture/next")
        await vm.waitForPendingSessionSettings(for: target)
        #expect(vm.modelSelectionID == "fixture/next")
        #expect(vm.sessions.count == 1)
        #expect(vm.sessions.first?.agentId == nil)
    }

    @Test func `view model enables offline query projection and dispatches selected and all agent scopes`() async throws {
        let suite = "ChatSessionSidebarQueryTests.EntryPoint.\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let transport = SidebarQueryTransport()
        let vm = OpenClawChatViewModel(
            sessionKey: "agent:main:thread",
            transport: transport,
            activeAgentId: "main",
            modelPickerStore: ChatModelPickerStore(defaults: defaults))
        defer { vm.detachTransport() }
        vm.enableSidebarData()
        let owner = try #require(vm.sidebarData)
        #expect(owner.isQueryEnabled)
        #expect(owner.query.agentID == "main")
        let cached = try JSONDecoder().decode(
            OpenClawChatSessionsListResponse.self, from: self.page([self.row("thread", label: "Needle plan")]))
        owner.receive(cached.sessions, read: owner.beginRead(), replacingAgent: "main")
        vm.updateSidebarQuery(search: " needle ")
        #expect(owner.query.search == "needle")
        #expect(owner.rows.map(\.sessionId) == ["thread"])
        #expect(owner.queryTask == nil)
        #expect(await transport.requests.isEmpty)
        vm.updateSidebarQuery(showAutomation: true, showSystem: true)
        #expect(!owner.query.excludeCron && !owner.query.excludeSystem)
        let visibleSearch = OpenClawChatGatewayRequests.sidebarSessions(query: owner.query, limit: 10)
        #expect(visibleSearch.params["excludeCron"] == nil && visibleSearch.params["excludeSystem"] == nil)
        vm.updateSidebarQuery(search: "")
        vm.updateSidebarQuery(agentScope: .all)
        vm.healthOK = true
        await transport.replyAutomatically(with: self.page([]))
        for (scope, agentID, limit) in [
            (OpenClawChatSidebarAgentScope.selected, Optional("main"), 100), (.all, nil, 100),
        ] {
            vm.updateSidebarQuery(agentScope: scope)
            let task = try #require(owner.queryTask)
            await task.value
            let request = try #require(await transport.requests.last)
            #expect(request.params["agentId"]?.value as? String == agentID)
            #expect(request.params["limit"]?.value as? Int == limit)
        }
        #expect(await transport.requests.count == 2)
    }

    @Test(arguments: ["patch", "new", "reset"])
    func `session events publish an in flight page and coalesce one trailing refresh`(reason: String) async throws {
        let suite = "ChatSessionSidebarQueryTests.Events.\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let transport = SidebarQueryTransport()
        let vm = OpenClawChatViewModel(
            sessionKey: "agent:main:thread",
            transport: transport,
            activeAgentId: "main",
            modelPickerStore: ChatModelPickerStore(defaults: defaults))
        defer { vm.detachTransport() }
        vm.enableSidebarData()
        let owner = try #require(vm.sidebarData)
        var published: [[String?]] = []
        let onChange = owner.onChange
        owner.onChange = { [weak owner] in
            onChange?()
            published.append(owner?.rows.map(\.sessionId) ?? [])
        }
        vm.healthOK = true
        vm.refreshSidebarData()
        let firstTask = try #require(owner.queryTask)
        let firstRequest = await transport.next()
        await transport.replyAutomatically(with: self.page([self.row("second")]))
        for _ in 0..<10 {
            vm.handleSidebarEvent(.sessionsChanged(.init(
                sessionKey: "agent:main:thread", agentId: "main", reason: reason)))
        }
        firstRequest.reply.resume(returning: self.page([self.row("first")]))
        await firstTask.value
        await owner.queryTask?.value
        #expect(published.contains(["first"]))
        #expect(owner.rows.map(\.sessionId) == ["second"])
        #expect(await transport.requests.count == 2)
    }

    @Test func `selected pages deduplicate and refresh retains the window without committing edits`() async throws {
        let transport = SidebarQueryTransport()
        let owner = self.owner(transport)
        let first = (0..<100).map { self.row("row-\($0)") }
        let initial = await self.load(owner, transport, self.page(first, paging: #""hasMore":true,"nextOffset":100"#))
        #expect(initial.params["limit"]?.value as? Int == 100)
        let target = try #require(owner.rows.first)
        let intent = owner.beginMutation(target: target, field: .label) { $0.label = "Pending" }
        let append = await self.load(
            owner,
            transport,
            self.page([
                self.row("row-0", label: "Duplicate"), self.row("row-100"),
            ]),
            append: true)
        #expect(append.params["offset"]?.value as? Int == 100)
        #expect(append.params["limit"]?.value as? Int == 100)
        #expect(owner.rows.count == 101)
        owner.finishMutation(intent, receipt: nil)
        #expect(owner.row(key: target.key, agentID: "main")?.label == "Work")
        #expect(owner.nextOffset == nil)
        let refresh = await self.load(owner, transport, self.page([self.row("replacement")]))
        #expect(refresh.params["limit"]?.value as? Int == 100)
        #expect(refresh.params["offset"] == nil)
        #expect(owner.rows.map(\.sessionId) == ["replacement"])
    }

    #if os(macOS)
    @Test func `person cards include paged roster links and observe their canonical removal`() async throws {
        let suite = "ChatSessionSidebarQueryTests.People.\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let transport = SidebarQueryTransport()
        let vm = OpenClawChatViewModel(
            sessionKey: "agent:main:first",
            transport: transport,
            activeAgentId: "main",
            modelPickerStore: ChatModelPickerStore(defaults: defaults))
        defer { vm.detachTransport() }
        vm.enableSidebarData()
        let owner = try #require(vm.sidebarData)
        let first = self.page([self.row("first")], paging: #""hasMore":true,"nextOffset":200"#)
        let initial = try JSONDecoder().decode(OpenClawChatSessionsListResponse.self, from: first)
        owner.receive(initial.sessions, read: owner.beginRead(), replacingAgent: "main")
        _ = await self.load(owner, transport, first)
        let next = self.page([#"""
        {"key":"agent:main:paged","sessionId":"paged","updatedAt":20,
         "owner":{"actor":{"type":"human","identity":{"type":"profile","id":"alice"}}}}
        """#])
        _ = await self.load(owner, transport, next, append: true)
        #expect(vm.sessions.map(\.sessionId) == ["first"])
        let people = OpenClawChatSidebarPeople()
        try people.receive(JSONDecoder().decode(HelloOk.self, from: Data(#"""
        {"type":"hello-ok","protocol":4,"server":{"connId":"alice"},"features":{},
         "snapshot":{"presence":[{"connectionId":"alice","ts":1,
          "user":{"id":"alice","identity":{"type":"profile","id":"alice"}}}],
          "health":{},"stateVersion":{"presence":1,"health":1},"uptimeMs":0},"auth":{},"policy":{}}
        """#.utf8)))
        let person = try #require(people.people.first)
        let card = ChatSidebarPersonCard(
            person: person, people: people, viewModel: vm, focused: .constant(false), dismiss: {})
        #expect(people.cardSessions(for: person, sessions: card.sessionRows).recent.map(\.sessionId) == ["paged"])
        let paged = try #require(owner.row(key: "agent:main:paged", agentID: "main"))
        owner.remove(paged)
        #expect(people.cardSessions(for: person, sessions: card.sessionRows).recent.isEmpty)
    }
    #endif

    @Test func `append reconciles missing or null cursors while replacement null terminates`() async {
        let transport = SidebarQueryTransport()
        let owner = self.owner(transport)
        _ = await self.load(owner, transport, self.page([self.row("first")], paging: #""hasMore":true"#))
        #expect(owner.nextOffset == 1)
        let failedLoad = Task { await owner.load(append: true) }
        let failed = await transport.next()
        #expect(owner.isLoading)
        failed.reply.resume(throwing: NSError(
            domain: "SidebarFixture", code: 1, userInfo: [NSLocalizedDescriptionKey: "Roster unavailable"]))
        await failedLoad.value
        #expect(owner.rows.map(\.sessionId) == ["first"])
        #expect(owner.errorText == "Roster unavailable")
        #expect(!owner.isSettled)
        let retry = Task { await owner.retry() }
        let retried = await transport.next()
        #expect(retried.request.params == failed.request.params)
        #expect(retried.request.params["offset"]?.value as? Int == 1)
        retried.reply.resume(returning: self.page([self.row("second")], paging: #""hasMore":true,"nextOffset":null"#))
        await retry.value
        #expect(owner.rows.map(\.sessionId) == ["first", "second"])
        #expect(owner.errorText == nil)
        #expect(!owner.isLoading)
        #expect(owner.nextOffset == 2)
        await transport.replyAutomatically(with: self.page([]))
        await owner.load(append: true)
        #expect(await transport.requests.last?.params["offset"]?.value as? Int == 2)
        #expect(await transport.requests.count == 4)
        await transport.replyAutomatically(with: self.page([], paging: #""hasMore":true,"nextOffset":null"#))
        await owner.load()
        #expect(owner.nextOffset == nil)
        await owner.load(append: true)
        #expect(await transport.requests.count == 5)
    }

    @Test(arguments: [false, true])
    func `retired pages cannot replace a refresh or status query`(changeStatus: Bool) async {
        let transport = SidebarQueryTransport()
        let owner = self.owner(transport)
        _ = await self.load(
            owner,
            transport,
            self.page([self.row("first")], paging: #""hasMore":true,"nextOffset":20"#))
        let oldLoad = Task { await owner.load(append: true) }
        let old = await transport.next()
        if changeStatus {
            #expect(owner.setQuery(.init(agentID: "main", status: .all)))
        } else {
            owner.invalidateQuery()
            #expect(owner.rows.map(\.sessionId) == ["first"])
        }
        _ = await self.load(owner, transport, self.page([self.row("fresh")]))
        old.reply.resume(returning: self.page([self.row("stale")]))
        await oldLoad.value
        #expect(owner.rows.map(\.sessionId) == ["fresh"])
        #expect(!owner.isLoading)
        #expect(owner.row(key: "agent:main:stale", agentID: "main") == nil)
    }

    @Test func `all agents use three hundred rows with local status and owner qualified global identities`() async {
        let transport = SidebarQueryTransport()
        let owner = self.owner(transport, query: .init(agentID: nil))
        let pages = (0..<3).map { index in
            let global = #"""
            {"key":"global","agentId":"owner-\#(index)","sessionId":"global-\#(index)",\#
            "archived":true,"owner":{"actor":{"type":"human","id":"person-\#(index)"}}}
            """#
            let rows = [global] + (1..<100).map { self.row("page-\(index)-\($0)") }
            let cursor = index == 0 ? #", "nextOffset":null"# : ""
            return self.page(rows, paging: #""hasMore":true\#(cursor)"#)
        }
        await transport.replyAutomatically(with: self.page([]), after: pages)
        await owner.load()
        let requests = await transport.requests
        #expect(requests.count == 3)
        for (index, request) in requests.enumerated() {
            #expect(request.params["limit"]?.value as? Int == 100)
            #expect(request.params["offset"]?.value as? Int == (index == 0 ? nil : index * 100))
            #expect(request.params["archived"]?.value as? String == "all")
            #expect(request.params["agentId"] == nil)
        }
        #expect(owner.rows.count == 297)
        #expect(owner.nextOffset == nil)
        #expect(!owner.isSettled)
        #expect(!owner.setQuery(.init(agentID: nil, status: .all)))
        #expect(owner.rows.count == 300)
        #expect(!owner.setQuery(.init(agentID: nil, status: .archived)))
        #expect(owner.rows.map(\.sessionId) == ["global-0", "global-1", "global-2"])
        #expect(owner.row(key: "global", agentID: "owner-1")?.sessionId == "global-1")
        #expect(!owner.setQuery(.init(agentID: nil, status: .archived, ownerId: "person-1")))
        #expect(owner.rows.map(\.sessionId) == ["global-1"])
        await transport.replyAutomatically(with: self.page([]))
        await owner.load(append: true)
        #expect(await transport.requests.count == 3)
    }

    @Test(arguments: [false, true])
    func `all agent window stops on a final page or empty page and reports incomplete emptiness`(empty: Bool) async {
        let transport = SidebarQueryTransport()
        let owner = self.owner(transport, query: .init(agentID: nil))
        #expect(!owner.isSettled)
        await transport.replyAutomatically(with: self.page([]), after: [self.page(
            empty ? [] : [self.row("only")], paging: empty ? #""hasMore":true"# : #""hasMore":false"#)])
        await owner.load()
        #expect(await transport.requests.count == 1)
        #expect(owner.rows.isEmpty == empty)
        #expect(owner.isSettled == !empty)
    }

    @Test func `all agent window stays incomplete when its final page omits pagination metadata`() async {
        let transport = SidebarQueryTransport()
        let owner = self.owner(transport, query: .init(agentID: nil, status: .archived))
        await transport.replyAutomatically(with: self.page([]), after: [
            self.page([self.row("first")], paging: #""hasMore":true,"totalCount":400,"nextOffset":100"#),
            self.page([self.row("second")], paging: #""nextOffset":null"#),
        ])
        await owner.load()
        #expect(await transport.requests.count == 2)
        #expect(owner.rows.isEmpty)
        #expect(!owner.isSettled)
        #expect(!owner.setQuery(.init(agentID: nil, status: .all)))
        #expect(owner.rows.map(\.sessionId) == ["first", "second"])
    }

    @Test func `cold roster admission survives first query failure and stale search responses`() async throws {
        let transport = SidebarQueryTransport()
        let owner = self.owner(transport)
        let cached = try JSONDecoder().decode(
            OpenClawChatSessionsListResponse.self,
            from: self.page([self.row("local", label: "Old query")]))
        owner.receive(cached.sessions, read: owner.beginRead(), replacingAgent: "main")
        #expect(owner.rows.map(\.sessionId) == ["local"])
        let firstLoad = Task { await owner.load() }
        let failed = await transport.next()
        failed.reply.resume(throwing: NSError(
            domain: "SidebarFixture", code: 3, userInfo: [NSLocalizedDescriptionKey: "First roster unavailable"]))
        await firstLoad.value
        #expect(owner.rows.map(\.sessionId) == ["local"])
        #expect(owner.errorText == "First roster unavailable")
        #expect(!owner.isSettled)
        #expect(owner.setQuery(.init(agentID: "main", search: "old")))
        #expect(owner.rows.map(\.sessionId) == ["local"])
        let oldLoad = Task { await owner.load() }
        let oldList = await transport.next(), oldTranscript = await transport.next("sessions.search")
        owner.setQuery(.init(agentID: "main", search: "new"))
        let newLoad = Task { await owner.load() }
        let list = await transport.next(), transcript = await transport.next("sessions.search")
        #expect(list.request.params["limit"]?.value as? Int == 10)
        #expect(transcript.request.params["limit"]?.value as? Int == 25)
        oldList.reply.resume(returning: self.page(
            [self.row("old", label: "Old query")], paging: #""owners":[{"type":"human","id":"stale-owner"}]"#))
        oldTranscript.reply.resume(returning: Data(
            #"{"results":[],"sessions":[],"indexing":true,"archivedTranscriptsExcluded":3}"#.utf8))
        await oldLoad.value
        #expect(owner.isLoading)
        #expect(owner.rows.isEmpty)
        #expect(owner.owners == nil)
        list.reply.resume(returning: self.page([
            self.row("prefix", label: "New plans"), self.row("exact", label: " NEW "),
            self.row("server", label: "Opaque title"), self.row("substring", label: "A new topic"),
            self.row("recent", label: "Another new topic", updatedAt: 20),
        ], paging: #""owners":[{"type":"human","id":"current-owner"}]"#))
        transcript.reply.resume(returning: Data(#"""
        {"results":[
          {"sessionKey":"agent:main:server","sessionId":"server","messageId":"m1",
           "role":"user","timestamp":10,"snippet":"new","score":5},
          {"sessionKey":"agent:main:transcript","sessionId":"transcript","messageId":"m2",
           "role":"user","timestamp":10,"snippet":"new","score":100}
        ],"sessions":[\#(self.row("transcript", label: "Discussion")),\#(self.row("exact", label: "Duplicate"))]}
        """#.utf8))
        await newLoad.value
        #expect(owner.rows.map(\.sessionId) == ["exact", "prefix", "server", "recent", "substring", "transcript"])
        #expect(owner.rows.first?.label == " NEW ")
        #expect(owner.isSettled)
        #expect(!owner.searchIndexing)
        #expect(owner.archivedTranscriptsExcluded == 0)
        #expect(owner.owners?.map(\.id) == ["current-owner"])
        owner.setQuery(.init(agentID: "main", status: .archived, search: "new"))
        #expect(owner.owners == nil)
        await transport.replyAutomatically(with: Data(#"{"sessions":[],"results":[],"owners":[]}"#.utf8))
        await owner.load()
        #expect(owner.owners == [])
    }

    @Test func `hidden metadata matches cannot evict visible transcript results before the sidebar limit`() async {
        let transport = SidebarQueryTransport()
        let owner = self.owner(transport, query: .init(agentID: "main", search: "needle"))
        let task = Task { await owner.load() }
        let metadata = await transport.next(), transcript = await transport.next("sessions.search")
        let cron = (0..<4).map {
            #"{"key":"agent:main:cron:\#($0)","sessionId":"cron-\#($0)","label":"needle"}"#
        }
        let system = (0..<4).map {
            #"""
            {"key":"agent:main:system-\#($0)","sessionId":"system-\#($0)","label":"needle",\#
            "createdActor":{"type":"system","id":"internal"}}
            """#
        }
        metadata.reply.resume(returning: self.page(cron + system + [
            self.row("main", label: "needle"), self.row("onboarding", label: "needle"),
        ]))
        let rows = (0..<15).map { self.row("visible-\($0)", label: "Discussion", updatedAt: 30 - $0) }
        let hits = (0..<15).map {
            #"""
            {"sessionKey":"agent:main:visible-\#($0)","sessionId":"visible-\#($0)",\#
            "messageId":"m\#($0)","role":"user","timestamp":10,"snippet":"needle","score":\#($0)}
            """#
        }
        transcript.reply.resume(returning: Data(
            #"{"results":[\#(hits.joined(separator: ","))],"sessions":[\#(rows.joined(separator: ","))]}"#.utf8))
        await task.value
        let sections = ChatSessionSidebarModel.sections(
            sessions: owner.rows,
            currentSessionKey: "",
            mainSessionKey: "agent:main:main",
            activeAgentID: "main",
            excludesMainSession: true,
            query: "",
            rankedSearch: true,
            viewOptions: .init())
        #expect(sections.flatMap(\.nodes).map(\.session.sessionId) == (5..<15).reversed().map { "visible-\($0)" })
    }

    @Test func `authoritative search membership replaces the instant local pass`() async {
        let transport = SidebarQueryTransport()
        let owner = self.owner(transport)
        _ = await self.load(owner, transport, self.page([self.row("local", label: "Needle")]))
        owner.setQuery(.init(agentID: "main", search: "needle"))
        #expect(owner.rows.map(\.sessionId) == ["local"])
        let task = Task { await owner.load() }
        let metadata = await transport.next(), transcript = await transport.next("sessions.search")
        metadata.reply.resume(returning: self.page([]))
        transcript.reply.resume(returning: Data(#"{"results":[],"sessions":[]}"#.utf8))
        await task.value
        #expect(owner.rows.isEmpty)
        #expect(owner.isSettled)
    }

    @Test(arguments: ["physical-123", "legacy heading"])
    func `instant offline search retains canonical session ID and display name matching`(query: String) throws {
        let owner = self.owner(SidebarQueryTransport())
        let row = try JSONDecoder().decode(OpenClawChatSessionEntry.self, from: Data(#"""
        {"key":"agent:main:thread","sessionId":"physical-123","label":"New label","displayName":"Legacy heading"}
        """#.utf8))
        owner.receive([row], read: owner.beginRead(), replacingAgent: "main")
        owner.setQuery(.init(agentID: "main", search: query))
        #expect(owner.rows.map(\.sessionId) == ["physical-123"])
    }

    @Test func `locally ranked query reuses its projection until query or row facts change`() async throws {
        let transport = SidebarQueryTransport()
        let owner = self.owner(transport)
        _ = await self.load(owner, transport, self.page([self.row("local", label: "Work plan")]))
        owner.setQuery(.init(agentID: "main", search: "work"))
        var computed = 0
        owner.onProjectionComputed = { if $0 == .sidebar { computed += 1 } }
        for _ in 0..<5 {
            #expect(owner.rows.map(\.sessionId) == ["local"])
        }
        #expect(computed == 1)
        let target = try #require(owner.rows.first)
        let intent = owner.beginMutation(target: target, field: .label) { $0.label = "Other" }
        for _ in 0..<5 {
            #expect(owner.rows.isEmpty)
        }
        #expect(computed == 2)
        owner.finishMutation(intent, receipt: nil)
        #expect(owner.rows.map(\.sessionId) == ["local"])
        #expect(computed == 3)
        owner.setQuery(.init(agentID: "main", search: "missing"))
        #expect(owner.rows.isEmpty)
        #expect(computed == 4)
    }

    @Test func `search minimum uses UTF16 and keeps single character queries local`() async {
        let transport = SidebarQueryTransport()
        let owner = self.owner(transport)
        _ = await self.load(owner, transport, self.page([self.row("local", label: "x marks the spot")]))
        owner.setQuery(.init(agentID: "main", search: " x "))
        await transport.replyAutomatically(with: Data(#"{"sessions":[],"results":[]}"#.utf8))
        await owner.load()
        #expect(owner.rows.map(\.sessionId) == ["local"])
        #expect(await transport.requests.count == 1)
        owner.setQuery(.init(agentID: "main", search: "🦞"))
        await owner.load()
        #expect(await transport.requests.map(\.method).sorted() == [
            "sessions.list",
            "sessions.list",
            "sessions.search",
        ])
        #expect(owner.rows.isEmpty)
        #expect(owner.isSettled)
    }

    @Test func `all agent transcript ranking does not collapse bare global keys`() async {
        let transport = SidebarQueryTransport()
        let owner = self.owner(transport, query: .init(agentID: nil, search: "needle"))
        let task = Task { await owner.load() }
        let list = await transport.next(), transcript = await transport.next("sessions.search")
        list.reply.resume(returning: self.page([
            #"{"key":"global","agentId":"alpha","sessionId":"alpha","label":"Alpha metadata"}"#,
            #"{"key":"global","agentId":"beta","sessionId":"beta","label":"Beta metadata"}"#,
        ]))
        transcript.reply.resume(returning: Data(#"""
        {"results":[
          {"sessionKey":"global","sessionId":"alpha","messageId":"a","role":"user",\#
        "timestamp":10,"snippet":"needle","score":10},
          {"sessionKey":"global","sessionId":"beta","messageId":"b","role":"user",\#
        "timestamp":10,"snippet":"needle","score":20},
          {"sessionKey":"global","sessionId":"gamma","messageId":"c","role":"user",\#
        "timestamp":10,"snippet":"needle","score":100}
        ],"sessions":[
          {"key":"global","agentId":"gamma","sessionId":"gamma","label":"Gamma transcript"},
          {"key":"global","agentId":"alpha","sessionId":"alpha","label":"Duplicate"}
        ]}
        """#.utf8))
        await task.value
        #expect(owner.rows.map(\.agentId) == ["beta", "alpha", "gamma"])
        #expect(owner.rows.map(\.label) == ["Beta metadata", "Alpha metadata", "Gamma transcript"])
    }

    @Test func `transcript failure retains metadata and retry clears the partial error`() async {
        let transport = SidebarQueryTransport()
        let owner = self.owner(transport, query: .init(agentID: "main", search: "work"))
        let task = Task { await owner.load() }
        let list = await transport.next(), transcript = await transport.next("sessions.search")
        list.reply.resume(returning: self.page([self.row("metadata")]))
        transcript.reply.resume(throwing: NSError(
            domain: "SidebarFixture", code: 2, userInfo: [NSLocalizedDescriptionKey: "Transcript search unavailable"]))
        await task.value
        #expect(owner.rows.map(\.sessionId) == ["metadata"])
        #expect(owner.errorText == "Transcript search unavailable")
        #expect(!owner.isLoading)
        #expect(!owner.isSettled)
        owner.invalidate()
        #expect(owner.rows.map(\.sessionId) == ["metadata"])
        await transport.replyAutomatically(with: Data(#"{"sessions":[],"results":[]}"#.utf8))
        await owner.retry()
        #expect(owner.errorText == nil)
        #expect(owner.rows.isEmpty)
        #expect(owner.isSettled)
    }

    @Test(arguments: [#""indexing":true"#, #""archivedTranscriptsExcluded":3"#])
    func `partial corpus notices prevent settled empty and retire with the query`(notice: String) async {
        let transport = SidebarQueryTransport()
        let owner = self.owner(transport, query: .init(agentID: "main", search: "absent"))
        #expect(!owner.isSettled)
        let task = Task { await owner.load() }
        let list = await transport.next(), transcript = await transport.next("sessions.search")
        list.reply.resume(returning: self.page([]))
        transcript.reply.resume(returning: Data(#"{"results":[],"sessions":[],\#(notice)}"#.utf8))
        await task.value
        #expect(owner.rows.isEmpty)
        #expect(!owner.isSettled)
        #expect(owner.searchIndexing == notice.contains("indexing"))
        #expect(owner.archivedTranscriptsExcluded == (notice.contains("archivedTranscriptsExcluded") ? 3 : 0))
        owner.setQuery(.init(agentID: "main", search: "other"))
        #expect(!owner.searchIndexing)
        #expect(owner.archivedTranscriptsExcluded == 0)
        #expect(!owner.isSettled)
        await transport.replyAutomatically(with: Data(#"{"sessions":[],"results":[]}"#.utf8))
        await owner.load()
        #expect(owner.isSettled)
    }

    @Test func `delayed search projects pending settings and observer facts and retains membership`() async throws {
        let transport = SidebarQueryTransport()
        let owner = self.owner(transport)
        let original = #"""
        {"key":"agent:main:thread","agentId":"main","sessionId":"thread","label":"Work original",
         "model":"fixture-before","thinkingLevel":"off","updatedAt":10,"hasActiveRun":true,
         "activeRunIds":["run"],"observerDigest":{"runId":"run","revision":1,"updatedAt":10,\#
        "headline":"Working","health":"on-track"}}
        """#
        let seed = try JSONDecoder().decode(OpenClawChatSessionsListResponse.self, from: self.page([original])).sessions
        owner.receive(seed, read: owner.beginRead(), replacingAgent: "main")
        _ = await self.load(owner, transport, self.page([original]))
        let target = try #require(owner.rows.first)
        let intent = owner.beginMutation(target: target, field: .label) { $0.label = "Work pending" }
        owner.setQuery(.init(agentID: "main", search: "work"))
        let task = Task { await owner.load() }
        let list = await transport.next(), transcript = await transport.next("sessions.search")
        var edited = owner.conversationRows(agentID: "main")
        edited[0].model = "fixture-after"
        edited[0].thinkingLevel = "high"
        owner.replaceConversationRows(edited, agentID: "main")
        let digest = try JSONDecoder().decode(SessionObserverDigest.self, from: Data(#"""
        {"sessionKey":"agent:main:thread","agentId":"main","sessionId":"thread","runId":"run",
         "revision":2,"updatedAt":20,"headline":"Needs input","health":"waiting-on-user"}
        """#.utf8))
        owner.applyObserver(digest)
        list.reply.resume(returning: self.page([original, self.row("remote")]))
        transcript.reply.resume(returning: Data(#"{"results":[],"sessions":[]}"#.utf8))
        await task.value
        let visible = try #require(owner.rows.first(where: { $0.sessionId == "thread" }))
        #expect(visible.label == "Work pending")
        #expect(visible.model == "fixture-after")
        #expect(visible.thinkingLevel == "high")
        #expect(visible.observerDigest?.health == "waiting-on-user")
        #expect(owner.conversationRows(agentID: "main").map(\.sessionId) == ["thread"])
        owner.finishMutation(intent, receipt: nil)
        #expect(owner.rows.first(where: { $0.sessionId == "thread" })?.label == "Work original")
    }

    @Test func `enriched query absence clears previews and titles while ordinary reads preserve them`() async throws {
        let transport = SidebarQueryTransport()
        let owner = self.owner(transport)
        _ = await self.load(owner, transport, self.page([#"""
        {"key":"agent:main:thread","sessionId":"thread","derivedTitle":"Derived before",
         "lastMessagePreview":"Preview before","updatedAt":10}
        """#]))
        let absent = self.page([#"{"key":"agent:main:thread","sessionId":"thread","label":"Renamed","updatedAt":20}"#])
        let legacy = try JSONDecoder().decode(OpenClawChatSessionsListResponse.self, from: absent)
        owner.receive(legacy.sessions, read: owner.beginRead())
        #expect(owner.rows.first?.derivedTitle == "Derived before")
        #expect(owner.rows.first?.lastMessagePreview == "Preview before")
        _ = await self.load(owner, transport, absent)
        #expect(owner.rows.first?.label == "Renamed")
        #expect(owner.rows.first?.derivedTitle == nil)
        #expect(owner.rows.first?.lastMessagePreview == nil)
    }
}
