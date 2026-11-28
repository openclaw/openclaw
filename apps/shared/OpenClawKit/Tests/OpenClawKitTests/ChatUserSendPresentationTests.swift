#if os(iOS)
import Foundation
import Testing
@testable import OpenClawChatUI

@Suite(.timeLimit(.minutes(1)))
@MainActor
struct ChatUserSendPresentationTests {
    @Test(arguments: [
        (OpenClawChatQueueMode?.some(.followup), "steer", true),
        (.steer, "followup", false),
        (nil, "followup", true),
        (nil, "steer", false),
    ])
    func `busy message keeps its send phase until history confirms`(
        mode: OpenClawChatQueueMode?, sessionMode: String, waitsForReply: Bool) async throws
    {
        let (store, databases, directory) = try makeOutboxStore()
        defer {
            try? databases.close()
            try? FileManager.default.removeItem(at: directory)
        }
        var session = outboxSessionEntry(key: "agent:main:main", thinkingLevels: [])
        session.effectiveQueueMode = sessionMode
        let transport = OutboxTestTransport(healthy: true, sessions: [session])
        let model = await makeOutboxViewModel(transport: transport, outbox: store)
        defer { model.detachTransport() }
        model.load()
        await model.bootstrapTask?.value
        await waitForObservedState { model.hasRestoredOutboxMessages }
        model.updateActiveSessionRunWithoutChatSnapshot(true)
        let gate = OutboxTestGate()
        await transport.state.update {
            $0.sendGate = gate
            $0.staleHistoryRows = []
        }
        model.input = "Check the spacing, too."
        try await #require(model.send(queueMode: mode)).value
        await gate.waitUntilStarted()
        let message = try #require(model.messages.last { $0.role == "user" })
        let expected: ChatUserSendPresentation.Phase = waitsForReply ? .queued : .sending
        #expect(model.outboxState(for: message.id) == .sending)
        #expect(ChatUserSendPresentation(message: message, viewModel: model)?.phase == expected)

        try await finishOutboxFlush(model, at: gate)
        #expect(model.outboxState(for: message.id) == .confirming)
        #expect(ChatUserSendPresentation(message: message, viewModel: model)?.phase == expected)
        // The run ending and the canonical transcript arriving are separate events.
        model.updateActiveSessionRunWithoutChatSnapshot(false)
        #expect(ChatUserSendPresentation(message: message, viewModel: model)?.phase == expected)
        await transport.state.update { $0.staleHistoryRows = nil }
        model.refresh()
        await model.bootstrapTask?.value
        try await waitForOutboxState { model.outboxStatesByMessageID.isEmpty }
        let confirmed = try #require(model.messages.last { $0.idempotencyKey == message.idempotencyKey })
        #expect(ChatUserSendPresentation(message: confirmed, viewModel: model) == nil)
    }

    @Test func `ordinary outbox send does not flash queued`() async throws {
        let (store, databases, directory) = try makeOutboxStore()
        defer {
            try? databases.close()
            try? FileManager.default.removeItem(at: directory)
        }
        let transport = OutboxTestTransport(healthy: true)
        let model = await makeOutboxViewModel(transport: transport, outbox: store)
        defer { model.detachTransport() }
        let gate = OutboxTestGate()
        await transport.state.update {
            $0.sendGate = gate
            $0.staleHistoryRows = []
        }
        let command = outboxTestCommand(id: UUID().uuidString, text: "Hello", createdAt: Date().timeIntervalSince1970)
        #expect(await store.enqueueCommand(command))
        model.load()
        await gate.waitUntilStarted()
        let message = try #require(model.messages.first { $0.role == "user" })
        #expect(!model.hasBlockingRunActivity)
        #expect(ChatUserSendPresentation(message: message, viewModel: model)?.phase == .sending)
        try await finishOutboxFlush(model, at: gate)
        #expect(model.outboxState(for: message.id) == .confirming)
        #expect(ChatUserSendPresentation(message: message, viewModel: model)?.phase == .sending)
    }
}
#endif
