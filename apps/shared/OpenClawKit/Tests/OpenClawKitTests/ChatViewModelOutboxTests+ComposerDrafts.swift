import Foundation
import Testing
@testable import OpenClawChatUI

/// Waits for the draft load and every draft write started so far.
@MainActor
func settleComposerDraft(_ vm: OpenClawChatViewModel) async {
    await vm.composerDraftSync.load?.value
    await vm.composerDraftWrites?.value
}

@MainActor
private func composerDraftModel(
    _ outbox: OpenClawChatSQLiteTranscriptCache,
    healthy: Bool = false,
    activeAgentID: String? = "main",
    sessionRoutingContract: String? = "per-sender|main|main") async -> OpenClawChatViewModel
{
    await makeOutboxViewModel(
        transport: OutboxTestTransport(healthy: healthy),
        outbox: outbox,
        activeAgentID: activeAgentID,
        sessionRoutingContract: sessionRoutingContract)
}

@MainActor
private func saveDraftThroughComposer(_ text: String, in store: OpenClawChatSQLiteTranscriptCache) async {
    let writer = await composerDraftModel(store)
    await settleComposerDraft(writer)
    writer.input = text
    writer.detachTransport()
    await settleComposerDraft(writer)
}

/// SQLite rejects inserts into `table` on the store's own connection until the trigger is dropped.
private func setDraftWritesFail(_ fail: Bool, table: String, in databases: OpenClawClientDatabases) async throws {
    try await databases.stateQueue.write { db in
        try db.execute(sql: fail
            ? """
            CREATE TEMP TRIGGER fail_\(table) BEFORE INSERT ON main.\(table)
            BEGIN SELECT RAISE(ABORT, 'draft write failed'); END
            """
            : "DROP TRIGGER temp.fail_\(table)")
    }
}

extension ChatViewModelOutboxTests {
    @Test @MainActor func `draft and attachment survive a rebuilt view model over the same database`() async throws {
        let (store, databases, databaseDirectory) = try makeOutboxStore()
        defer { try? FileManager.default.removeItem(at: databaseDirectory) }
        let bytes = Data("png bytes".utf8)
        let first = await composerDraftModel(store)
        await settleComposerDraft(first)
        first.input = "half-written thought"
        first.attachments.append(OpenClawPendingAttachment(
            url: nil, data: bytes, fileName: "photo.png", mimeType: "image/png", preview: nil))
        first.detachTransport()
        await settleComposerDraft(first)
        try databases.close()

        let reopened = try OpenClawClientDatabases(directoryURL: databaseDirectory)
        defer { try? reopened.close() }
        let second = await composerDraftModel(reopened.store(gatewayID: store.gatewayID))
        defer { second.detachTransport() }
        await settleComposerDraft(second)
        #expect(second.input == "half-written thought")
        #expect(second.attachments.map(\.fileName) == ["photo.png"])
        #expect(second.attachments.map(\.data) == [bytes])
    }

    @Test(arguments: [false, true])
    @MainActor
    func `a send clears its saved draft without waiting for the save pause`(healthy: Bool) async throws {
        let (store, _, databaseDirectory) = try makeOutboxStore()
        defer { try? FileManager.default.removeItem(at: databaseDirectory) }
        let vm = await composerDraftModel(store, healthy: healthy)
        defer { vm.detachTransport() }
        vm.load()
        await vm.bootstrapTask?.value
        try await waitForOutboxState { vm.hasRestoredOutboxMessages }
        await settleComposerDraft(vm)
        vm.input = "saved, then sent"
        vm.flushComposerDraftText()
        await settleComposerDraft(vm)
        #expect(await store.loadComposerDraft(key: "agent:main:main")?.text == "saved, then sent")

        vm.send()
        try await waitForOutboxState { !vm.isSubmittingDraft }
        await settleComposerDraft(vm)

        #expect(vm.input.isEmpty)
        #expect(await store.loadComposerDraft(key: "agent:main:main") == .empty)
    }

    @Test @MainActor func `a send captured before its draft loads clears the composer`() async throws {
        let (store, _, databaseDirectory) = try makeOutboxStore()
        defer { try? FileManager.default.removeItem(at: databaseDirectory) }
        await saveDraftThroughComposer("stored draft", in: store)

        let vm = await composerDraftModel(store)
        defer { vm.detachTransport() }
        vm.input = "quick prompt"
        vm.send()
        try await waitForOutboxState { !vm.isSubmittingDraft }
        await settleComposerDraft(vm)

        #expect(await store.loadCommands().map(\.text) == ["quick prompt"])
        #expect(vm.input == "stored draft")
        #expect(await store.loadComposerDraft(key: "agent:main:main")?.text == "stored draft")
    }

