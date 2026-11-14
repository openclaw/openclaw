import Foundation
import GRDB
import OpenClawKit
import Testing
@testable import OpenClawChatUI

private let draftKey = "agent:main:main"
private let rejectedError = "Run failed to start (error)."

private func queuedCommand(
    id: String,
    text: String,
    agentID: String = "main",
    attachments: [OpenClawChatOutboxAttachment] = [],
    createdAt: Double = Date().timeIntervalSince1970,
    status: OpenClawChatOutboxCommand.Status = .queued,
    retryCount: Int = 0,
    lastError: String? = nil) -> OpenClawChatOutboxCommand
{
    OpenClawChatOutboxCommand(
        id: id,
        sessionKey: "main",
        deliverySessionKey: "agent:\(agentID):main",
        routingContract: "per-sender|main|main",
        agentID: agentID,
        text: text,
        attachments: attachments,
        thinking: "off",
        expectedSessionSettings: OpenClawChatSessionSettingsExpectation(permissionMode: nil, toolOverrides: nil),
        createdAt: createdAt,
        status: status,
        retryCount: retryCount,
        lastError: lastError)
}

/// A row the Gateway rejected on its final attempt.
private func rejectedCommand(id: String, text: String, agentID: String = "main") -> OpenClawChatOutboxCommand {
    queuedCommand(
        id: id,
        text: text,
        agentID: agentID,
        status: .failed,
        retryCount: OpenClawChatViewModel.maxOutboxSendAttempts,
        lastError: rejectedError)
}

private func fileAttachment(_ name: String, bytes: Int) -> OpenClawChatOutboxAttachment {
    OpenClawChatOutboxAttachment(
        type: "file",
        mimeType: "application/octet-stream",
        fileName: name,
        data: Data(repeating: 7, count: bytes))
}

/// A canonical row, so history pages are complete rather than the empty
/// post-send page that proves nothing.
private func canonicalRow(_ text: String, idempotencyKey: String? = nil) -> AnyCodable {
    var row: [String: Any] = [
        "role": "assistant",
        "content": [["type": "text", "text": text]],
        "timestamp": 500.0,
    ]
    if let idempotencyKey {
        row["role"] = "user"
        row["__openclaw"] = ["idempotencyKey": idempotencyKey]
    }
    return AnyCodable(row)
}

/// Loads the visible session and its stored draft, so the composer is bound.
@MainActor
private func loadedModel(
    _ store: OpenClawChatSQLiteTranscriptCache,
    transport: OutboxTestTransport = OutboxTestTransport(healthy: false)) async throws -> OpenClawChatViewModel
{
    let vm = await makeOutboxViewModel(transport: transport, outbox: store)
    vm.load()
    await vm.bootstrapTask?.value
    try await waitForOutboxState { vm.hasRestoredOutboxMessages }
    await settleComposerDraft(vm)
    return vm
}

/// A healthy, visible chat whose history pages are complete.
@MainActor
private func presentedModel(_ store: OpenClawChatSQLiteTranscriptCache) async throws -> OpenClawChatViewModel {
    let transport = OutboxTestTransport(healthy: true)
    await transport.state.update { $0.staleHistoryRows = [canonicalRow("earlier answer")] }
    let vm = try await loadedModel(store, transport: transport)
    vm.setComposerPresentationActive(true)
    return vm
}

@MainActor
private func outboxMessageID(_ vm: OpenClawChatViewModel, text: String) throws -> UUID {
    try #require(vm.messages.first { message in
        vm.outboxState(for: message.id) != nil && message.content.contains { $0.text == text }
    }?.id)
}

/// Re-reads the outbox, as after another view's write, and runs its restore
/// pass to the end, including a move it starts.
@MainActor
private func presentOutbox(_ vm: OpenClawChatViewModel) async {
    await vm.restoreOutboxMessages(session: vm.currentSessionSnapshot())?.value
    await settleOutboxMoves(vm)
}

/// Waits for an Edit or restore already under way, and the draft writes it started.
@MainActor
private func settleOutboxMoves(_ vm: OpenClawChatViewModel) async {
    while !vm.cancelingOutboxCommandIDs.isEmpty {
        try? await Task.sleep(for: .milliseconds(5))
    }
    await settleComposerDraft(vm)
}

