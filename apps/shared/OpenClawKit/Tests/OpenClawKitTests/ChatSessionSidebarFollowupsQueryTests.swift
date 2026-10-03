import Foundation
import OpenClawProtocol
import Testing
@testable import OpenClawChatUI

extension ChatSessionSidebarQueryTests {
    #if os(macOS)
    @Test func `unrelated batch activity does not swallow a single archive`() async throws {
        let suite = "ChatSessionSidebarQueryTests.ArchiveConcurrency.\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let transport = SidebarQueryTransport()
        let vm = OpenClawChatViewModel(
            sessionKey: "agent:main:main",
            transport: transport,
            activeAgentId: "main",
            modelPickerStore: ChatModelPickerStore(defaults: defaults))
        defer { vm.detachTransport() }
        vm.enableSidebarData()
        let row = try JSONDecoder().decode(OpenClawChatSessionEntry.self, from: Data(self.row("target").utf8))
        let batch = ChatSessionSidebarBatch()
        batch.running = true
        var calls = 0
        let connection = try ChatSessionSidebarArchiveUndoTests().connection { _ in
            calls += 1
            return Data(
                #"{"ok":true,"key":"agent:main:target","entry":{"sessionId":"target","archivedAt":20,"updatedAt":20}}"#
                    .utf8)
        }
        let sidebar = ChatSessionSidebar(
            viewModel: vm,
            query: .constant(""),
            groups: .constant([]),
            previews: .init(),
            menuActions: .init(connection: connection),
            batch: batch)
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
            sessionKey: "agent:main:target",
            transport: transport,
            activeAgentId: "main",
            modelPickerStore: ChatModelPickerStore(defaults: defaults))
        defer { vm.detachTransport() }
        vm.enableSidebarData()
        vm.healthOK = true
        let owner = try #require(vm.sidebarData)
        let row = try JSONDecoder().decode(OpenClawChatSessionEntry.self, from: Data(self.row("target").utf8))
        owner.receive([row], read: owner.beginRead(), replacingAgent: "main")
        let batch = ChatSessionSidebarBatch()
        var completion: CheckedContinuation<Void, Never>?
        let connection = try ChatSessionSidebarArchiveUndoTests().connection { _ in
            if replace {
                var replacement = row
                replacement.sessionId = "replacement"
                replacement.updatedAt = 40
                owner.receive([replacement], read: owner.beginRead(), replacingAgent: "main")
            }
            defer { completion?.resume() }
            return batchAction ? Data(#"{"outcomes":[{"key":"agent:main:target","ok":true}]}"#.utf8) :
                Data(#"""
                {"ok":true,"key":"agent:main:target",
                 "entry":{"sessionId":"target","archivedAt":20,"updatedAt":20}}
                """#.utf8)
        }
        await transport.replyAutomatically(with: self.page([]))
        let sidebar = ChatSessionSidebar(
            viewModel: vm,
            query: .constant(""),
            groups: .constant([]),
            previews: .init(),
            menuActions: .init(connection: connection),
            batch: batch)
        await withCheckedContinuation { completion = $0
            if batchAction {
                sidebar.runSidebarBatch(.archived(true), rows: [row])
            } else {
                Task { await sidebar.archiveSidebarSession(row) }
            }
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
            sessionKey: "agent:main:main",
            transport: transport,
            activeAgentId: "main",
            modelPickerStore: ChatModelPickerStore(defaults: defaults))
        defer { vm.detachTransport() }
        vm.enableSidebarData()
        vm.healthOK = true
        let owner = try #require(vm.sidebarData)
        let row = try JSONDecoder().decode(OpenClawChatSessionEntry.self, from: Data(self.row("target").utf8))
        owner.receive([row], read: owner.beginRead(), replacingAgent: "main")
        let batch = ChatSessionSidebarBatch()
        var completion: CheckedContinuation<Void, Never>?
        let connection = try ChatSessionSidebarArchiveUndoTests().connection { _ in
            if changeQuery {
                owner.setQuery(.init(agentID: "research"))
                batch.reset(clearConnection: false)
            }
            defer { completion?.resume() }
            return batchAction ? Data(#"{"outcomes":[{"key":"agent:main:target","ok":true}]}"#.utf8) :
                Data(#"""
                {"ok":true,"key":"agent:main:target",
                 "entry":{"sessionId":"target","archivedAt":20,"updatedAt":20}}
                """#.utf8)
        }
        await transport.replyAutomatically(with: self.page([]))
        let sidebar = ChatSessionSidebar(
            viewModel: vm,
            query: .constant(""),
            groups: .constant([]),
            previews: .init(),
            menuActions: .init(connection: connection),
            batch: batch)
        await withCheckedContinuation { completion = $0
            if batchAction {
                sidebar.runSidebarBatch(.archived(true), rows: [row])
            } else {
                Task { await sidebar.archiveSidebarSession(row) }
            }
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
            sessionKey: "agent:main:main",
            transport: transport,
            activeAgentId: "main",
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
        let connection = try ChatSessionSidebarArchiveUndoTests().connection { _ in
            vm.switchSession(to: row.key, agentID: row.agentId)
            vm.updateSidebarQuery(agentScope: .selected)
            batch.reset(clearConnection: false)
            defer { completion?.resume() }
            return Data(#"{"outcomes":[{"key":"agent:research:target","ok":true}]}"#.utf8)
        }
        await transport.replyAutomatically(with: self.page([]))
        vm.healthOK = true
        let sidebar = ChatSessionSidebar(
            viewModel: vm,
            query: .constant(""),
            groups: .constant([]),
            previews: .init(),
            menuActions: .init(connection: connection),
            batch: batch)
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
            sessionKey: "agent:main:main",
            transport: transport,
            activeAgentId: "main",
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
            viewModel: vm,
            query: .constant(""),
            groups: .constant([]),
            previews: .init(),
            menuActions: .init(connection: connection),
            batch: batch)
        var newer: ChatSidebarArchiveReceipt?
        await withCheckedContinuation { completion = $0
            sidebar.undoSidebarArchive(clicked)
            newer = batch.offerArchiveUndo([second], connection: connection)
        }
        #expect(restored == [first.key])
        #expect(batch.archiveUndo?.id == newer?.id)
    }
    #endif

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
            sessionKey: key,
            transport: transport,
            activeAgentId: agentID,
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
                sessions: sessions,
                currentSessionKey: vm.sessionKey,
                mainSessionKey: vm.selectedAgentMainSessionKey,
                activeAgentID: owner.query.agentID,
                excludesMainSession: hasHome,
                query: "",
                sessionRoutingContract: vm.sessionRoutingContract,
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
            sessionKey: "global",
            transport: transport,
            activeAgentId: "ops",
            sessionRoutingContract: "global|main|main",
            modelPickerStore: ChatModelPickerStore(defaults: defaults))
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
            sessionKey: "global",
            transport: transport,
            activeAgentId: "ops",
            sessionRoutingContract: "global|main|main",
            modelPickerStore: ChatModelPickerStore(defaults: defaults))
        defer { vm.detachTransport() }
        let target = vm.currentModelPatchTarget()
        vm.selectModel("fixture/next")
        await vm.waitForPendingSessionSettings(for: target)
        #expect(vm.modelSelectionID == "fixture/next")
        #expect(vm.sessions.count == 1)
        #expect(vm.sessions.first?.agentId == nil)
    }

    #if os(macOS)
    @Test(arguments: [false, true])
    func `person cards include paged roster links and observe their canonical removal`(searching: Bool) async throws {
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
        if searching { owner.setQuery(.init(agentID: "main", search: "no-match")) }
        #expect(people.cardSessions(for: person, sessions: card.sessionRows).recent.map(\.sessionId) == ["paged"])
        let paged = try #require(owner.row(key: "agent:main:paged", agentID: "main"))
        owner.remove(paged)
        #expect(people.cardSessions(for: person, sessions: card.sessionRows).recent.isEmpty)
    }
    #endif
}
