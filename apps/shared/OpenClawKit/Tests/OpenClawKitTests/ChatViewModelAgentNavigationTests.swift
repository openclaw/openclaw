import Foundation
import Testing
@testable import OpenClawChatUI

private actor AgentNavigationGate {
    private var continuation: CheckedContinuation<Void, Never>?
    private var released = false

    func wait() async {
        guard !self.released else { return }
        await withCheckedContinuation { self.continuation = $0 }
    }

    func release() {
        self.released = true
        self.continuation?.resume()
        self.continuation = nil
    }
}

private actor AgentNavigationTransport: OpenClawChatTransport {
    enum Failure: Error { case offline }

    let catalogs: [Result<OpenClawChatAgentsListResponse?, Failure>]
    let catalogGate: AgentNavigationGate?
    let sendGate: AgentNavigationGate?
    let supportsAgentScopes: Bool
    let firstAbortGate: AgentNavigationGate?
    private(set) var catalogRequests = 0
    private(set) var sentKeys: [String] = []
    private(set) var createdKeys: [String] = []
    private(set) var listedAgentIDs: [String?] = []
    private(set) var historyTargets: [OpenClawChatSessionTarget] = []
    private(set) var subscriptionTargets: [OpenClawChatSessionTarget] = []
    private(set) var sentTargets: [OpenClawChatSessionTarget] = []
    private(set) var mutationRequests: [OpenClawChatGatewayRequest] = []
    private(set) var abortTargets: [OpenClawChatSessionTarget] = []
    private(set) var fullMessageTargets: [OpenClawChatSessionTarget] = []
    private var sessionsByAgentID: [String: [OpenClawChatSessionEntry]]

    init(
        catalogs: [Result<OpenClawChatAgentsListResponse?, Failure>],
        catalogGate: AgentNavigationGate? = nil,
        sendGate: AgentNavigationGate? = nil,
        supportsAgentScopes: Bool = true,
        firstAbortGate: AgentNavigationGate? = nil,
        sessionsByAgentID: [String: [OpenClawChatSessionEntry]] = [:])
    {
        self.catalogs = catalogs
        self.catalogGate = catalogGate
        self.sendGate = sendGate
        self.supportsAgentScopes = supportsAgentScopes
        self.firstAbortGate = firstAbortGate
        self.sessionsByAgentID = sessionsByAgentID
    }

    nonisolated func scoped(toAgentID agentID: String) -> (any OpenClawChatTransport)? {
        self.supportsAgentScopes ? AgentScopedNavigationTransport(base: self, agentID: agentID) : nil
    }

    func recordHistory(_ target: OpenClawChatSessionTarget) -> OpenClawChatHistoryPayload {
        self.historyTargets.append(target)
        return OpenClawChatHistoryPayload(
            sessionKey: target.sessionKey,
            sessionId: nil,
            messages: [],
            thinkingLevel: "off")
    }

    func recordSubscription(_ target: OpenClawChatSessionTarget) {
        self.subscriptionTargets.append(target)
    }

    func recordSend(_ target: OpenClawChatSessionTarget) {
        self.sentTargets.append(target)
    }

    func recordAbort(_ target: OpenClawChatSessionTarget) async {
        self.abortTargets.append(target)
        if self.abortTargets.count == 1 { await self.firstAbortGate?.wait() }
    }

    func recordFullMessage(_ target: OpenClawChatSessionTarget) {
        self.fullMessageTargets.append(target)
    }

    func requestFullMessage(sessionKey: String, messageID _: String) async throws -> OpenClawChatMessage? {
        self.recordFullMessage(.init(sessionKey: sessionKey, agentID: nil))
        return nil
    }

    func recordMutation(_ request: OpenClawChatGatewayRequest) -> Data {
        self.mutationRequests.append(request)
        if let owner = request.params["agentId"]?.value as? String,
           let key = request.params["key"]?.value as? String,
           let unread = request.params["unread"]?.value as? Bool,
           let index = self.sessionsByAgentID[owner]?.firstIndex(where: { $0.key == key })
        {
            self.sessionsByAgentID[owner]?[index].unread = unread
        }
        return Data("{}".utf8)
    }

    func acquireSessionMutationRouteLease() async -> OpenClawChatSessionMutationRouteLease? {
        OpenClawChatSessionMutationRouteLease(
            sessionTarget: { .resolve($0, selectedAgentID: "main", policy: .preserveBareKeys) },
            unreadAckContract: true,
            request: { await self.recordMutation($0) })
    }

    func listAgents() async throws -> OpenClawChatAgentsListResponse? {
        let index = self.catalogRequests
        self.catalogRequests += 1
        let result = self.catalogs[min(index, self.catalogs.count - 1)]
        if index == 0 { await self.catalogGate?.wait() }
        return try result.get()
    }

    func requestHistory(sessionKey: String) async throws -> OpenClawChatHistoryPayload {
        OpenClawChatHistoryPayload(sessionKey: sessionKey, sessionId: nil, messages: [], thinkingLevel: "off")
    }

    func listSessions(
        limit _: Int?,
        search _: String?,
        archived _: Bool,
        agentID: String?) async throws -> OpenClawChatSessionsListResponse
    {
        self.listedAgentIDs.append(agentID)
        let sessions = self.sessionsByAgentID[agentID ?? "main"] ?? []
        return OpenClawChatSessionsListResponse(
            ts: nil, path: nil, count: sessions.count, defaults: nil, sessions: sessions)
    }

    func sendMessage(
        sessionKey: String,
        message _: String,
        thinking _: String,
        idempotencyKey: String,
        attachments _: [OpenClawChatAttachmentPayload]) async throws -> OpenClawChatSendResponse
    {
        self.sentKeys.append(sessionKey)
        await self.sendGate?.wait()
        return OpenClawChatSendResponse(runId: idempotencyKey, status: "ok")
    }

    func createSession(
        key: String,
        label _: String?,
        parentSessionKey _: String?,
        worktree _: Bool?) async throws -> OpenClawChatCreateSessionResponse
    {
        self.createdKeys.append(key)
        return OpenClawChatCreateSessionResponse(ok: true, key: key, sessionId: nil)
    }

    func requestHealth(timeoutMs _: Int) async throws -> Bool {
        true
    }

    func deleteSession(key _: String) async throws {}

    nonisolated func events() -> AsyncStream<OpenClawChatTransportEvent> {
        AsyncStream { $0.finish() }
    }
}