/// Runs a live history read for the visible session and the restore pass it ends with.
@MainActor
private func reloadHistory(_ vm: OpenClawChatViewModel, request: OpenClawChatViewModel.HistoryRequest? = nil) async {
    await vm.refreshHistoryAfterRun(historyRequest: request ?? vm.beginHistoryRequest())
    await presentOutbox(vm)
}

/// Lets every flush pass, including its post-flush history read, and the draft writes it started finish.
@MainActor
private func settleOutboxFlushes(_ vm: OpenClawChatViewModel) async {
    while let flush = vm.outboxFlushTask {
        await flush.value
        if vm.outboxFlushTask == flush { break }
    }
    await settleComposerDraft(vm)
}

/// Queues `text` offline, then lets the Gateway reject it on every attempt.
@MainActor
private func rejectOnEveryAttempt(
    _ text: String,
    in vm: OpenClawChatViewModel,
    transport: OutboxTestTransport,
    rejection: GatewayRejection = .errorAck,
    beforeReconnect: () async -> Void = {}) async throws -> UUID
{
    vm.input = text
    vm.send()
    try await waitForOutboxState { !vm.isSubmittingDraft }
    let messageID = try outboxMessageID(vm, text: text)
    await beforeReconnect()
    await transport.state.update {
        switch rejection {
        case .errorAck:
            $0.sendRejects = true
        case .responseError:
            $0.sendResponseErrors = true
        }
    }
    await transport.goOnline()
    try await waitForOutboxState { vm.outboxState(for: messageID)?.isFailed == true }
    await settleOutboxFlushes(vm)
    return messageID
}

enum GatewayRejection: String, CaseIterable, Sendable {
    case errorAck
    case responseError
}

enum AutoRestoreBlocker: String, CaseIterable, Sendable {
    case composerHasText
    case offScreen
    case incompletePage
}

