import Testing

@testable import OpenClawWatch

@MainActor
@Suite("WatchInboxStore")
struct WatchInboxStoreTests {
    @Test func hasContentIsFalseInitially() {
        let store = WatchInboxStore(defaults: .init(suiteName: "test.\(UUID())")!)
        #expect(!store.hasContent)
    }

    @Test func hasContentIsTrueAfterConsume() {
        let store = WatchInboxStore(defaults: .init(suiteName: "test.\(UUID())")!)
        let msg = WatchNotifyMessage(
            id: "test-1", title: "Test", body: "Hello",
            sentAtMs: nil, promptId: nil, sessionKey: nil,
            kind: nil, details: nil, expiresAtMs: nil,
            risk: nil, actions: [])
        store.consume(message: msg, transport: "test")
        #expect(store.hasContent)
        #expect(store.title == "Test")
    }

    @Test func isExpiredReturnsFalseWhenNoExpiration() {
        let store = WatchInboxStore(defaults: .init(suiteName: "test.\(UUID())")!)
        #expect(!store.isExpired)
    }

    @Test func isExpiredReturnsTrueWhenPastExpiration() {
        let store = WatchInboxStore(defaults: .init(suiteName: "test.\(UUID())")!)
        let pastMs = Int((Date().timeIntervalSince1970 - 60) * 1000)
        let msg = WatchNotifyMessage(
            id: "exp-1", title: "Expired", body: "Old",
            sentAtMs: nil, promptId: nil, sessionKey: nil,
            kind: nil, details: nil, expiresAtMs: pastMs,
            risk: nil, actions: [])
        store.consume(message: msg, transport: "test")
        #expect(store.isExpired)
    }

    @Test func consumeDeduplicatesByDeliveryKey() {
        let store = WatchInboxStore(defaults: .init(suiteName: "test.\(UUID())")!)
        let msg = WatchNotifyMessage(
            id: "dup-1", title: "First", body: "Body",
            sentAtMs: nil, promptId: nil, sessionKey: nil,
            kind: nil, details: nil, expiresAtMs: nil,
            risk: nil, actions: [])
        store.consume(message: msg, transport: "test")
        store.consume(message: msg, transport: "test")
        #expect(store.title == "First")
    }

    @Test func markReplySendingSetsState() {
        let store = WatchInboxStore(defaults: .init(suiteName: "test.\(UUID())")!)
        store.markReplySending(actionLabel: "Approve")
        #expect(store.isReplySending)
        #expect(store.replyStatusText == "Sending Approve\u{2026}")
    }
}