private struct AgentScopedNavigationTransport: OpenClawChatTransport {
    let base: AgentNavigationTransport
    let agentID: String

    func scoped(toAgentID agentID: String) -> (any OpenClawChatTransport)? {
        self.base.scoped(toAgentID: agentID)
    }

    func requestFullMessage(sessionKey: String, messageID _: String) async throws -> OpenClawChatMessage? {
        await self.base.recordFullMessage(.init(sessionKey: sessionKey, agentID: self.agentID))
        return nil
    }

    func requestHistory(sessionKey: String) async throws -> OpenClawChatHistoryPayload {
        await self.base.recordHistory(.init(sessionKey: sessionKey, agentID: self.agentID))
    }

    func listSessions(
        limit: Int?, search: String?, archived: Bool, agentID: String?) async throws -> OpenClawChatSessionsListResponse
    {
        try await self.base.listSessions(
            limit: limit, search: search, archived: archived, agentID: agentID ?? self.agentID)
    }

    func acquireSessionMutationRouteLease() async -> OpenClawChatSessionMutationRouteLease? {
        await self.base.acquireSessionMutationRouteLease()
    }

    func setActiveSessionKey(_ sessionKey: String) async throws {
        await self.base.recordSubscription(.init(sessionKey: sessionKey, agentID: self.agentID))
    }

    func abortRun(sessionKey: String, runId _: String) async throws {
        await self.base.recordAbort(.init(sessionKey: sessionKey, agentID: self.agentID))
    }

    func sendMessage(
        sessionKey: String,
        message: String,
        thinking: String,
        idempotencyKey: String,
        attachments: [OpenClawChatAttachmentPayload]) async throws -> OpenClawChatSendResponse
    {
        await self.base.recordSend(.init(sessionKey: sessionKey, agentID: self.agentID))
        return try await self.base.sendMessage(
            sessionKey: sessionKey, message: message, thinking: thinking,
            idempotencyKey: idempotencyKey, attachments: attachments)
    }

    func requestHealth(timeoutMs _: Int) async throws -> Bool {
        true
    }

    func events() -> AsyncStream<OpenClawChatTransportEvent> {
        self.base.events()
    }
}

@MainActor
private final class AgentNavigationFixture {
    let suite = "OpenClawAgentNavigationTests.\(UUID().uuidString)"
    let defaults: UserDefaults
    let viewModel: OpenClawChatViewModel