    @Test @MainActor func `text typed before the draft loads survives a switch away and back`() async throws {
        let (store, _, databaseDirectory) = try makeOutboxStore()
        defer { try? FileManager.default.removeItem(at: databaseDirectory) }
        await saveDraftThroughComposer("stored draft", in: store)

        let vm = await composerDraftModel(store)
        defer { vm.detachTransport() }
        vm.input = "typed before load"
        vm.switchSession(to: "agent:main:other")
        #expect(vm.input.isEmpty)
        await settleComposerDraft(vm)
        vm.switchSession(to: "main")
        await settleComposerDraft(vm)

        #expect(vm.input == "stored draft\n\ntyped before load")
    }

    @Test @MainActor func `a draft bound through the agent catalog keeps saving after the catalog resets`() async throws {
        let (store, _, databaseDirectory) = try makeOutboxStore()
        defer { try? FileManager.default.removeItem(at: databaseDirectory) }
        let vm = await composerDraftModel(store, activeAgentID: nil, sessionRoutingContract: nil)
        defer { vm.detachTransport() }
        vm.agentCatalog = OpenClawChatAgentsListResponse(
            defaultId: "main", agents: [], sessionRoutingContract: "per-sender|main|main")
        vm.syncComposerDraftKey()
        await settleComposerDraft(vm)
        vm.input = "before the reset"
        vm.flushComposerDraftText()
        await settleComposerDraft(vm)

        // Reconnect clears the catalog, so the live key falls back to the bare alias.
        vm.invalidateAgentCatalog(clear: true)
        vm.input = "after the reset"
        vm.flushComposerDraftText()
        await settleComposerDraft(vm)

        #expect(await store.loadComposerDraft(key: "agent:main:main")?.text == "after the reset")
    }

    @Test @MainActor func `a replacement model reads the draft its predecessor was still writing`() async throws {
        let (store, _, databaseDirectory) = try makeOutboxStore()
        defer { try? FileManager.default.removeItem(at: databaseDirectory) }
        let first = await composerDraftModel(store)
        await settleComposerDraft(first)
        first.attachments.append(OpenClawPendingAttachment(
            url: nil, data: Data([7]), fileName: "photo.png", mimeType: "image/png", preview: nil))
        first.input = "typed just before the rebuild"
        first.detachTransport()

        let second = await composerDraftModel(store)
        defer { second.detachTransport() }
        await settleComposerDraft(second)
        #expect(second.input == "typed just before the rebuild")
        #expect(second.attachments.map(\.fileName) == ["photo.png"])
    }

    @Test @MainActor func `load gate appends input typed before the stored draft loads`() async throws {
        let (store, _, databaseDirectory) = try makeOutboxStore()
        defer { try? FileManager.default.removeItem(at: databaseDirectory) }
        await saveDraftThroughComposer("stored draft", in: store)

        let vm = await composerDraftModel(store)
        vm.input = "typed before load"
        await settleComposerDraft(vm)
        #expect(vm.input == "stored draft\n\ntyped before load")
        vm.detachTransport()
        await settleComposerDraft(vm)

        let rebuilt = await composerDraftModel(store)
        defer { rebuilt.detachTransport() }
        await settleComposerDraft(rebuilt)
        #expect(rebuilt.input == "stored draft\n\ntyped before load")
    }

    @Test @MainActor func `cold launch waits for the agent and routing before touching the draft`() async throws {
        let (store, _, databaseDirectory) = try makeOutboxStore()
        defer { try? FileManager.default.removeItem(at: databaseDirectory) }
        await saveDraftThroughComposer("stored draft", in: store)

        let vm = await composerDraftModel(store, activeAgentID: nil, sessionRoutingContract: nil)
        defer { vm.detachTransport() }
        vm.input = "typed offline"
        vm.syncActiveAgentId("main")
        vm.flushComposerDraftText()
        await settleComposerDraft(vm)
        // `main` is an alias until the routing contract is known.
        #expect(vm.input == "typed offline")
        #expect(await store.loadComposerDraft(key: "agent:main:main")?.text == "stored draft")
        #expect(await store.loadComposerDraft(key: "main") == .empty)

        vm.syncSessionRoutingContract("per-sender|main|main")
        await settleComposerDraft(vm)
        #expect(vm.input == "stored draft\n\ntyped offline")
        #expect(await store.loadComposerDraft(key: "agent:main:main")?.text == "stored draft\n\ntyped offline")
    }

