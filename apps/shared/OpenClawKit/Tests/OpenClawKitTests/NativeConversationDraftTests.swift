import Foundation
import OpenClawKit
import Testing
@testable import OpenClawChatUI

struct NativeConversationDraftTests {
    @Test func `startup navigation cannot move an initial draft into another conversation`() {
        let origin = NativeConversationContext(agentId: "research", sessionKey: "agent:research:thread-a")
        let draft = OpenClawWebConversation.InitialDraft(context: origin, text: "Only for A")
        let otherThread = NativeConversationContext(agentId: "research", sessionKey: "agent:research:thread-b")
        #expect(draft.text(for: otherThread) == nil)
        #expect(draft.text(for: origin) == "Only for A")
    }

    @Test func `equal unqualified keys on different agents do not share a startup draft`() {
        let origin = NativeConversationContext(agentId: "research", sessionKey: "global")
        let draft = OpenClawWebConversation.InitialDraft(context: origin, text: "Research draft")
        #expect(draft.text(for: .init(agentId: "main", sessionKey: "global")) == nil)
        #expect(draft.text(for: origin) == "Research draft")
    }

    @Test @MainActor func `returning from web mode keeps a restored native draft after its outbox drains`() async throws {
        let (store, _, directory) = try makeOutboxStore()
        defer { try? FileManager.default.removeItem(at: directory) }
        let suite = "NativeConversationDraftTests.\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let queued = outboxTestCommand(
            id: "queued-a", text: "Earlier message", createdAt: 1, sessionKey: "thread-a")
        #expect(await store.enqueueCommand(queued))
        let owner = OpenClawWebConversation()
        owner.mode = .native
        let model = OpenClawChatViewModel(
            sessionKey: "agent:main:thread-a", transport: OutboxTestTransport(healthy: false),
            webConversation: owner, activeAgentId: "main", sessionRoutingContract: "per-sender|main|main",
            transcriptCache: store, outbox: store, modelPickerStore: ChatModelPickerStore(defaults: defaults))
        defer { model.detachTransport() }
        model.input = "Keep this unsent draft in A"
        #expect(await model.hasPendingNativeConversationWork())

        model.switchSession(to: "agent:main:thread-b")
        await model.bootstrapTask?.value
        #expect(model.input.isEmpty)
        #expect(await model.hasPendingNativeConversationWork() == false)
        model.setWebConversationMode(.web)
        await model.bootstrapTask?.value
        #expect(await store.confirmCommand(id: queued.id, attemptVersion: queued.attemptVersion) == .updated)
        #expect(await store.loadCommands().isEmpty)

        model.switchSession(to: "agent:main:thread-a")
        await model.bootstrapTask?.value
        #expect(owner.mode == .web)
        #expect(model.input == "Keep this unsent draft in A")
        #expect(await model.hasPendingNativeConversationWork())
        model.input = ""
        #expect(await model.hasPendingNativeConversationWork() == false)
    }

    @Test @MainActor func `web links inspect the destination native draft before changing selection`() throws {
        let suite = "NativeConversationDraftTests.\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let owner = OpenClawWebConversation()
        owner.mode = .native
        let model = OpenClawChatViewModel(
            sessionKey: "agent:main:thread-a", transport: OutboxTestTransport(healthy: false),
            webConversation: owner, activeAgentId: "main", modelPickerStore: ChatModelPickerStore(defaults: defaults))
        defer { model.detachTransport() }
        let destination = NativeConversationContext(agentId: "main", sessionKey: model.sessionKey)
        model.input = "Draft waiting in A"
        model.switchSession(to: "agent:main:thread-b")
        model.setWebConversationMode(.web)

        #expect(model.input.isEmpty)
        #expect(model.hasPendingNativeConversationInput(for: destination))
        #expect(!model.hasPendingNativeConversationInput(for: .init(
            agentId: "main", sessionKey: "agent:main:thread-c")))
        #expect(!model.hasPendingNativeConversationInput(for: .init(
            agentId: "research", sessionKey: "agent:research:thread-a")))
        #expect(model.sessionKey == "agent:main:thread-b")

        model.acceptWebRoute(destination)
        #expect(model.input == "Draft waiting in A")
        #expect(model.hasPendingNativeConversationInput(for: destination))
        model.input = ""
        #expect(!model.hasPendingNativeConversationInput(for: destination))
    }

    @Test @MainActor func `attachment staging keeps native ownership while a web pane is selected`() async throws {
        let suite = "NativeConversationDraftTests.\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let owner = OpenClawWebConversation()
        owner.mode = .web
        let model = OpenClawChatViewModel(
            sessionKey: "agent:main:thread-a", transport: OutboxTestTransport(healthy: false),
            webConversation: owner, activeAgentId: "main", modelPickerStore: ChatModelPickerStore(defaults: defaults))
        defer { model.detachTransport() }
        model.beginAttachmentStaging()
        #expect(model.isAttachmentOwnerPinned)
        #expect(!model.hasDraftToSend)
        #expect(await model.hasPendingNativeConversationWork())
        model.endAttachmentStaging()
        #expect(await model.hasPendingNativeConversationWork() == false)
    }
}