extension ChatViewModelOutboxTests {
    @Test @MainActor func `edit moves a queued message into the composer and drops both bubbles`() async throws {
        let (store, _, databaseDirectory) = try makeOutboxStore()
        defer { try? FileManager.default.removeItem(at: databaseDirectory) }
        #expect(await store.enqueueCommand(queuedCommand(
            id: "queued", text: "queued text", attachments: [fileAttachment("photo.bin", bytes: 6)])))
        let editor = try await loadedModel(store)
        defer { editor.detachTransport() }
        let observer = try await loadedModel(store)
        defer { observer.detachTransport() }
        let messageID = try outboxMessageID(editor, text: "queued text")
        let observedID = try outboxMessageID(observer, text: "queued text")
        editor.input = "new thought"

        #expect(editor.canEditOutboxMessage(messageID))
        editor.editOutboxMessage(messageID)
        try await waitForOutboxState {
            !editor.messages.contains { $0.id == messageID } && !observer.messages.contains { $0.id == observedID }
        }
        await settleComposerDraft(editor)

        #expect(editor.input == "new thought\n\nqueued text")
        #expect(editor.attachments.map(\.fileName) == ["photo.bin"])
        #expect(await store.loadCommands().isEmpty)
        let draft = try #require(await store.loadComposerDraft(key: draftKey))
        #expect(draft.text == "new thought\n\nqueued text")
        #expect(draft.attachments.map(\.attachment.fileName) == ["photo.bin"])

        // The moved attachment belongs to the draft: removing it deletes its stored row.
        editor.attachments.removeAll()
        await settleComposerDraft(editor)
        #expect(await store.loadComposerDraft(key: draftKey)?.attachments.isEmpty == true)
    }

    @Test @MainActor func `edit after canonical proof confirms and leaves the composer alone`() async throws {
        let (store, _, databaseDirectory) = try makeOutboxStore()
        defer { try? FileManager.default.removeItem(at: databaseDirectory) }
        #expect(await store.enqueueCommand(queuedCommand(id: "landed", text: "landed text")))
        let vm = try await loadedModel(store)
        defer { vm.detachTransport() }
        let messageID = try outboxMessageID(vm, text: "landed text")
        vm.input = "typed"
        await vm.persistComposerDraft()
        store.observeCanonicalMessageIdempotencyKeys(["landed:user"])

        vm.editOutboxMessage(messageID)
        try await waitForOutboxState { vm.outboxState(for: messageID) == nil }
        await settleComposerDraft(vm)

        #expect(vm.input == "typed" && vm.attachments.isEmpty)
        #expect(await store.loadComposerDraft(key: draftKey)?.text == "typed")
        #expect(await store.loadCommands().isEmpty)
    }

    @Test @MainActor func `a row claimed before the edit lands keeps sending`() async throws {
        let (store, _, databaseDirectory) = try makeOutboxStore()
        defer { try? FileManager.default.removeItem(at: databaseDirectory) }
        #expect(await store.enqueueCommand(queuedCommand(id: "claimed", text: "claimed text")))
        let vm = try await loadedModel(store)
        defer { vm.detachTransport() }
        let messageID = try outboxMessageID(vm, text: "claimed text")
        #expect(vm.canEditOutboxMessage(messageID))
        // Another view model's flush claims the row after this menu was built.
        #expect(await store.claimNextCommand()?.id == "claimed")

        vm.editOutboxMessage(messageID)
        try await waitForOutboxState { vm.outboxState(for: messageID) == .sending }
        await settleComposerDraft(vm)

        #expect(vm.input.isEmpty)
        #expect(await store.loadCommands().map(\.status) == [.sending])
        #expect(await store.loadComposerDraft(key: draftKey) == .empty)
    }

    @Test @MainActor func `a session switch before the edit lands leaves both chats alone`() async throws {
        let (store, databases, databaseDirectory) = try makeOutboxStore()
        defer { try? FileManager.default.removeItem(at: databaseDirectory) }
        #expect(await store.enqueueCommand(queuedCommand(
            id: "failed", text: "chat A text", status: .failed, lastError: rejectedError)))
        let vm = try await loadedModel(store, transport: OutboxTestTransport(healthy: true))
        defer { vm.detachTransport() }
        let messageID = try outboxMessageID(vm, text: "chat A text")
        // The move lands only after the other chat has opened.
        let earlierWrite = OutboxTestGate()
        databases.composerDraftWrites.append { await earlierWrite.wait() }

        vm.editOutboxMessage(messageID)
        vm.switchSession(to: "other")
        await vm.bootstrapTask?.value
        vm.errorText = nil
        await earlierWrite.release()
        try await waitForOutboxState { vm.composerDraftKey == "agent:main:other" }
        await settleOutboxMoves(vm)

        #expect(vm.input.isEmpty)
        // The abandoned Edit says nothing in the chat it never reached.
        #expect(vm.errorText == nil)
        #expect(await store.loadComposerDraft(key: "agent:main:other") == .empty)
        #expect(await store.loadComposerDraft(key: draftKey) == .empty)
        #expect(await store.loadCommands().map(\.id) == ["failed"])
    }

    @Test @MainActor func `typing while a restore is on its way keeps the message out of the composer`() async throws {
        let (store, _, databaseDirectory) = try makeOutboxStore()
        defer { try? FileManager.default.removeItem(at: databaseDirectory) }
        let transport = OutboxTestTransport(healthy: true)
        await transport.state.update { $0.staleHistoryRows = [canonicalRow("earlier answer")] }
        let vm = try await loadedModel(store, transport: transport)
        defer { vm.detachTransport() }
        #expect(await store.enqueueCommand(rejectedCommand(id: "rejected", text: "rejected text")))
        await presentOutbox(vm)
        await reloadHistory(vm)
        #expect(vm.input.isEmpty)

        // Proof is in; coming on screen starts the restore, and the user types first.
        vm.setComposerPresentationActive(true)
        vm.input = "typed"
        await presentOutbox(vm)

        #expect(vm.input == "typed")
        #expect(vm.composerNotice == nil)
        #expect(await store.loadCommands().map(\.id) == ["rejected"])
    }

    @Test @MainActor func `a restore proved before the draft binds lands when it binds`() async throws {
        let (store, databases, databaseDirectory) = try makeOutboxStore()
        defer { try? FileManager.default.removeItem(at: databaseDirectory) }
        #expect(await store.enqueueCommand(rejectedCommand(id: "rejected", text: "rejected text")))
        let transport = OutboxTestTransport(healthy: true)
        await transport.state.update { $0.staleHistoryRows = [canonicalRow("earlier answer")] }
        // An earlier draft write holds the draft load, as a slow cold open would.
        let draftWrite = OutboxTestGate()
        databases.composerDraftWrites.append { await draftWrite.wait() }
        let vm = await makeOutboxViewModel(transport: transport, outbox: store)
        defer { vm.detachTransport() }
        vm.load()
        await vm.bootstrapTask?.value
        try await waitForOutboxState { vm.hasRestoredOutboxMessages }
        vm.setComposerPresentationActive(true)
        await vm.refreshHistoryAfterRun(historyRequest: vm.beginHistoryRequest())
        await vm.restoreOutboxMessages(session: vm.currentSessionSnapshot())?.value
        #expect(vm.composerDraftKey == nil && vm.input.isEmpty)

        await draftWrite.release()
        await vm.composerDraftSync.load?.value
        await settleOutboxMoves(vm)

        #expect(vm.input == "rejected text")
    }

    @Test @MainActor func `unconfirmed and branch-parked rows offer no edit`() async throws {
        let (store, _, databaseDirectory) = try makeOutboxStore()
        defer { try? FileManager.default.removeItem(at: databaseDirectory) }
        #expect(await store.enqueueCommand(queuedCommand(
            id: "unconfirmed",
            text: "unconfirmed text",
            status: .failed,
            lastError: OpenClawChatSQLiteTranscriptCache.outboxUnconfirmedError)))
        #expect(await store.enqueueCommand(rejectedCommand(id: "parked", text: "parked text")))
        let vm = try await loadedModel(store)
        defer { vm.detachTransport() }
        #expect(try !vm.canEditOutboxMessage(outboxMessageID(vm, text: "unconfirmed text")))
        #expect(try vm.canEditOutboxMessage(outboxMessageID(vm, text: "parked text")))

        _ = await store.confirmBranchChange(
            .init(sessionKey: "main", agentID: "main"), activeLeafEntryID: "leaf-2", lastError: rejectedError)
        await presentOutbox(vm)

        #expect(try !vm.canEditOutboxMessage(outboxMessageID(vm, text: "parked text")))
    }

    @Test @MainActor func `an edit over the draft budget refuses and keeps the row`() async throws {
        let (store, _, databaseDirectory) = try makeOutboxStore()
        defer { try? FileManager.default.removeItem(at: databaseDirectory) }
        let megabyte = 1_000_000
        #expect(await store.enqueueCommand(queuedCommand(
            id: "big", text: "big text", attachments: [fileAttachment("more.mov", bytes: 15 * megabyte)])))
        let vm = try await loadedModel(store)
        defer { vm.detachTransport() }
        let messageID = try outboxMessageID(vm, text: "big text")
        vm.attachments.append(OpenClawPendingAttachment(
            url: nil,
            data: Data(repeating: 1, count: 30 * megabyte),
            fileName: "big.mov",
            mimeType: "video/quicktime",
            preview: nil))
        await settleComposerDraft(vm)

        vm.editOutboxMessage(messageID)
        try await waitForOutboxState { vm.errorText == "Too large to send: more.mov" }
        await settleComposerDraft(vm)

        #expect(vm.input.isEmpty && vm.attachments.map(\.fileName) == ["big.mov"])
        #expect(vm.outboxState(for: messageID) == .queued)
        #expect(await store.loadCommands().map(\.id) == ["big"])
        #expect(await store.loadComposerDraft(key: draftKey)?.attachments.map(\.attachment.fileName) == ["big.mov"])
    }

    @Test(arguments: GatewayRejection.allCases)
    @MainActor
    func `a rejected message returns to an idle visible composer`(rejection: GatewayRejection) async throws {
        let (store, _, databaseDirectory) = try makeOutboxStore()
        defer { try? FileManager.default.removeItem(at: databaseDirectory) }
        let transport = OutboxTestTransport(healthy: false)
        await transport.state.update { $0.staleHistoryRows = [canonicalRow("earlier answer")] }
        let vm = try await loadedModel(store, transport: transport)
        defer { vm.detachTransport() }
        vm.setComposerPresentationActive(true)

        let messageID = try await rejectOnEveryAttempt("doomed", in: vm, transport: transport, rejection: rejection)
        try await waitForOutboxState { vm.input == "doomed" && !vm.messages.contains { $0.id == messageID } }
        await settleComposerDraft(vm)

        let notice = try #require(vm.composerNotice)
        if rejection == .errorAck {
            #expect(notice == "Not sent: Run failed to start (error). Your message is back in the composer.")
        }
        #expect(await store.loadCommands().isEmpty)
        #expect(await store.loadComposerDraft(key: draftKey)?.text == "doomed")

        // The next edit retires the notice.
        vm.input += " again"
        #expect(vm.composerNotice == nil)
    }

    @Test(arguments: AutoRestoreBlocker.allCases)
    @MainActor
    func `a rejected message stays put without proof and an idle visible composer`(
        blocker: AutoRestoreBlocker) async throws
    {
        let (store, _, databaseDirectory) = try makeOutboxStore()
        defer { try? FileManager.default.removeItem(at: databaseDirectory) }
        let transport = OutboxTestTransport(healthy: false)
        if blocker != .incompletePage {
            await transport.state.update { $0.staleHistoryRows = [canonicalRow("earlier answer")] }
        }
        let vm = try await loadedModel(store, transport: transport)
        defer { vm.detachTransport() }
        if blocker != .offScreen {
            vm.setComposerPresentationActive(true)
        }

        let messageID = try await rejectOnEveryAttempt("doomed", in: vm, transport: transport) {
            if blocker == .composerHasText {
                vm.input = "something else"
            }
        }
        await presentOutbox(vm)

        #expect(vm.input == (blocker == .composerHasText ? "something else" : ""))
        #expect(vm.outboxState(for: messageID)?.isFailed == true)
        #expect(vm.composerNotice == nil)
        #expect(await store.loadCommands().map(\.text) == ["doomed"])
        switch blocker {
        case .offScreen:
            // Coming on screen completes the restore the proof already allowed.
            vm.setComposerPresentationActive(true)
            try await waitForOutboxState { vm.input == "doomed" }
        case .incompletePage:
            // The next complete page is the proof.
            await transport.state.update { $0.staleHistoryRows = [canonicalRow("earlier answer")] }
            await reloadHistory(vm)
            try await waitForOutboxState { vm.input == "doomed" }
        case .composerHasText:
            break
        }
    }

    @Test @MainActor func `history requested before the failure was seen proves nothing`() async throws {
        let (store, databases, databaseDirectory) = try makeOutboxStore()
        defer { try? FileManager.default.removeItem(at: databaseDirectory) }
        let transport = OutboxTestTransport(healthy: false)
        await transport.state.update { $0.staleHistoryRows = [canonicalRow("earlier answer")] }
        let vm = try await loadedModel(store, transport: transport)
        defer { vm.detachTransport() }
        vm.setComposerPresentationActive(true)
        #expect(await store.enqueueCommand(queuedCommand(id: "pending", text: "pending text")))
        await presentOutbox(vm)
        // History answers, but this view never flushes: another one owns the send.
        await transport.state.update { $0.healthy = true }
        let earlier = vm.beginHistoryRequest()
        // That send is rejected on its final attempt after this read was requested.
        try await databases.stateQueue.write { db in
            try db.execute(
                sql: "UPDATE outbox_commands SET status = 'failed', retry_count = ?, last_error = ?",
                arguments: [OpenClawChatViewModel.maxOutboxSendAttempts, rejectedError])
        }
        await presentOutbox(vm)

        await reloadHistory(vm, request: earlier)
        #expect(vm.input.isEmpty)

        await reloadHistory(vm)
        try await waitForOutboxState { vm.input == "pending text" }
    }

    @Test @MainActor func `history requested before a connection change proves nothing`() async throws {
        let (store, _, databaseDirectory) = try makeOutboxStore()
        defer { try? FileManager.default.removeItem(at: databaseDirectory) }
        let vm = try await presentedModel(store)
        defer { vm.detachTransport() }
        #expect(await store.enqueueCommand(rejectedCommand(id: "rejected", text: "rejected text")))
        await presentOutbox(vm)
        let beforeReconnect = vm.beginHistoryRequest()
        vm.applyTransportHealth(false)
        vm.applyTransportHealth(true)

        await reloadHistory(vm, request: beforeReconnect)
        #expect(vm.input.isEmpty)

        await reloadHistory(vm)
        try await waitForOutboxState { vm.input == "rejected text" }
    }

    @Test @MainActor func `a turn history already showed is never restored`() async throws {
        let (store, _, databaseDirectory) = try makeOutboxStore()
        defer { try? FileManager.default.removeItem(at: databaseDirectory) }
        let transport = OutboxTestTransport(healthy: true)
        await transport.state.update { $0.staleHistoryRows = [canonicalRow("landed", idempotencyKey: "landed:user")] }
        let vm = try await loadedModel(store, transport: transport)
        defer { vm.detachTransport() }
        vm.setComposerPresentationActive(true)
        // A later page scrolled the turn out; the row was written by another view.
        await transport.state.update { $0.staleHistoryRows = [canonicalRow("earlier answer")] }
        #expect(await store.enqueueCommand(rejectedCommand(id: "landed", text: "landed")))
        await presentOutbox(vm)

        await reloadHistory(vm)
        await reloadHistory(vm)

        #expect(vm.input.isEmpty)
        #expect(await store.loadComposerDraft(key: draftKey) == .empty)
    }

    @Test @MainActor func `another agent's rejected row neither restores here nor blocks one that can`() async throws {
        let (store, _, databaseDirectory) = try makeOutboxStore()
        defer { try? FileManager.default.removeItem(at: databaseDirectory) }
        #expect(await store.enqueueCommand(rejectedCommand(id: "other", text: "other agent text", agentID: "other")))
        #expect(await store.enqueueCommand(rejectedCommand(id: "mine", text: "my text")))
        let vm = try await presentedModel(store)
        defer { vm.detachTransport() }
        let otherID = try outboxMessageID(vm, text: "other agent text")

        await reloadHistory(vm)

        #expect(vm.input == "my text")
        #expect(vm.outboxState(for: otherID)?.isFailed == true)
        #expect(vm.canEditOutboxMessage(otherID))
    }

    @Test @MainActor func `a lagging page that misses a live answer proves nothing`() async throws {
        let (store, _, databaseDirectory) = try makeOutboxStore()
        defer { try? FileManager.default.removeItem(at: databaseDirectory) }
        let vm = try await presentedModel(store)
        defer { vm.detachTransport() }
        #expect(await store.enqueueCommand(rejectedCommand(id: "rejected", text: "rejected text")))
        await presentOutbox(vm)
        // A live answer arrives after the failed bubble; the next page predates it.
        vm.replaceMessages(vm.messages + [OpenClawChatMessage(
            role: "assistant",
            content: [OpenClawChatMessageContent(type: "text", text: "live answer")],
            timestamp: Date().timeIntervalSince1970 * 1000)])

        await reloadHistory(vm)

        #expect(vm.input.isEmpty)
        #expect(await store.loadComposerDraft(key: draftKey) == .empty)
    }

    @Test(arguments: [false, true])
    @MainActor
    func `an empty delta proves absence unless an earlier page showed the turn`(earlierShowed: Bool) async throws {
        let (store, _, databaseDirectory) = try makeOutboxStore()
        defer { try? FileManager.default.removeItem(at: databaseDirectory) }
        let transport = OutboxTestTransport(healthy: true)
        let rows = earlierShowed
            ? [canonicalRow("earlier answer"), canonicalRow("landed", idempotencyKey: "landed:user")]
            : [canonicalRow("earlier answer")]
        await transport.state.update {
            $0.staleHistoryRows = rows
            $0.historyDeltaCursor = "tip"
        }
        let vm = try await loadedModel(store, transport: transport)
        defer { vm.detachTransport() }
        vm.setComposerPresentationActive(true)
        #expect(await store.enqueueCommand(rejectedCommand(id: "landed", text: "landed text")))
        await presentOutbox(vm)

        // The next read is a delta at the same tip.
        await reloadHistory(vm)

        #expect(vm.input == (earlierShowed ? "" : "landed text"))
    }

    @Test @MainActor func `an expired message that never left the device returns to the composer`() async throws {
        let (store, _, databaseDirectory) = try makeOutboxStore()
        defer { try? FileManager.default.removeItem(at: databaseDirectory) }
        #expect(await store.enqueueCommand(queuedCommand(
            id: "stale",
            text: "stale text",
            createdAt: Date().timeIntervalSince1970 - OpenClawChatSQLiteTranscriptCache.outboxCommandMaxAge - 60)))
        let vm = try await presentedModel(store)
        defer { vm.detachTransport() }

        await reloadHistory(vm)
        try await waitForOutboxState { vm.input == "stale text" }

        #expect(vm.composerNotice == "Not sent: Queued for more than 48 hours. Your message is back in the composer.")
        #expect(await store.loadCommands().isEmpty)
    }
}