    @Test @MainActor func `attachments stay with their session draft across switches`() async throws {
        let (store, _, databaseDirectory) = try makeOutboxStore()
        defer { try? FileManager.default.removeItem(at: databaseDirectory) }
        let vm = await composerDraftModel(store)
        defer { vm.detachTransport() }
        await settleComposerDraft(vm)
        vm.input = "caption for main"
        vm.attachments.append(OpenClawPendingAttachment(
            url: nil, data: Data([1, 2]), fileName: "main.png", mimeType: "image/png", preview: nil))
        await settleComposerDraft(vm)

        vm.switchSession(to: "agent:main:other")
        #expect(vm.sessionKey == "agent:main:other")
        #expect(vm.input.isEmpty && vm.attachments.isEmpty)
        await settleComposerDraft(vm)
        vm.switchSession(to: "main")
        await settleComposerDraft(vm)
        #expect(vm.input == "caption for main")
        #expect(vm.attachments.map(\.fileName) == ["main.png"])
    }

    @Test @MainActor func `a failed text save is retried by the next flush`() async throws {
        let (store, databases, databaseDirectory) = try makeOutboxStore()
        defer { try? FileManager.default.removeItem(at: databaseDirectory) }
        let vm = await composerDraftModel(store)
        defer { vm.detachTransport() }
        await settleComposerDraft(vm)
        try await setDraftWritesFail(true, table: "composer_drafts", in: databases)
        vm.input = "typed while storage failed"
        vm.flushComposerDraftText()
        await settleComposerDraft(vm)
        #expect(await store.loadComposerDraft(key: "agent:main:main") == .empty)

        try await setDraftWritesFail(false, table: "composer_drafts", in: databases)
        vm.flushComposerDraftText()
        await settleComposerDraft(vm)
        #expect(await store.loadComposerDraft(key: "agent:main:main")?.text == "typed while storage failed")
    }

    @Test @MainActor func `a failed text save survives a switch away and back`() async throws {
        let (store, databases, databaseDirectory) = try makeOutboxStore()
        defer { try? FileManager.default.removeItem(at: databaseDirectory) }
        let vm = await composerDraftModel(store)
        defer { vm.detachTransport() }
        await settleComposerDraft(vm)
        vm.input = "first version"
        vm.flushComposerDraftText()
        await settleComposerDraft(vm)
        try await setDraftWritesFail(true, table: "composer_drafts", in: databases)
        vm.input = "second version"

        vm.switchSession(to: "agent:main:other")
        await settleComposerDraft(vm)
        #expect(vm.input.isEmpty)
        try await setDraftWritesFail(false, table: "composer_drafts", in: databases)
        vm.switchSession(to: "main")
        await settleComposerDraft(vm)

        // Newer than the stored row, so it replaces it instead of being appended.
        #expect(vm.input == "second version")
        #expect(await store.loadComposerDraft(key: "agent:main:main")?.text == "second version")
    }

    @Test @MainActor func `a failed attachment save keeps the attachment and blocks a switch`() async throws {
        let (store, databases, databaseDirectory) = try makeOutboxStore()
        defer { try? FileManager.default.removeItem(at: databaseDirectory) }
        let vm = await composerDraftModel(store)
        defer { vm.detachTransport() }
        await settleComposerDraft(vm)
        try await setDraftWritesFail(true, table: "composer_draft_attachments", in: databases)
        vm.attachments.append(OpenClawPendingAttachment(
            url: nil, data: Data([3]), fileName: "photo.png", mimeType: "image/png", preview: nil))
        await settleComposerDraft(vm)
        #expect(vm.errorText == "Could not save photo.png with this draft. Send or remove it before switching chats.")

        vm.switchSession(to: "agent:main:other")
        #expect(vm.sessionKey == "main")
        #expect(vm.attachments.map(\.fileName) == ["photo.png"])

        try await setDraftWritesFail(false, table: "composer_draft_attachments", in: databases)
        vm.flushComposerDraftText()
        await settleComposerDraft(vm)
        vm.switchSession(to: "agent:main:other")
        #expect(vm.sessionKey == "agent:main:other")
        #expect(await store.loadComposerDraft(key: "agent:main:main")?.attachments.count == 1)
    }
}
