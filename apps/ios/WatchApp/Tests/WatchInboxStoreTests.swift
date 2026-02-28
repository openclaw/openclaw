import Foundation
import Testing

@testable import OpenClawWatch

@MainActor
@Suite("WatchInboxStore")
struct WatchInboxStoreTests {
    private func makeStore() -> WatchInboxStore {
        WatchInboxStore(defaults: UserDefaults(suiteName: "test.\(UUID())")!)
    }

    private func makeMessage(
        id: String? = nil, title: String = "Title", body: String = "Body",
        sentAtMs: Int? = nil, promptId: String? = nil, sessionKey: String? = nil,
        kind: String? = nil, details: String? = nil, expiresAtMs: Int? = nil,
        risk: String? = nil, actions: [WatchPromptAction] = []
    ) -> WatchNotifyMessage {
        WatchNotifyMessage(
            id: id, title: title, body: body, sentAtMs: sentAtMs,
            promptId: promptId, sessionKey: sessionKey, kind: kind,
            details: details, expiresAtMs: expiresAtMs, risk: risk,
            actions: actions)
    }

    // MARK: - Basic state

    @Test func hasContentIsFalseInitially() {
        #expect(!makeStore().hasContent)
    }

    @Test func hasContentIsTrueAfterConsume() {
        let store = makeStore()
        store.consume(message: makeMessage(id: "test-1", title: "Test"), transport: "test")
        #expect(store.hasContent)
        #expect(store.title == "Test")
    }

    @Test func isExpiredReturnsFalseWhenNoExpiration() {
        #expect(!makeStore().isExpired)
    }

    @Test func isExpiredReturnsTrueWhenPastExpiration() {
        let store = makeStore()
        let pastMs = Int((Date().timeIntervalSince1970 - 60) * 1000)
        store.consume(
            message: makeMessage(id: "exp-1", title: "Expired", expiresAtMs: pastMs),
            transport: "test")
        #expect(store.isExpired)
    }

    // MARK: - Deduplication

    @Test func consumeDeduplicatesByDeliveryKey() {
        let store = makeStore()
        let msg = makeMessage(id: "dup-1", title: "First")
        store.consume(message: msg, transport: "test")
        store.consume(message: msg, transport: "test")
        #expect(store.title == "First")
    }

    @Test func consumeWithDifferentDeliveryKeysUpdatesState() {
        let store = makeStore()
        store.consume(message: makeMessage(id: "m1", title: "First"), transport: "a")
        #expect(store.title == "First")
        store.consume(message: makeMessage(id: "m2", title: "Second"), transport: "b")
        #expect(store.title == "Second")
        #expect(store.transport == "b")
    }

    // MARK: - Empty title defaults

    @Test func consumeWithEmptyTitleDefaultsToOpenClaw() {
        let store = makeStore()
        store.consume(message: makeMessage(id: "e1", title: ""), transport: "test")
        #expect(store.title == "OpenClaw")
    }

    // MARK: - Reply sending

    @Test func markReplySendingSetsState() {
        let store = makeStore()
        store.markReplySending(actionLabel: "Approve")
        #expect(store.isReplySending)
        #expect(store.replyStatusText == "Sending Approve\u{2026}")
    }

    // MARK: - markReplyResult variants

    @Test func markReplyResultDeliveredImmediately() {
        let store = makeStore()
        let result = WatchReplySendResult(
            deliveredImmediately: true, queuedForDelivery: false,
            transport: "sendMessage", errorMessage: nil)
        store.markReplyResult(result, actionLabel: "Approve")
        #expect(!store.isReplySending)
        #expect(store.replyStatusText == "Approve: sent")
        #expect(store.replyStatusAt != nil)
    }

    @Test func markReplyResultQueuedForDelivery() {
        let store = makeStore()
        let result = WatchReplySendResult(
            deliveredImmediately: false, queuedForDelivery: true,
            transport: "transferUserInfo", errorMessage: nil)
        store.markReplyResult(result, actionLabel: "Deny")
        #expect(store.replyStatusText == "Deny: queued")
    }

    @Test func markReplyResultWithError() {
        let store = makeStore()
        let result = WatchReplySendResult(
            deliveredImmediately: false, queuedForDelivery: false,
            transport: "none", errorMessage: "session unavailable")
        store.markReplyResult(result, actionLabel: "Go")
        #expect(store.replyStatusText == "Failed: session unavailable")
    }

    @Test func markReplyResultFallbackSent() {
        let store = makeStore()
        let result = WatchReplySendResult(
            deliveredImmediately: false, queuedForDelivery: false,
            transport: "none", errorMessage: nil)
        store.markReplyResult(result, actionLabel: "OK")
        #expect(store.replyStatusText == "OK: sent")
    }

    // MARK: - makeReplyDraft

    @Test func makeReplyDraftFields() {
        let store = makeStore()
        store.consume(
            message: makeMessage(
                id: "d1", promptId: "prompt-1", sessionKey: "sk-1",
                actions: [WatchPromptAction(id: "a1", label: "Go")]),
            transport: "test")
        let action = WatchPromptAction(id: "a1", label: "Go")
        let draft = store.makeReplyDraft(action: action)
        #expect(draft.promptId == "prompt-1")
        #expect(draft.actionId == "a1")
        #expect(draft.actionLabel == "Go")
        #expect(draft.sessionKey == "sk-1")
        #expect(draft.note == nil)
        #expect(!draft.replyId.isEmpty)
        #expect(draft.sentAtMs > 0)
    }

    @Test func makeReplyDraftUsesUnknownForMissingPromptId() {
        let store = makeStore()
        store.consume(message: makeMessage(id: "d2"), transport: "test")
        let action = WatchPromptAction(id: "x", label: "X")
        let draft = store.makeReplyDraft(action: action)
        #expect(draft.promptId == "unknown")
    }

    // MARK: - Persist / restore round-trip

    @Test func persistAndRestoreRoundTrip() {
        let suiteName = "test.\(UUID())"
        let defaults = UserDefaults(suiteName: suiteName)!

        let store1 = WatchInboxStore(defaults: defaults)
        store1.consume(
            message: makeMessage(
                id: "rt-1", title: "Persisted", body: "Data",
                promptId: "p1", sessionKey: "sk", kind: "approval",
                details: "detail", risk: "high",
                actions: [WatchPromptAction(id: "a1", label: "Yes")]),
            transport: "sendMessage")

        // Create a new store from the same defaults to test restore
        let store2 = WatchInboxStore(defaults: defaults)
        #expect(store2.title == "Persisted")
        #expect(store2.body == "Data")
        #expect(store2.transport == "sendMessage")
        #expect(store2.promptId == "p1")
        #expect(store2.sessionKey == "sk")
        #expect(store2.kind == "approval")
        #expect(store2.details == "detail")
        #expect(store2.risk == "high")
        #expect(store2.actions.count == 1)
        #expect(store2.hasContent)
    }
}
