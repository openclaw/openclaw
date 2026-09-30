import Foundation
import Observation
import OpenClawKit
import Synchronization
import Testing
@testable import OpenClawChatUI

private actor UnreadTestTransportState {
    var historyCalls = 0
    var listCalls = 0
    var unreadPatchAttempts: [(String, Bool)] = []
    var unreadPatchStarts = 0
    var sessionOverride: [OpenClawChatSessionEntry]?
    var historyFailuresRemaining: Int
    var patchFailuresRemaining: Int

    init(historyFailures: Int, patchFailures: Int) {
        self.historyFailuresRemaining = historyFailures
        self.patchFailuresRemaining = patchFailures
    }
}

private actor UnreadMutationRecorder {
    private(set) var events: [String] = []

    func append(_ event: String) {
        self.events.append(event)
    }
}

private actor UnreadPatchGate {
    private var continuation: CheckedContinuation<Void, Never>?
    private var released = false

    func wait() async {
        guard !self.released else { return }
        await withCheckedContinuation { continuation in
            if self.released {
                continuation.resume()
            } else {
                self.continuation = continuation
            }
        }
    }

    func release() {
        self.released = true
        self.continuation?.resume()
        self.continuation = nil
    }
}

private final class UnreadTestTransport: @unchecked Sendable, OpenClawChatTransport {
    private let state: UnreadTestTransportState
    private let sessions: [OpenClawChatSessionEntry]
    private let respectsListLimit: Bool
    private let patchDelay: Duration?
    private let patchGate: UnreadPatchGate?

    init(
        sessions: [OpenClawChatSessionEntry],
        historyFailures: Int = 0,
        patchFailures: Int = 0,
        respectsListLimit: Bool = false,
        patchDelay: Duration? = nil,
        patchGate: UnreadPatchGate? = nil)
    {
        self.sessions = sessions
        self.respectsListLimit = respectsListLimit
        self.patchDelay = patchDelay
        self.patchGate = patchGate
        self.state = UnreadTestTransportState(
            historyFailures: historyFailures,
            patchFailures: patchFailures)
    }

    func requestHistory(sessionKey: String) async throws -> OpenClawChatHistoryPayload {
        await self.state.recordHistoryCall()
        if await self.state.consumeHistoryFailure() {
            throw NSError(domain: "UnreadTestTransport", code: 1)
        }
        return OpenClawChatHistoryPayload(
            sessionKey: sessionKey,
            sessionId: "session-\(sessionKey)",
            messages: [],
            thinkingLevel: "off")
    }

    func sendMessage(
        sessionKey _: String,
        message _: String,
        thinking _: String,
        idempotencyKey _: String,
        attachments _: [OpenClawChatAttachmentPayload]) async throws -> OpenClawChatSendResponse
    {
        throw NSError(domain: "UnreadTestTransport", code: 3)
    }

    func listSessions(
        limit: Int?,
        search _: String?,
        archived _: Bool) async throws -> OpenClawChatSessionsListResponse
    {
        await self.state.recordListCall()
        let sessions = await self.state.sessionOverride ?? self.sessions
        let listed = if self.respectsListLimit, let limit {
            Array(sessions.prefix(limit))
        } else {
            sessions
        }
        return OpenClawChatSessionsListResponse(
            ts: nil,
            path: nil,
            count: listed.count,
            defaults: nil,
            sessions: listed)
    }

    func patchSession(
        key: String,
        expectedSessionID _: String?,
        label _: String??,
        category _: String??,
        color _: String?? = nil,
        pinned _: Bool?,
        archived _: Bool?,
        unread: Bool?) async throws
    {
        guard let unread else { return }
        await self.state.recordUnreadPatchStart()
        if let patchGate {
            await patchGate.wait()
        } else if let patchDelay {
            try await Task.sleep(for: patchDelay)
        }
        await self.state.recordUnreadPatch(key: key, unread: unread)
        if await self.state.consumePatchFailure() {
            throw NSError(domain: "UnreadTestTransport", code: 2)
        }
    }

    func requestHealth(timeoutMs _: Int) async throws -> Bool {
        true
    }

    func listModels(agentID _: String?) async throws -> [OpenClawChatModelChoice] {
        []
    }

    func events() -> AsyncStream<OpenClawChatTransportEvent> {
        AsyncStream { $0.finish() }
    }

    func unreadPatchAttempts() async -> [(String, Bool)] {
        await self.state.unreadPatchAttempts
    }

    func historyCallCount() async -> Int {
        await self.state.historyCalls
    }

    func unreadPatchStartCount() async -> Int {
        await self.state.unreadPatchStarts
    }

    func listCallCount() async -> Int {
        await self.state.listCalls
    }

    func setSessions(_ sessions: [OpenClawChatSessionEntry]) async {
        await self.state.setSessions(sessions)
    }
}

extension UnreadTestTransportState {
    fileprivate func recordHistoryCall() {
        self.historyCalls += 1
    }

    fileprivate func recordListCall() {
        self.listCalls += 1
    }

    fileprivate func recordUnreadPatch(key: String, unread: Bool) {
        self.unreadPatchAttempts.append((key, unread))
    }

    fileprivate func recordUnreadPatchStart() {
        self.unreadPatchStarts += 1
    }

    fileprivate func consumeHistoryFailure() -> Bool {
        guard self.historyFailuresRemaining > 0 else { return false }
        self.historyFailuresRemaining -= 1
        return true
    }

    fileprivate func consumePatchFailure() -> Bool {
        guard self.patchFailuresRemaining > 0 else { return false }
        self.patchFailuresRemaining -= 1
        return true
    }