    init(
        transport: AgentNavigationTransport,
        sessionKey: String = "main",
        routingContract: String = "per-agent|main|main")
    {
        self.defaults = UserDefaults(suiteName: self.suite)!
        self.viewModel = OpenClawChatViewModel(
            sessionKey: sessionKey,
            transport: transport,
            activeAgentId: "main",
            sessionRoutingContract: routingContract,
            modelPickerStore: ChatModelPickerStore(defaults: self.defaults))
    }

    func close() {
        self.viewModel.detachTransport()
        self.defaults.removePersistentDomain(forName: self.suite)
    }
}

@MainActor
struct ChatViewModelAgentNavigationTests {
    private func globalSession(owner: String) -> OpenClawChatSessionEntry {
        var entry = OpenClawChatSessionEntry.placeholder(key: "global")
        entry.agentId = owner
        entry.label = "\(owner) notes"
        entry.pinned = true
        entry.unread = true
        entry.markedUnreadAt = 10
        return entry
    }

    private func catalog(contract: String = "per-agent|main|main") -> OpenClawChatAgentsListResponse {
        OpenClawChatAgentsListResponse(
            defaultId: "main",
            agents: [.init(id: "main", name: "Assistant"), .init(id: "research", name: "Research")],
            sessionRoutingContract: contract)
    }

    @Test func `sequential global activations acknowledge their owners and preserve manual unread marks`() async throws {
        let contract = "global|inbox|main"
        let transport = AgentNavigationTransport(
            catalogs: [.success(self.catalog(contract: contract))],
            sessionsByAgentID: [
                "research": [self.globalSession(owner: "research")],
                "main": [self.globalSession(owner: "main")],
            ])
        let fixture = AgentNavigationFixture(
            transport: transport, sessionKey: "agent:research:inbox", routingContract: contract)
        defer { fixture.close() }
        let vm = fixture.viewModel
        vm.load()
        try await waitUntil("Research activation acknowledged") {
            let requestCount = await transport.mutationRequests.count
            return await MainActor.run { requestCount == 1 && !vm.isLoading }
        }
        vm.setSessionUnread(key: "global", unread: true, agentID: "research")
        try await waitUntil("Research manual unread mark accepted") { await transport.mutationRequests.count == 2 }
        vm.refresh()
        try await waitUntil("Research refresh settled") { await MainActor.run { !vm.isLoading } }
        #expect(await transport.mutationRequests.count == 2)
        #expect(vm.currentSessionEntry()?.unread == true)

        vm.switchSession(to: "global", agentID: "main")
        try await waitUntil("Main activation acknowledged") { await transport.mutationRequests.count == 3 }
        let acknowledgements = await transport.mutationRequests.filter { $0.params["unread"]?.value as? Bool == false }
        #expect(acknowledgements.map { $0.params["agentId"]?.value as? String } == ["research", "main"])
        #expect(acknowledgements.allSatisfy { $0.params["key"]?.value as? String == "global" })
        let research = try await transport.listSessions(limit: nil, search: nil, archived: false, agentID: "research")
        #expect(research.sessions.first?.unread == true)
    }

