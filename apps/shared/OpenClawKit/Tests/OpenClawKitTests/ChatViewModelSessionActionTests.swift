import Foundation
import OpenClawKit
import Testing
@testable import OpenClawChatUI

private actor SessionActionTransportState {
    var forkedParentKeys: [String] = []
    var patchedKeys: [String] = []
    var deletedKeys: [String] = []
    var groupPuts: [[String]] = []
    var createdAgentIDs: [String?] = []
    var createdParentKeys: [String?] = []

    func recordFork(_ key: String) {
        self.forkedParentKeys.append(key)
    }

    func recordPatch(_ key: String) {
        self.patchedKeys.append(key)
    }

    func recordGroupPut(_ names: [String]) {
        self.groupPuts.append(names)
    }

    func recordDelete(_ key: String) {
        self.deletedKeys.append(key)
    }

    func recordCreate(agentID: String?, parentKey: String?) {
        self.createdAgentIDs.append(agentID)
        self.createdParentKeys.append(parentKey)
    }
}

private final class SessionActionTransport: @unchecked Sendable, OpenClawChatTransport {
    private let state = SessionActionTransportState()
    private let forkDelay: Duration?

    init(forkDelay: Duration? = nil) {
        self.forkDelay = forkDelay
    }

    func requestHistory(sessionKey: String) async throws -> OpenClawChatHistoryPayload {
        OpenClawChatHistoryPayload(
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
        throw NSError(domain: "SessionActionTransport", code: 1)
    }

    func forkSession(parentKey: String) async throws -> String {
        await self.state.recordFork(parentKey)
        if let forkDelay {
            try await Task.sleep(for: forkDelay)
        }
        return "forked"
    }

    func patchSession(
        key: String,
        label _: String??,
        category _: String??,
        pinned _: Bool?,
        archived _: Bool?,
        unread _: Bool?) async throws
    {
        await self.state.recordPatch(key)
    }

    func acquireSessionGroupsRouteLease() async -> OpenClawChatSessionGroupsRouteLease? {
        let state = self.state
        return OpenClawChatSessionGroupsRouteLease(
            listGroups: {
                OpenClawChatSessionGroupsResponse(groups: [
                    OpenClawChatSessionGroup(name: "Existing", position: 0),
                ])
            },
            putGroups: { names in
                await state.recordGroupPut(names)
                return OpenClawChatSessionGroupsMutationResponse(
                    ok: true,
                    groups: names.enumerated().map {
                        OpenClawChatSessionGroup(name: $0.element, position: $0.offset)
                    })
            },
            renameGroup: { _, _ in
                OpenClawChatSessionGroupsMutationResponse(ok: true, groups: [])
            },
            deleteGroup: { _ in
                OpenClawChatSessionGroupsMutationResponse(ok: true, groups: [])
            })
    }

    func acquireNewSessionRouteLease() async -> OpenClawChatNewSessionRouteLease? {
        let state = self.state
        return OpenClawChatNewSessionRouteLease(
            listAgents: {
                OpenClawChatAgentsListResponse(
                    defaultId: "worker",
                    agents: [OpenClawChatAgentChoice(id: "worker", workspaceGit: true)])
            },
            createSession: { key, _, agentID, parentKey, _, _ in
                await state.recordCreate(agentID: agentID, parentKey: parentKey)
                return OpenClawChatCreateSessionResponse(ok: true, key: key, sessionId: nil)
            })
    }

    func deleteSession(key: String) async throws {
        await self.state.recordDelete(key)
    }

    func requestHealth(timeoutMs _: Int) async throws -> Bool {
        true
    }

    func events() -> AsyncStream<OpenClawChatTransportEvent> {
        AsyncStream { $0.finish() }
    }

    func forkedParentKeys() async -> [String] {
        await self.state.forkedParentKeys
    }

    func patchedKeys() async -> [String] {
        await self.state.patchedKeys
    }

    func groupPuts() async -> [[String]] {
        await self.state.groupPuts
    }

    func deletedKeys() async -> [String] {
        await self.state.deletedKeys
    }

    func createdAgentIDs() async -> [String?] {
        await self.state.createdAgentIDs
    }

    func createdParentKeys() async -> [String?] {
        await self.state.createdParentKeys
    }
}

private actor BatchMutationProbe {
    private(set) var active = 0
    private(set) var maximumActive = 0
    private(set) var visited: [String] = []

    func begin(_ key: String) {
        self.active += 1
        self.maximumActive = max(self.maximumActive, self.active)
        self.visited.append(key)
    }

    func end() {
        self.active -= 1
    }
}

private struct BatchTestError: LocalizedError {
    var errorDescription: String? {
        "rejected"
    }
}

@MainActor
struct ChatViewModelSessionActionTests {
    @Test func `batch mutations continue after per-row failure with bounded fan-out`() async {
        let probe = BatchMutationProbe()
        let result = await ChatSessionBatchMutationRunner.run(
            keys: ["a", "b", "c", "d", "e"],
            maxConcurrent: 2)
        { key in
            await probe.begin(key)
            try? await Task.sleep(for: .milliseconds(10))
            await probe.end()
            if key == "c" { throw BatchTestError() }
        }

        #expect(result.succeededKeys == ["a", "b", "d", "e"])
        #expect(result.errorsByKey == ["c": "rejected"])
        #expect(await probe.maximumActive == 2)
        #expect(await Set(probe.visited) == Set(["a", "b", "c", "d", "e"]))
    }