    fileprivate func setSessions(_ sessions: [OpenClawChatSessionEntry]) {
        self.sessionOverride = sessions
    }
}

private actor SidebarUnreadReceiptTransport: OpenClawChatTransport {
    var roster: Data
    let acknowledgement: Data?
    let patchGate: UnreadPatchGate?
    let listGate: UnreadPatchGate?
    private(set) var listCalls = 0
    private(set) var patchCalls = 0
    private var patchWaiter: CheckedContinuation<Void, Never>?
    private var listWaiter: CheckedContinuation<Void, Never>?

    init(roster: Data, acknowledgement: Data?, patchGate: UnreadPatchGate? = nil, listGate: UnreadPatchGate? = nil) {
        self.roster = roster
        self.acknowledgement = acknowledgement
        self.patchGate = patchGate
        self.listGate = listGate
    }

    func setRoster(_ data: Data) {
        self.roster = data
    }

    func waitForPatch() async {
        guard self.patchCalls == 0 else { return }
        await withCheckedContinuation { self.patchWaiter = $0 }
    }

    func waitForList() async {
        guard self.listCalls == 0 else { return }
        await withCheckedContinuation { self.listWaiter = $0 }
    }

    private func patch() async {
        self.patchCalls += 1
        self.patchWaiter?.resume()
        self.patchWaiter = nil
        await self.patchGate?.wait()
    }

    func acquireSessionMutationRouteLease() async -> OpenClawChatSessionMutationRouteLease? {
        guard let acknowledgement else {
            return OpenClawChatSessionMutationRouteLease(patchSession: { _, _, _, _, _, _, _, _, _ in
                await self.patch()
            })
        }
        return OpenClawChatSessionMutationRouteLease(
            sessionTarget: { .init(sessionKey: $0, agentID: "main") },
            unreadAckContract: true,
            receivesPatchReceipts: true,
            request: { _ in
                await self.patch()
                return acknowledgement
            })
    }

    func acquireSessionSettingsRouteLease() async -> OpenClawChatSessionSettingsRouteLease? {
        let acknowledgement = self.acknowledgement
        return OpenClawChatSessionSettingsRouteLease { _, _, _ in
            await self.patch()
            return try acknowledgement.map { try JSONDecoder().decode(OpenClawChatModelPatchResult.self, from: $0) }
        }
    }

    func listSessions(limit _: Int?, search _: String?, archived _: Bool) async throws
        -> OpenClawChatSessionsListResponse
    {
        self.listCalls += 1
        self.listWaiter?.resume()
        self.listWaiter = nil
        let snapshot = self.roster
        await self.listGate?.wait()
        return try JSONDecoder().decode(OpenClawChatSessionsListResponse.self, from: snapshot)
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
        sessionKey _: String, message _: String, thinking _: String, idempotencyKey _: String,
        attachments _: [OpenClawChatAttachmentPayload]) async throws -> OpenClawChatSendResponse
    {
        throw CancellationError()
    }
}