    @Test(arguments: [false, true])
    func `primary navigation selects its named global row without a placeholder`(hasHomeRow: Bool) async throws {
        let contract = "global|inbox|main"
        let transport = AgentNavigationTransport(
            catalogs: [.success(self.catalog(contract: contract))],
            sessionsByAgentID: ["research": [self.globalSession(owner: "research")]])
        let fixture = AgentNavigationFixture(
            transport: transport, sessionKey: "agent:research:inbox", routingContract: contract)
        defer { fixture.close() }
        let vm = fixture.viewModel
        vm.load()
        try await waitUntil("canonical global row loaded") { await MainActor.run { !vm.isLoading } }
        let sections = ChatSessionSidebarModel.sections(
            sessions: vm.sessions, currentSessionKey: vm.sessionKey,
            mainSessionKey: vm.selectedAgentMainSessionKey, activeAgentID: vm.selectedAgentID,
            excludesMainSession: hasHomeRow, query: "", sessionRoutingContract: contract)
        let rows = sections.flatMap(\.nodes).map(\.session)
        #expect(rows.map(\.key) == (hasHomeRow ? [] : ["global"]))
        if !hasHomeRow {
            #expect(rows.first?.label == "research notes")
            #expect(sections.first?.id == "pinned")
        }
        #expect(ChatSessionSidebarModel.selectedSessionKey(
            sessions: vm.sessions, currentSessionKey: vm.sessionKey,
            mainSessionKey: vm.selectedAgentMainSessionKey, activeAgentID: vm.selectedAgentID,
            sessionRoutingContract: contract) == "global")
    }

    @Test(arguments: ["per-sender|inbox|main", "global|inbox|main"])
    func `bare global selection preserves its owner and distinct drafts after default changes`(
        contract: String) async throws
    {
        let transport = AgentNavigationTransport(catalogs: [.success(self.catalog(contract: contract))])
        let fixture = AgentNavigationFixture(transport: transport, routingContract: contract)
        defer { fixture.close() }
        let vm = fixture.viewModel
        vm.switchSession(to: "global", agentID: "research")
        let research = OpenClawChatSessionTarget(sessionKey: "global", agentID: "research")
        try await waitUntil("research history subscribed") { await transport.historyTargets.contains(research) }
        #expect(await transport.subscriptionTargets.contains(research))
        vm.syncActiveAgentId("replacement-default")
        #expect(vm.selectedAgentID == "research")
        #expect(vm.currentSessionTarget == research)
        vm.input = "Send to Research"
        vm.send()
        try await waitUntil("research send") { await transport.sentTargets == [research] }
        try await waitUntil("research send settles") { await MainActor.run { !vm.isSending } }
        vm.input = "research draft"

        vm.switchSession(to: "global", agentID: "main")
        let main = OpenClawChatSessionTarget(sessionKey: "global", agentID: "main")
        try await waitUntil("same-key main history subscribed") { await transport.historyTargets.contains(main) }
        #expect(vm.input.isEmpty)
        vm.input = "main draft"
        vm.switchSession(to: "agent:research:global")
        #expect(vm.input.isEmpty)
        vm.input = "ordinary qualified global draft"
        vm.switchSession(to: "global", agentID: "research")
        #expect(vm.input == "research draft")
        vm.switchSession(to: "agent:research:global")
        #expect(vm.input == "ordinary qualified global draft")
    }

    @Test(arguments: ["main", "research"])
    func `unsupported scoped transports reject every explicit bare conversation owner`(agentID: String) {
        let transport = AgentNavigationTransport(catalogs: [.success(self.catalog())], supportsAgentScopes: false)
        let fixture = AgentNavigationFixture(transport: transport)
        defer { fixture.close() }
        fixture.viewModel.switchSession(to: "global", agentID: agentID)
        #expect(fixture.viewModel.sessionKey == "main")
        #expect(fixture.viewModel.errorText != nil)
    }

    @Test func `full message expansion retains the owner captured before navigation`() async throws {
        let transport = AgentNavigationTransport(catalogs: [.success(self.catalog())])
        let fixture = AgentNavigationFixture(transport: transport)
        defer { fixture.close() }
        let vm = fixture.viewModel
        vm.switchSession(to: "global", agentID: "research")
        let request = ChatFullMessageReaderRequest(
            viewModel: vm, messageID: "message-one")
        vm.switchSession(to: "global", agentID: "main")
        _ = try await request.load()
        #expect(await transport.fullMessageTargets == [.init(sessionKey: "global", agentID: "research")])
    }

    @Test func `ambient custom transports keep their full message reader without scoped support`() async throws {
        let transport = AgentNavigationTransport(catalogs: [.success(self.catalog())], supportsAgentScopes: false)
        let fixture = AgentNavigationFixture(transport: transport)
        defer { fixture.close() }
        let request = ChatFullMessageReaderRequest(viewModel: fixture.viewModel, messageID: "message-one")
        _ = try await request.load()
        #expect(await transport.fullMessageTargets == [.init(sessionKey: "main", agentID: nil)])
    }

    @Test(arguments: ["global|inbox|main", "per-sender|inbox|main"])
    func `qualified main aliases share drafts while ordinary global remains separate`(contract: String) async {
        let transport = AgentNavigationTransport(catalogs: [.success(self.catalog(contract: contract))])
        let fixture = AgentNavigationFixture(
            transport: transport, sessionKey: "agent:research:main", routingContract: contract)
        defer { fixture.close() }
        let vm = fixture.viewModel
        await vm.refreshAgents()
        vm.input = "Primary draft"
        vm.switchAgent(to: "research")
        #expect(vm.sessionKey == "agent:research:inbox")
        #expect(vm.input == "Primary draft")
        vm.switchSession(to: "agent:research:global")
        #expect(vm.input.isEmpty)
        vm.input = "Ordinary global draft"
        vm.switchSession(to: "agent:research:main")
        #expect(vm.input == "Primary draft")
        vm.switchSession(to: "agent:research:global")
        #expect(vm.input == "Ordinary global draft")
    }

    @Test func `an abort keeps its captured global owner across navigation between runs`() async throws {
        let gate = AgentNavigationGate()
        let transport = AgentNavigationTransport(catalogs: [.success(self.catalog())], firstAbortGate: gate)
        let fixture = AgentNavigationFixture(transport: transport)
        defer { fixture.close() }
        let vm = fixture.viewModel
        vm.switchSession(to: "global", agentID: "research")
        try await waitUntil("research bootstrap finishes") { await MainActor.run { !vm.isLoading } }
        vm.pendingRuns = ["run-one", "run-two"]
        vm.abort()
        try await waitUntil("first abort begins") { await transport.abortTargets.count == 1 }
        vm.switchSession(to: "global", agentID: "main")
        await gate.release()
        try await waitUntil("both requested runs aborted") { await transport.abortTargets.count == 2 }
        #expect(await transport.abortTargets.allSatisfy {
            $0 == OpenClawChatSessionTarget(sessionKey: "global", agentID: "research")
        })
    }

    @Test func `row mutations retain the global owner while another agent is selected`() async throws {
        let transport = AgentNavigationTransport(catalogs: [.success(self.catalog())])
        let fixture = AgentNavigationFixture(transport: transport)
        defer { fixture.close() }
        let vm = fixture.viewModel
        vm.renameSession(key: "global", label: "Research notes", agentID: "research")
        vm.setSessionPinned(key: "global", pinned: true, agentID: "research")
        vm.setSessionUnread(key: "global", unread: true, agentID: "research")
        await vm.setSessionColor(key: "global", color: "blue", agentID: "research")
        try await vm.setSessionGroup(key: "global", group: "Work", agentID: "research")
        vm.deleteSession("global", agentID: "research")
        try await waitUntil("all row mutations dispatched") { await transport.mutationRequests.count == 6 }
        let requests = await transport.mutationRequests
        #expect(requests.allSatisfy { $0.params["key"]?.value as? String == "global" })
        #expect(requests.allSatisfy { $0.params["agentId"]?.value as? String == "research" })
        #expect(vm.selectedAgentID == "main")
    }

    @Test(arguments: ["per-agent|inbox|main", "global|inbox|main"])
    func `agent selection reopens its main and keeps sends and new chats on that agent`(contract: String) async throws {
        let transport = AgentNavigationTransport(catalogs: [.success(self.catalog(contract: contract))])
        let fixture = AgentNavigationFixture(transport: transport, routingContract: contract)
        defer { fixture.close() }
        let vm = fixture.viewModel
        await vm.refreshAgents()

        vm.switchAgent(to: "RESEARCH")
        let mainKey = "inbox"
        let selectedKey = "agent:research:\(mainKey)"
        #expect(vm.sessionKey == selectedKey)
        #expect(vm.selectedAgentID == "research")
        #expect(vm.selectedAgent?.displayName == "Research")
        #expect(vm.selectedAgentMainSessionKey == selectedKey)
        try await waitUntil("selected agent roster loads") {
            await transport.listedAgentIDs.contains("research")
        }
        _ = await vm.fetchSessionList(search: "older", archived: true)
        #expect(await transport.listedAgentIDs.last == "research")
        vm.switchAgent(to: "research")
        #expect(await transport.createdKeys.isEmpty)

        vm.syncActiveAgentId("replacement-default")
        #expect(vm.selectedAgentID == "research")
        vm.input = "Hello Research"
        vm.send()
        try await waitUntil("send reaches selected agent") { await transport.sentKeys == [selectedKey] }
        try await waitUntil("send settles") { await MainActor.run { !vm.isSending } }

        #expect(await vm.startNewSession())
        #expect(await transport.createdKeys.count == 1)
        #expect(vm.sessionKey.hasPrefix("agent:research:"))
    }

    @Test(arguments: ["main", "global"])
    func `alias draft survives agent navigation and canonical return`(alias: String) async {
        let contract = alias == "global" ? "global|main|main" : "per-agent|main|main"
        let transport = AgentNavigationTransport(catalogs: [.success(self.catalog(contract: contract))])
        let fixture = AgentNavigationFixture(transport: transport, sessionKey: alias, routingContract: contract)
        defer { fixture.close() }
        let vm = fixture.viewModel
        await vm.refreshAgents()
        vm.input = "Unsent assistant draft"
        vm.switchAgent(to: "main")
        #expect(vm.input == "Unsent assistant draft")
        vm.switchAgent(to: "research")
        #expect(vm.input.isEmpty)
        vm.input = "Unsent research draft"
        vm.switchAgent(to: "main")
        #expect(vm.input == "Unsent assistant draft")
        vm.switchAgent(to: "research")
        #expect(vm.input == "Unsent research draft")
    }

    @Test(arguments: ["per-agent|inbox|main", "global|inbox|main"])
    func `deleting a selected agent thread returns to that agents primary conversation`(contract: String) async throws {
        let transport = AgentNavigationTransport(catalogs: [.success(self.catalog(contract: contract))])
        let fixture = AgentNavigationFixture(
            transport: transport,
            sessionKey: "agent:research:topic",
            routingContract: contract)
        defer { fixture.close() }
        let vm = fixture.viewModel
        let mainKey = "inbox"

        vm.deleteSession("agent:research:topic")

        try await waitUntil("selected agent primary opens") {
            await MainActor.run { vm.sessionKey == "agent:research:\(mainKey)" }
        }
        #expect(vm.selectedAgentID == "research")
    }

    @Test func `accepted alias send does not restore a duplicate draft after navigation`() async throws {
        let sendGate = AgentNavigationGate()
        let transport = AgentNavigationTransport(catalogs: [.success(self.catalog())], sendGate: sendGate)
        let fixture = AgentNavigationFixture(transport: transport)
        defer { fixture.close() }
        let vm = fixture.viewModel
        await vm.refreshAgents()
        vm.input = "Send once"
        vm.send()
        try await waitUntil("alias send starts") { await transport.sentKeys == ["main"] }
        vm.switchAgent(to: "research")
        vm.syncActiveAgentId("replacement-default")
        await sendGate.release()
        try await waitUntil("alias send settles") { await MainActor.run { !vm.isSending } }
        vm.switchAgent(to: "main")
        #expect(vm.input.isEmpty)
        #expect(vm.recallPreviousInput(caretOnFirstLine: true))
        #expect(vm.input == "Send once")
    }

    @Test func `agent selection preserves an attachment owned by the current chat`() async {
        let transport = AgentNavigationTransport(catalogs: [.success(self.catalog())])
        let fixture = AgentNavigationFixture(transport: transport)
        defer { fixture.close() }
        let vm = fixture.viewModel
        await vm.refreshAgents()
        vm.attachments = [.init(url: nil, data: Data([1]), fileName: "draft.png", mimeType: "image/png", preview: nil)]
        vm.switchAgent(to: "research")
        #expect(vm.sessionKey == "main")
        #expect(vm.selectedAgentID == "main")
        #expect(vm.attachments.count == 1)
        #expect(vm.errorText != nil)
    }

    @Test(arguments: [false, true])
    func `reconnect discards a previous route catalog response`(replacement: Bool) async throws {
        let gate = AgentNavigationGate()
        let updated = OpenClawChatAgentsListResponse(defaultId: "new", agents: [.init(id: "new")])
        let transport = AgentNavigationTransport(
            catalogs: [.success(self.catalog()), .success(updated)],
            catalogGate: gate)
        let fixture = AgentNavigationFixture(transport: transport)
        defer { fixture.close() }
        let vm = fixture.viewModel
        let first = Task { await vm.refreshAgents() }
        try await waitUntil("first catalog starts") { await transport.catalogRequests == 1 }
        if replacement {
            vm.handleTransportEvent(.routeChanged)
        } else {
            vm.handleTransportEvent(.health(ok: false))
            vm.handleTransportEvent(.health(ok: true))
        }
        try await waitUntil("replacement catalog arrives") {
            await MainActor.run { vm.agentChoices.map(\.id) == ["new"] }
        }
        await gate.release()
        await first.value
        #expect(vm.agentChoices.map(\.id) == ["new"])
        #expect(!vm.isLoadingAgents)
        #expect(vm.agentsErrorText == nil)
    }

    @Test func `catalog retry clears errors and an empty authoritative roster removes old choices`() async {
        let transport = AgentNavigationTransport(catalogs: [
            .failure(.offline), .success(self.catalog()), .success(nil),
        ])
        let fixture = AgentNavigationFixture(transport: transport)
        defer { fixture.close() }
        let vm = fixture.viewModel
        await vm.refreshAgents()
        #expect(vm.agentsErrorText != nil)
        #expect(!vm.isLoadingAgents)
        await vm.refreshAgents()
        #expect(vm.agentsErrorText == nil)
        #expect(vm.agentChoices.count == 2)
        await vm.refreshAgents()
        #expect(vm.agentChoices.isEmpty)
    }
}