    @Test func `batch mutation includes selected server-search entry outside live roster`() async {
        let transport = SessionActionTransport()
        let viewModel = OpenClawChatViewModel(sessionKey: "main", transport: transport)
        let searchResult = self.entry(key: "older-search-result")

        let result = await viewModel.performSessionBatch(sessions: [searchResult], action: .pin)

        #expect(result.succeededKeys == ["older-search-result"])
        #expect(result.errorsByKey.isEmpty)
        #expect(await transport.patchedKeys() == ["older-search-result"])
    }

    @Test func `group create lists and replaces through one captured route lease`() async throws {
        let transport = SessionActionTransport()
        let viewModel = OpenClawChatViewModel(sessionKey: "main", transport: transport)
        let lease = try await viewModel.sessionGroupsRouteLease()

        let groups = try await viewModel.createSessionGroup(named: "New", using: lease)

        #expect(groups.map(\.name) == ["Existing", "New"])
        #expect(await transport.groupPuts() == [["Existing", "New"]])
        // Catalog-only mutations must bump the revision so sidebar group fetches
        // keyed on it refetch instead of staying stale until reconnect.
        #expect(viewModel.sessionGroupsRevision == 1)
    }

    @Test func `batch delete rejects current session while attachment owner is pinned`() async {
        let transport = SessionActionTransport()
        let viewModel = OpenClawChatViewModel(sessionKey: "worker", transport: transport)
        viewModel.attachments = [OpenClawPendingAttachment(
            url: nil,
            data: Data([1]),
            fileName: "draft.png",
            mimeType: "image/png",
            preview: nil)]

        let result = await viewModel.performSessionBatch(
            sessions: [self.entry(key: "worker")],
            action: .delete)

        #expect(result.succeededKeys.isEmpty)
        #expect(result.errorsByKey["worker"] != nil)
        #expect(await transport.deletedKeys().isEmpty)
    }

    @Test func `new session options list and create through one captured route lease`() async throws {
        let transport = SessionActionTransport()
        let viewModel = OpenClawChatViewModel(sessionKey: "main", transport: transport)
        let lease = try await viewModel.newSessionRouteLease()
        let response = try await lease.listAgents()

        await viewModel.startNewSession(
            agentID: response?.defaultId ?? "",
            worktree: true,
            worktreeBaseRef: "main",
            using: lease)

        #expect(await transport.createdAgentIDs() == ["worker"])
    }

    @Test func `ambiguous agent ownership omits the parent session`() async throws {
        let transport = SessionActionTransport()
        let viewModel = OpenClawChatViewModel(sessionKey: "main", transport: transport)
        // Roster entries must not decide the current agent: "main" is unscoped and
        // no active agent is set, so agent selection crosses an ownership boundary.
        viewModel.sessions = [self.entry(key: "agent:worker:main")]
        let lease = try await viewModel.newSessionRouteLease()

        await viewModel.startNewSession(
            agentID: "worker",
            worktree: false,
            worktreeBaseRef: nil,
            using: lease)

        #expect(await transport.createdParentKeys() == [nil])
    }

    @Test func `active agent identity preserves parent for an unscoped current key`() async throws {
        let transport = SessionActionTransport()
        let viewModel = OpenClawChatViewModel(
            sessionKey: "main",
            transport: transport,
            activeAgentId: "worker")
        let lease = try await viewModel.newSessionRouteLease()

        await viewModel.startNewSession(
            agentID: "worker",
            worktree: false,
            worktreeBaseRef: nil,
            using: lease)

        #expect(await transport.createdParentKeys() == ["main"])
    }

    @Test func `fork does not mutate gateway while session switching is blocked`() async {
        let transport = SessionActionTransport()
        let viewModel = OpenClawChatViewModel(sessionKey: "main", transport: transport)
        viewModel.attachments = [OpenClawPendingAttachment(
            url: nil,
            data: Data([1]),
            fileName: "draft.png",
            mimeType: "image/png",
            preview: nil)]

        await viewModel.forkSession(key: "main")

        let forkedKeys = await transport.forkedParentKeys()
        #expect(forkedKeys.isEmpty)
        #expect(viewModel.sessionKey == "main")
        #expect(viewModel.errorText == String(
            localized: "Remove attachments or wait for delivery to resolve before starting a new chat."))
    }

    @Test func `fork completion does not override newer navigation`() async throws {
        let transport = SessionActionTransport(forkDelay: .milliseconds(50))
        let viewModel = OpenClawChatViewModel(sessionKey: "main", transport: transport)

        let fork = Task { await viewModel.forkSession(key: "main") }
        try await self.waitUntil { await transport.forkedParentKeys() == ["main"] }
        viewModel.switchSession(to: "other")
        await fork.value

        #expect(viewModel.sessionKey == "other")
    }

    private func waitUntil(
        timeout: Duration = .seconds(2),
        condition: @escaping @MainActor () async -> Bool) async throws
    {
        let clock = ContinuousClock()
        let deadline = clock.now.advanced(by: timeout)
        while clock.now < deadline {
            if await condition() { return }
            try await Task.sleep(for: .milliseconds(10))
        }
        Issue.record("timed out waiting for session action condition")
    }

    private func entry(key: String) -> OpenClawChatSessionEntry {
        OpenClawChatSessionEntry(
            key: key,
            kind: nil,
            displayName: nil,
            surface: nil,
            subject: nil,
            room: nil,
            space: nil,
            updatedAt: nil,
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
            contextTokens: nil)
    }
}