@Suite(.serialized)
@MainActor
struct ChatViewModelUnreadTests {
    private let sidebarRoster = Data(#"""
    {"sessions":[{"key":"agent:main:thread","agentId":"main","sessionId":"original",
      "createdAt":1,"updatedAt":10,"unread":true,"markedUnreadAt":5}]}
    """#.utf8)

    private func readAcknowledgement(sessionID: String, markedUnread: Bool = false) -> Data {
        let marker = markedUnread ? #", "markedUnreadAt":15"# : ""
        return Data(#"""
        {"ok":true,"key":"agent:main:thread","entry":{"sessionId":"\#(sessionID)",
          "createdAt":1,"updatedAt":20,"lastReadAt":20,"lastActivityAt":10\#(marker)}}
        """#.utf8)
    }

    @Test(arguments: [false, true], ["rename", "pin", "archive", "read"])
    func `sidebar rows reflect optimistic session actions before acknowledgements`(
        conversationRosterContainsRow: Bool, action: String) async throws
    {
        let roster = Data(#"""
        {"sessions":[{"key":"agent:main:thread","agentId":"main","sessionId":"thread",
          "label":"Before","createdAt":1,"updatedAt":10,"unread":true,"pinned":false,"archived":false}]}
        """#.utf8)
        let gate = UnreadPatchGate()
        let transport = SidebarUnreadReceiptTransport(roster: roster, acknowledgement: nil, patchGate: gate)
        let suite = "ChatViewModelUnreadTests.SidebarOptimistic.\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let viewModel = OpenClawChatViewModel(
            sessionKey: "agent:main:main", transport: transport, activeAgentId: "main",
            modelPickerStore: ChatModelPickerStore(defaults: defaults))
        defer { viewModel.detachTransport() }
        if conversationRosterContainsRow {
            viewModel.sessions = try JSONDecoder().decode(OpenClawChatSessionsListResponse.self, from: roster).sessions
        }
        viewModel.enableSidebarData()
        let owner = try #require(viewModel.sidebarData)
        let decoded = try JSONDecoder().decode(OpenClawChatSessionsListResponse.self, from: roster).sessions
        let refs = owner.receive(decoded, read: owner.beginRead())
        let row = try #require(owner.project(refs).first)

        switch action {
        case "rename": viewModel.renameSession(key: row.key, label: "After", agentID: row.agentId)
        case "pin": viewModel.setSessionPinned(key: row.key, pinned: true, agentID: row.agentId)
        case "archive": viewModel.setSessionArchived(row, archived: true)
        default: viewModel.setSessionUnread(key: row.key, unread: false, agentID: row.agentId)
        }
        let visible = owner.project(refs).first { !$0.isArchived }
        switch action {
        case "rename": #expect(visible?.label == "After")
        case "pin": #expect(visible?.pinned == true)
        case "archive": #expect(visible == nil)
        default: #expect(visible?.unread == false)
        }
        await transport.waitForPatch()
        await gate.release()
        await transport.waitForList()
        await viewModel.fetchSessions(limit: 200)
    }

    @Test func `macOS roster consumers observe one canonical mutation without a stale copy`() async throws {
        let roster = Data(#"""
        {"sessions":[{"key":"agent:main:thread","agentId":"main","sessionId":"thread","label":"Before","updatedAt":10,"swarmGroupId":"group"}]}
        """#.utf8)
        let gate = UnreadPatchGate()
        let transport = SidebarUnreadReceiptTransport(roster: roster, acknowledgement: nil, patchGate: gate)
        let suite = "ChatViewModelUnreadTests.Consumers.\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let vm = OpenClawChatViewModel(
            sessionKey: "agent:main:thread",
            transport: transport,
            activeAgentId: "main",
            modelPickerStore: ChatModelPickerStore(defaults: defaults))
        defer { vm.detachTransport() }
        vm.enableSidebarData()
        await vm.fetchSessions(limit: 200)
        let owner = try #require(vm.sidebarData)
        let wireRows = try JSONDecoder().decode(OpenClawChatSessionsListResponse.self, from: roster).sessions
        let manager = owner.receive(wireRows, read: owner.beginRead())
        vm.swarmSessions = wireRows
        var palette = ChatCommandPaletteSearch()
        let request = ChatCommandPaletteSearch.Request(query: "Before", target: vm.currentSessionTarget)
        palette.complete(wireRows, generation: palette.begin(request, owner: owner))
        let readers: [() -> [OpenClawChatSessionEntry]] = [
            { vm.sessions },
            { ChatSessionSidebarModel.sections(
                sessions: vm.sessions,
                currentSessionKey: vm.sessionKey,
                activeAgentID: "main",
                query: "").flatMap(\.nodes).map(\.session) },
            { palette.rows(for: request) },
            { owner.project(manager) },
            { vm.swarmSessions },
            { vm.currentSessionEntry().map { [$0] } ?? [] },
            { owner.row(key: vm.sessionKey, agentID: "main").map { [$0] } ?? [] },
        ]
        var projectionCounts: [OpenClawChatSessionSidebarData.Projection: Int] = [:]
        owner.onProjectionComputed = { projectionCounts[$0, default: 0] += 1 }
        vm.swarmRowIDs = manager
        for _ in 0..<20 {
            for read in readers {
                _ = read()
            }
        }
        #expect(projectionCounts[.swarm] == 1)
        #expect(projectionCounts.values.allSatisfy { $0 == 1 })
        let observed = vm.swarmActivityState.observe(OpenClawChatSessionsChangedEvent(
            sessionKey: vm.sessionKey, reason: "swarm-note", swarmGroupId: "group", kind: "log", text: "Working"))
        #expect(observed)
        for _ in 0..<20 {
            #expect(vm.swarmSessions.first?.swarmLog == "Working")
        }
        #expect(projectionCounts[.swarm] == 2)
        let changes = Mutex(Array(repeating: 0, count: readers.count))
        for (index, read) in readers.enumerated() {
            withObservationTracking { _ = read() } onChange: { changes.withLock { $0[index] += 1 } }
        }
        vm.renameSession(key: vm.sessionKey, label: "After", agentID: "main")
        #expect(changes.withLock { $0 } == Array(repeating: 1, count: readers.count))
        for read in readers {
            #expect(read().map(\.label) == ["After"])
        }
        #expect(vm.legacySessions.isEmpty)
        owner.receive([], read: owner.beginRead(), replacingAgent: "main")
        vm.updateCurrentSessionModel(
            modelID: "fixture-next",
            modelProvider: "fixture",
            sessionKey: vm.sessionKey,
            syncSelection: false)
        #expect(owner.project(manager).first?.sessionId == "thread")
        #expect(owner.project(manager).first?.label == "After")
        #expect(owner.project(manager).first?.model == "fixture-next")
        await transport.waitForPatch()
        await gate.release()
    }

    @Test func `agent navigation retains another owners canonical global observer`() throws {
        let roster = Data(#"""
        {"sessions":[{"key":"global","agentId":"main","sessionId":"global-main","hasActiveRun":true,
          "activeRunIds":["run"],"observerDigest":{"agentId":"main","runId":"run","revision":2,
          "updatedAt":20,"headline":"Working","health":"on-track"}}]}
        """#.utf8)
        let transport = SidebarUnreadReceiptTransport(roster: roster, acknowledgement: nil)
        let suite = "ChatViewModelUnreadTests.OwnerNavigation.\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let vm = OpenClawChatViewModel(
            sessionKey: "global",
            transport: transport,
            activeAgentId: "main",
            modelPickerStore: ChatModelPickerStore(defaults: defaults))
        defer { vm.detachTransport() }
        vm.sessions = try JSONDecoder().decode(OpenClawChatSessionsListResponse.self, from: roster).sessions
        vm.enableSidebarData()
        vm.syncActiveAgentId("other")
        #expect(vm.sessions.isEmpty)
        #expect(vm.sidebarData?.row(key: "global", agentID: "main")?.observerDigest?.headline == "Working")
        vm.syncActiveAgentId("main")
        #expect(vm.sessions.first?.observerDigest?.headline == "Working")
    }

    @Test func `retired metadata read retries before publishing readiness and its roster`() async throws {
        let gate = UnreadPatchGate()
        let transport = SidebarUnreadReceiptTransport(roster: self.sidebarRoster, acknowledgement: nil, listGate: gate)
        let suite = "ChatViewModelUnreadTests.RetiredMetadata.\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let vm = OpenClawChatViewModel(
            sessionKey: "agent:main:thread",
            transport: transport,
            activeAgentId: "main",
            modelPickerStore: ChatModelPickerStore(defaults: defaults))
        defer { vm.detachTransport() }
        vm.enableSidebarData()
        let read = Task { await vm.fetchSessions(limit: 200) }
        await transport.waitForList()
        vm.sidebarData?.invalidate()
        await transport.setRoster(Data(#"""
        {"sessions":[{"key":"agent:main:thread","agentId":"main","sessionId":"replacement","label":"New scope"}]}
        """#.utf8))
        await gate.release()
        await read.value
        #expect(vm.sessions.first?.label == "New scope")
        #expect(await transport.listCalls == 2)
        #expect(vm.hasAppliedLiveSessions)
    }

    @Test func `field writes do not discard roster additions and removals from an in flight refresh`() async throws {
        let gate = UnreadPatchGate()
        let incoming = Data(#"""
        {"sessions":[{"key":"agent:main:thread","agentId":"main","sessionId":"thread","model":"before","updatedAt":10},
                     {"key":"agent:main:added","agentId":"main","sessionId":"added"},
                     {"key":"agent:main:other","agentId":"main","sessionId":"other","label":"New fact","updatedAt":20}]}
        """#.utf8)
        let transport = SidebarUnreadReceiptTransport(roster: incoming, acknowledgement: nil, listGate: gate)
        let suite = "ChatViewModelUnreadTests.MembershipRefresh.\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let vm = OpenClawChatViewModel(
            sessionKey: "agent:main:thread",
            transport: transport,
            activeAgentId: "main",
            modelPickerStore: ChatModelPickerStore(defaults: defaults))
        defer { vm.detachTransport() }
        vm.sessions = try JSONDecoder().decode(OpenClawChatSessionsListResponse.self, from: Data(#"""
        {"sessions":[{"key":"agent:main:thread","agentId":"main","sessionId":"thread","model":"before","updatedAt":10},
                     {"key":"agent:main:removed","agentId":"main","sessionId":"removed"},
                     {"key":"agent:main:other","agentId":"main","sessionId":"other","label":"Old fact","updatedAt":10}]}
        """#.utf8)).sessions
        vm.enableSidebarData()
        let refresh = Task { await vm.fetchSessions(limit: 200) }
        await transport.waitForList()
        vm.updateCurrentSessionModel(
            modelID: "after",
            modelProvider: "fixture",
            sessionKey: vm.sessionKey,
            syncSelection: false)
        await gate.release()
        await refresh.value
        #expect(Set(vm.sessions.compactMap(\.sessionId)) == ["thread", "added", "other"])
        #expect(vm.sessions.first { $0.sessionId == "other" }?.label == "New fact")
        #expect(vm.currentSessionEntry()?.model == "after")
        #expect(await transport.listCalls == 1)
    }

    @Test func `a settings acknowledgement fences reads issued during its optimistic selection`() async throws {
        let rows = Data(#"""
        {"sessions":[{"key":"agent:main:thread","agentId":"main","sessionId":"thread","thinkingLevel":"low","updatedAt":10}]}
        """#.utf8)
        let ack = Data(#"""
        {"ok":true,"key":"agent:main:thread","entry":{"sessionId":"thread","thinkingLevel":"high","updatedAt":20}}
        """#.utf8)
        let gate = UnreadPatchGate()
        let transport = SidebarUnreadReceiptTransport(roster: rows, acknowledgement: ack, patchGate: gate)
        let suite = "ChatViewModelUnreadTests.SettingsAcknowledgement.\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let vm = OpenClawChatViewModel(
            sessionKey: "agent:main:thread",
            transport: transport,
            activeAgentId: "main",
            modelPickerStore: ChatModelPickerStore(defaults: defaults))
        defer { vm.detachTransport() }
        let original = try JSONDecoder().decode(OpenClawChatSessionsListResponse.self, from: rows).sessions
        vm.sessions = original
        vm.enableSidebarData()
        let owner = try #require(vm.sidebarData)
        vm.selectThinkingLevel("high")
        try #require(vm.isUpdatingSessionSettings)
        await transport.waitForPatch()
        let oldQuery = owner.beginRead()
        await gate.release()
        await vm.waitForPendingSessionSettings(for: vm.currentModelPatchTarget())
        #expect(vm.currentSessionEntry()?.thinkingLevel == "high")
        owner.receive(original, read: oldQuery)
        #expect(vm.currentSessionEntry()?.thinkingLevel == "high")
    }

    @Test(arguments: [
        ("original", true, false), ("original", true, true), ("replacement", true, false),
        (nil, true, false), ("original", false, false),
    ] as [(String?, Bool, Bool)])
    func `activation read skips reload only for a receipt bound to the enabled sidebar`(
        receiptSessionID: String?, sidebarEnabled: Bool, canonicalUnread: Bool) async throws
    {
        let transport = SidebarUnreadReceiptTransport(
            roster: self.sidebarRoster,
            acknowledgement: receiptSessionID.map {
                self.readAcknowledgement(sessionID: $0, markedUnread: canonicalUnread)
            })
        let suite = "ChatViewModelUnreadTests.Receipt.\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let viewModel = OpenClawChatViewModel(
            sessionKey: "agent:main:thread", transport: transport, activeAgentId: "main",
            modelPickerStore: ChatModelPickerStore(defaults: defaults))
        defer { viewModel.detachTransport() }
        let roster = try JSONDecoder().decode(OpenClawChatSessionsListResponse.self, from: self.sidebarRoster)
        viewModel.sessions = roster.sessions
        viewModel.hasAppliedLiveHistory = true
        if sidebarEnabled {
            viewModel.enableSidebarData()
        }

        await viewModel.markCurrentSessionReadAfterActivation(viewModel.currentSessionSnapshot(), fallbackEntry: nil)
        let confirmed = sidebarEnabled && receiptSessionID == "original"
        if confirmed {
            #expect(viewModel.sessions.first?.unread == canonicalUnread)
            #expect(viewModel.unreadPatchGuard.confirmedUnread(key: "agent:main:thread") == canonicalUnread)
            #expect(viewModel.sidebarData?.conversationRows(agentID: "main").first?.lastReadAt == 20)
            #expect(viewModel.sidebarData?.conversationRows(agentID: "main").first?
                .markedUnreadAt == (canonicalUnread ? 15 : nil))
        } else {
            await transport.waitForList()
        }
        #expect(await transport.patchCalls == 1)
        #expect(await transport.listCalls == (confirmed ? 0 : 1))
        if confirmed {
            viewModel.handleTransportEvent(.sessionsChanged(.init(
                sessionKey: "agent:main:thread", agentId: "main", reason: "patch")))
            await transport.waitForList()
        }
    }

    @Test func `newer manual unread survives a delayed successful activation receipt`() async throws {
        let gate = UnreadPatchGate()
        let transport = SidebarUnreadReceiptTransport(
            roster: self.sidebarRoster, acknowledgement: self.readAcknowledgement(sessionID: "original"),
            patchGate: gate)
        let suite = "ChatViewModelUnreadTests.NewerReceipt.\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let viewModel = OpenClawChatViewModel(
            sessionKey: "agent:main:thread", transport: transport, activeAgentId: "main",
            modelPickerStore: ChatModelPickerStore(defaults: defaults))
        defer { viewModel.detachTransport() }
        let roster = try JSONDecoder().decode(OpenClawChatSessionsListResponse.self, from: self.sidebarRoster)
        viewModel.sessions = roster.sessions
        viewModel.hasAppliedLiveHistory = true
        viewModel.enableSidebarData()
        let sidebar = try #require(viewModel.sidebarData)
        let read = Task {
            await viewModel.markCurrentSessionReadAfterActivation(
                viewModel.currentSessionSnapshot(),
                fallbackEntry: nil)
        }
        await transport.waitForPatch()
        let newer = Data(#"""
        {"sessions":[{"key":"agent:main:thread","agentId":"main","sessionId":"original",
          "createdAt":1,"updatedAt":30,"lastReadAt":20,"unread":true,"markedUnreadAt":30}]}
        """#.utf8)
        viewModel.sessions = try JSONDecoder().decode(OpenClawChatSessionsListResponse.self, from: newer).sessions
        await transport.setRoster(newer)
        await gate.release()
        await read.value

        #expect(viewModel.sessions.first?.unread == true)
        #expect(viewModel.sessions.first?.markedUnreadAt == 30)
        #expect(sidebar.conversationRows(agentID: "main").first?.unread == true)
        #expect(sidebar.conversationRows(agentID: "main").first?.markedUnreadAt == 30)
        #expect(viewModel.unreadPatchGuard.confirmedUnread(key: "agent:main:thread") == true)
        #expect(await transport.listCalls == 0)
    }

    @Test func `successful activation clears unread once`() async throws {
        let transport = UnreadTestTransport(sessions: [self.entry(key: "a", unread: true)])
        let viewModel = self.viewModel(sessionKey: "a", transport: transport)

        viewModel.load()
        try await self.waitForUnreadState("initial activation unread patch") {
            await transport.unreadPatchAttempts().count == 1
        }
        viewModel.refresh()
        try await self.waitForUnreadState("refresh bootstrap settled") {
            await transport.listCallCount() >= 2 && !viewModel.isLoading
        }

        let attempts = await transport.unreadPatchAttempts()
        #expect(attempts.map(\.0) == ["a"])
        #expect(attempts.map(\.1) == [false])
    }

    @Test func `main alias refresh does not rearm unread clearing`() async throws {
        let transport = UnreadTestTransport(
            sessions: [self.entry(key: "agent:alpha:main", unread: true)])
        let viewModel = self.viewModel(
            sessionKey: "main",
            activeAgentID: "alpha",
            transport: transport)

        viewModel.load()
        try await self.waitForUnreadState("main alias activation unread patch") {
            await transport.unreadPatchAttempts().count == 1
        }
        viewModel.refresh()
        try await self.waitForUnreadState("main alias refresh settled") {
            await transport.historyCallCount() >= 2 && !viewModel.isLoading
        }

        #expect(await transport.unreadPatchAttempts().count == 1)
    }

    @Test func `cold main alias mark unread shares canonical activation identity`() async throws {
        let transport = UnreadTestTransport(
            sessions: [self.entry(key: "agent:alpha:main", unread: true)],
            patchDelay: .milliseconds(50))
        let viewModel = self.viewModel(
            sessionKey: "main",
            activeAgentID: "alpha",
            transport: transport)

        viewModel.setSessionUnread(key: "main", unread: true)
        viewModel.load()
        try await self.waitForUnreadState("cold main alias unread mutation settled") {
            await transport.unreadPatchAttempts().count == 1 && !viewModel.isLoading
        }

        let attempts = await transport.unreadPatchAttempts()
        #expect(attempts.map(\.0) == ["main"])
        #expect(attempts.map(\.1) == [true])
    }

    @Test func `failed history does not clear unread`() async throws {
        let transport = UnreadTestTransport(
            sessions: [self.entry(key: "a", unread: true)],
            historyFailures: 1)
        let viewModel = self.viewModel(sessionKey: "a", transport: transport)

        viewModel.load()
        try await self.waitForUnreadState("failed history surfaced") {
            !viewModel.isLoading && viewModel.errorText != nil
        }

        let attempts = await transport.unreadPatchAttempts()
        #expect(attempts.isEmpty)
    }

    @Test func `failed unread patch retries on next activation`() async throws {
        let transport = UnreadTestTransport(
            sessions: [
                self.entry(key: "a", unread: true),
                self.entry(key: "b", unread: false),
            ],
            patchFailures: 1)
        let viewModel = self.viewModel(sessionKey: "a", transport: transport)

        viewModel.load()
        try await self.waitForUnreadState("first failed unread patch recorded") {
            await transport.unreadPatchAttempts().count == 1
        }
        viewModel.switchSession(to: "b")
        try await self.waitForUnreadState("switched to session b") {
            viewModel.sessionId == "session-b"
        }
        viewModel.switchSession(to: "a")
        try await self.waitForUnreadState("retry unread patch recorded") {
            await transport.unreadPatchAttempts().count == 2
        }

        let attempts = await transport.unreadPatchAttempts()
        #expect(attempts.map(\.0) == ["a", "a"])
        #expect(attempts.allSatisfy { !$0.1 })
    }

    @Test func `failed intermediate activation still rearms unread clearing`() async throws {
        let transport = UnreadTestTransport(
            sessions: [
                self.entry(key: "a", unread: false),
                self.entry(key: "b", unread: false),
            ],
            historyFailures: 1)
        let viewModel = self.viewModel(sessionKey: "a", transport: transport)
        viewModel.refreshSessions()
        try await self.waitForUnreadState("initial session list loaded") {
            viewModel.sessions.count == 2
        }

        viewModel.setSessionUnread(key: "a", unread: true)
        try await self.waitForUnreadState("explicit unread mutation recorded") {
            await transport.unreadPatchAttempts().count == 1
        }
        await transport.setSessions([
            self.entry(key: "a", unread: true),
            self.entry(key: "b", unread: false),
        ])
        viewModel.switchSession(to: "b")
        try await self.waitForUnreadState("failed intermediate activation surfaced") {
            viewModel.errorText != nil
        }
        viewModel.switchSession(to: "a")
        try await self.waitForUnreadState("reactivated unread patch recorded") {
            await transport.unreadPatchAttempts().count == 2
        }

        let attempts = await transport.unreadPatchAttempts()
        #expect(attempts.map(\.0) == ["a", "a"])
        #expect(attempts.map(\.1) == [true, false])
    }

    @Test func `explicit mark unread rearms automatic clearing`() async throws {
        let transport = UnreadTestTransport(sessions: [
            self.entry(key: "a", unread: true),
            self.entry(key: "b", unread: false),
        ])
        let viewModel = self.viewModel(sessionKey: "a", transport: transport)

        viewModel.load()
        try await self.waitForUnreadState("initial activation read recorded") {
            await transport.unreadPatchAttempts().count == 1
        }
        viewModel.setSessionUnread(key: "a", unread: true)
        try await self.waitForUnreadState("explicit unread mutation recorded") {
            await transport.unreadPatchAttempts().count == 2
        }
        viewModel.switchSession(to: "b")
        try await self.waitForUnreadState("switched to session b") {
            viewModel.sessionId == "session-b"
        }
        viewModel.switchSession(to: "a")
        try await self.waitForUnreadState("reactivated unread patch recorded") {
            await transport.unreadPatchAttempts().count == 3
        }

        let attempts = await transport.unreadPatchAttempts()
        #expect(attempts.map(\.1) == [false, true, false])
    }

    @Test func `marking background session unread does not consume its activation`() async throws {
        let transport = UnreadTestTransport(sessions: [
            self.entry(key: "a", unread: false),
            self.entry(key: "b", unread: false),
        ])
        let viewModel = self.viewModel(sessionKey: "a", transport: transport)
        viewModel.refreshSessions()
        try await self.waitForUnreadState("background session list loaded") {
            viewModel.sessions.count == 2
        }

        viewModel.setSessionUnread(key: "b", unread: true)
        try await self.waitForUnreadState("background unread mutation recorded") {
            await transport.unreadPatchAttempts().count == 1
        }
        await transport.setSessions([
            self.entry(key: "a", unread: false),
            self.entry(key: "b", unread: true),
        ])
        viewModel.switchSession(to: "b")
        try await self.waitForUnreadState("background activation read recorded") {
            await transport.unreadPatchAttempts().count == 2
        }

        let attempts = await transport.unreadPatchAttempts()
        #expect(attempts.map(\.0) == ["b", "b"])
        #expect(attempts.map(\.1) == [true, false])
    }

    @Test func `manual unread from another client survives refresh until reactivation`() async throws {
        let transport = UnreadTestTransport(sessions: [
            self.entry(key: "a", unread: false),
            self.entry(key: "b", unread: false),
        ])
        let viewModel = self.viewModel(sessionKey: "a", transport: transport)

        viewModel.load()
        try await self.waitForUnreadState("initial read session loaded") {
            !viewModel.isLoading && viewModel.sessionId == "session-a"
        }
        await transport.setSessions([
            self.entry(key: "a", unread: true, markedUnreadAt: 100),
            self.entry(key: "b", unread: false),
        ])
        viewModel.refresh()
        try await self.waitForUnreadState("manual unread refresh settled") {
            await transport.historyCallCount() >= 2 && !viewModel.isLoading
        }
        #expect(await transport.unreadPatchAttempts().isEmpty)

        viewModel.switchSession(to: "b")
        try await self.waitForUnreadState("other session activated") {
            viewModel.sessionId == "session-b"
        }
        viewModel.switchSession(to: "a")
        try await self.waitForUnreadState("manual unread acknowledged on reactivation") {
            await transport.unreadPatchAttempts().count == 1
        }

        let attempts = await transport.unreadPatchAttempts()
        #expect(attempts.map(\.0) == ["a"])
        #expect(attempts.map(\.1) == [false])
    }

    @Test func `newer manual unread remains visible when activation acknowledgement loses race`() async throws {
        let patchGate = UnreadPatchGate()
        let transport = UnreadTestTransport(
            sessions: [self.entry(key: "a", unread: true, markedUnreadAt: 100)],
            patchGate: patchGate)
        let viewModel = self.viewModel(sessionKey: "a", transport: transport)

        viewModel.load()
        try await self.waitForUnreadState("activation acknowledgement started") {
            await transport.unreadPatchStartCount() == 1
        }
        await transport.setSessions([
            self.entry(key: "a", unread: true, markedUnreadAt: 101),
        ])
        await patchGate.release()
        try await self.waitForUnreadState("authoritative unread refresh applied") {
            await transport.listCallCount() >= 2 &&
                viewModel.sessions.first(where: { $0.key == "a" })?.markedUnreadAt == 101
        }

        let session = try #require(viewModel.sessions.first(where: { $0.key == "a" }))
        #expect(session.unread == true)
        #expect(session.markedUnreadAt == 101)
    }

    @Test func `successful off-list mark read records read confirmation`() async throws {
        let transport = UnreadTestTransport(sessions: [])
        let viewModel = self.viewModel(sessionKey: "a", transport: transport)

        viewModel.setSessionUnread(key: "hidden", unread: false)
        try await self.waitForUnreadState("off-list read confirmation recorded") {
            viewModel.unreadPatchGuard.confirmedUnread(key: "hidden") == false
        }

        #expect(viewModel.unreadPatchGuard.confirmedUnread(key: "hidden") == false)
    }

    @Test func `failed route lease preserves mutation queue ordering`() async throws {
        let recorder = UnreadMutationRecorder()
        let queue = ChatSessionUnreadMutationQueue()
        let firstLease = OpenClawChatSessionMutationRouteLease { _, _, _, _, _, _, _, _, _ in
            await recorder.append("first-start")
            try await Task.sleep(for: .milliseconds(100))
            await recorder.append("first-end")
        }
        let thirdLease = OpenClawChatSessionMutationRouteLease { _, _, _, _, _, _, _, _, _ in
            await recorder.append("third")
        }

        let first = queue.reserve(
            routeLease: Task<OpenClawChatSessionMutationRouteLease?, Never> { firstLease },
            queueKey: "a",
            routeKey: "a",
            unread: false)
        let second = queue.reserve(
            routeLease: Task<OpenClawChatSessionMutationRouteLease?, Never> { nil },
            queueKey: "a",
            routeKey: "a",
            unread: true)
        let third = queue.reserve(
            routeLease: Task<OpenClawChatSessionMutationRouteLease?, Never> { thirdLease },
            queueKey: "a",
            routeKey: "a",
            unread: false)

        _ = try await first.value
        await #expect(throws: OpenClawChatTransportSendError.self) {
            try await second.value
        }
        _ = try await third.value
        #expect(await recorder.events == ["first-start", "first-end", "third"])
    }

    @Test func `activation clears selected session outside refresh page`() async throws {
        let recent = (0..<50).map { index in
            self.entry(key: "recent-\(index)", unread: false, updatedAt: Double(100 - index))
        }
        let selected = self.entry(key: "old", unread: true, updatedAt: 1)
        let transport = UnreadTestTransport(
            sessions: recent + [selected],
            respectsListLimit: true)
        let viewModel = self.viewModel(sessionKey: "old", transport: transport)

        viewModel.refreshSessions(limit: 200)
        try await self.waitForUnreadState("selected off-page session loaded") {
            viewModel.sessions.contains { $0.key == "old" }
        }
        viewModel.load()
        try await self.waitForUnreadState("off-page activation read recorded") {
            await transport.unreadPatchAttempts().count == 1
        }

        let attempts = await transport.unreadPatchAttempts()
        #expect(attempts.map(\.0) == ["old"])
        #expect(attempts.map(\.1) == [false])
    }

    @Test func `failed unread patch refreshes authoritative session state`() async throws {
        let transport = UnreadTestTransport(
            sessions: [
                self.entry(key: "a", unread: true),
                self.entry(key: "b", unread: false),
            ],
            patchFailures: 1,
            patchDelay: .milliseconds(50))
        let viewModel = self.viewModel(sessionKey: "b", transport: transport)
        viewModel.refreshSessions()
        try await self.waitForUnreadState("authoritative session list loaded") {
            viewModel.sessions.count == 2
        }
        await transport.setSessions([
            self.entry(key: "a", unread: true),
            self.entry(key: "b", unread: false, pinned: true),
        ])

        viewModel.setSessionUnread(key: "a", unread: false)
        let otherIndex = try #require(viewModel.sessions.firstIndex(where: { $0.key == "b" }))
        viewModel.sessions[otherIndex].pinned = true
        try await self.waitForUnreadState("unread mutation failure surfaced") {
            viewModel.errorText != nil
        }
        try await self.waitForUnreadState("failure refresh completed") {
            await transport.listCallCount() >= 2
        }

        #expect(viewModel.sessions.first(where: { $0.key == "a" })?.unread == true)
        #expect(viewModel.sessions.first(where: { $0.key == "b" })?.pinned == true)
    }

    @Test func `mark unread wins over an older activation read`() async throws {
        let transport = UnreadTestTransport(
            sessions: [self.entry(key: "a", unread: true)],
            patchDelay: .milliseconds(50))
        let viewModel = self.viewModel(sessionKey: "a", transport: transport)

        viewModel.load()
        try await self.waitForUnreadState("activation read started") {
            await transport.unreadPatchStartCount() == 1
        }
        viewModel.setSessionUnread(key: "a", unread: true)
        try await self.waitForUnreadState("explicit unread mutation completed") {
            await transport.unreadPatchAttempts().count == 2
        }

        let attempts = await transport.unreadPatchAttempts()
        #expect(attempts.map(\.1) == [false, true])
        #expect(viewModel.sessions.first(where: { $0.key == "a" })?.unread == true)
    }

    @Test func `stale list does not undo pending explicit unread`() async throws {
        let transport = UnreadTestTransport(
            sessions: [self.entry(key: "a", unread: false)],
            patchDelay: .milliseconds(50))
        let viewModel = self.viewModel(sessionKey: "a", transport: transport)
        viewModel.refreshSessions()
        try await self.waitForUnreadState("initial session list loaded") {
            viewModel.sessions.count == 1
        }

        viewModel.setSessionUnread(key: "a", unread: true)
        viewModel.refreshSessions()
        try await self.waitForUnreadState("explicit unread mutation completed") {
            await transport.unreadPatchAttempts().count == 1
        }
        await transport.setSessions([self.entry(key: "a", unread: true)])
        viewModel.load()
        try await self.waitForUnreadState("reactivated session loaded") {
            !viewModel.isLoading && viewModel.sessionId == "session-a"
        }

        let attempts = await transport.unreadPatchAttempts()
        #expect(attempts.map(\.1) == [true])
    }

    @Test func `pending explicit unread overlays stale list until fresh observation`() async throws {
        let patchGate = UnreadPatchGate()
        let transport = UnreadTestTransport(
            sessions: [
                self.entry(key: "a", unread: false),
                self.entry(key: "b", unread: false),
            ],
            patchGate: patchGate)
        let viewModel = self.viewModel(sessionKey: "b", transport: transport)
        viewModel.refreshSessions()
        try await self.waitForUnreadState("pending unread session list loaded") {
            viewModel.sessions.count == 2
        }

        viewModel.setSessionUnread(key: "a", unread: true)
        try await self.waitForUnreadState("unread patch started") {
            await transport.unreadPatchStartCount() == 1
        }
        viewModel.refreshSessions()
        try await self.waitForUnreadState("stale list refresh completed") {
            await transport.listCallCount() >= 2
        }

        #expect(viewModel.sessions.first(where: { $0.key == "a" })?.unread == true)
        #expect(viewModel.unreadPatchGuard.localUnreadOverride(key: "a") == true)

        await patchGate.release()
        await transport.setSessions([
            self.entry(key: "a", unread: true),
            self.entry(key: "b", unread: false),
        ])
        let listCallCount = await transport.listCallCount()
        try await self.waitForUnreadState("unread patch completed") {
            await transport.unreadPatchAttempts().count == 1
        }
        try await self.waitForUnreadState("fresh unread observation applied") {
            await transport.listCallCount() > listCallCount &&
                viewModel.unreadPatchGuard.localUnreadOverride(key: "a") == nil
        }

        #expect(viewModel.unreadPatchGuard.localUnreadOverride(key: "a") == nil)
        #expect(viewModel.unreadPatchGuard.confirmedUnread(key: "a") == true)
        #expect(viewModel.sessions.first(where: { $0.key == "a" })?.unread == true)
    }

    private func viewModel(
        sessionKey: String,
        activeAgentID: String? = nil,
        transport: UnreadTestTransport) -> OpenClawChatViewModel
    {
        let defaults = UserDefaults(suiteName: "ChatViewModelUnreadTests.\(UUID().uuidString)") ?? .standard
        return OpenClawChatViewModel(
            sessionKey: sessionKey,
            transport: transport,
            activeAgentId: activeAgentID,
            modelPickerStore: ChatModelPickerStore(defaults: defaults))
    }

    private func entry(
        key: String,
        unread: Bool,
        updatedAt: Double = 1,
        markedUnreadAt: Double? = nil,
        lastInteractionAt: Double? = nil,
        lastActivityAt: Double? = nil,
        pinned: Bool? = nil) -> OpenClawChatSessionEntry
    {
        OpenClawChatSessionEntry(
            key: key,
            kind: nil,
            displayName: nil,
            surface: nil,
            subject: nil,
            room: nil,
            space: nil,
            updatedAt: updatedAt,
            sessionId: nil,
            systemSent: nil,
            abortedLastRun: nil,
            thinkingLevel: nil,
            verboseLevel: nil,
            inputTokens: nil,
            outputTokens: nil,
            totalTokens: nil,
            modelProvider: nil,
            model: nil,
            contextTokens: nil,
            pinned: pinned,
            unread: unread,
            markedUnreadAt: markedUnreadAt,
            lastInteractionAt: lastInteractionAt,
            lastActivityAt: lastActivityAt)
    }

    private func waitForUnreadState(
        _ label: String,
        condition: @escaping @MainActor @Sendable () async -> Bool) async throws
    {
        try await waitUntil(label) {
            await condition()
        }
    }
}
