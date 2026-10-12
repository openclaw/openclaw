import Foundation
import Testing
@testable import OpenClawChatUI

@MainActor
struct NativeConversationOutboxTests {
    @Test func `web conversation drains and confirms native work for unselected sessions`() async throws {
        let (store, _, directory) = try makeOutboxStore()
        defer { try? FileManager.default.removeItem(at: directory) }
        let suite = "NativeConversationOutboxTests.\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let now = Date().timeIntervalSince1970
        let queued = [
            outboxTestCommand(id: "background-b", text: "Queued in B", createdAt: now, sessionKey: "thread-b"),
            outboxTestCommand(id: "background-c", text: "Queued in C", createdAt: now + 1, sessionKey: "thread-c"),
        ]
        for command in queued {
            #expect(await store.enqueueCommand(command))
        }
        let ownership = OpenClawChatSendOwnership()
        let window = UUID()
        let visibleScope = OpenClawChatSendOwnership.Scope(sessionKey: "agent:main:thread-a", agentID: "main")
        #expect(await store.reserveWebConversation(scope: visibleScope, owner: window, ownership: ownership))
        defer { ownership.endWeb(visibleScope, owner: window) }
        let transport = OutboxTestTransport(healthy: true)
        let web = OpenClawWebConversation()
        web.mode = .web
        let model = OpenClawChatViewModel(
            sessionKey: "agent:main:thread-a", transport: transport, webConversation: web,
            activeAgentId: "main", sessionRoutingContract: "per-sender|main|main",
            transcriptCache: store, outbox: store, modelPickerStore: ChatModelPickerStore(defaults: defaults))
        defer { model.detachTransport() }
        let changes = store.changes()

        model.handleTransportEvent(.health(ok: true))
        await model.bootstrapTask?.value
        #expect(await model.hasPendingNativeConversationWork() == false)
        model.flushOutboxIfNeeded()
        // A refused flush has no completion event; fail promptly rather than waiting on one.
        let drainStarted = model.outboxFlushTask != nil
        try #require(drainStarted)
        var confirmed: Set<String> = []
        for await change in changes {
            if case let .confirmed(_, commandID) = change { confirmed.insert(commandID) }
            if confirmed.count == queued.count { break }
        }

        #expect(await store.loadCommands().isEmpty)
        #expect(await transport.state.sentIdempotencyKeys == ["background-b", "background-c"])
        #expect(await transport.state.sentSessionKeys == ["agent:main:thread-b", "agent:main:thread-c"])
        #expect(await transport.state.historyRequestSessionKeys == ["agent:main:thread-b", "agent:main:thread-c"])
        #expect(model.messages.isEmpty)
        #expect(model.outboxStatesByMessageID.isEmpty)
        #expect(model.usesWebConversation)
        #expect(!ownership.beginNative(visibleScope))
        let cached = await store.loadTranscript(sessionKey: "thread-b", agentID: "main")
        #expect(cached.map(\.idempotencyKey) == ["background-b:user"])
    }
}
