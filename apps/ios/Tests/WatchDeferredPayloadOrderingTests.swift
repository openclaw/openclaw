import Testing

struct WatchDeferredPayloadOrderingTests {
    @Test func `expired payload is not replayable`() {
        #expect(WatchDeferredPayloadOrdering.isExpired(expiresAtMs: 100, nowMs: 100))
        #expect(!WatchDeferredPayloadOrdering.isExpired(expiresAtMs: 101, nowMs: 100))
        #expect(!WatchDeferredPayloadOrdering.isExpired(expiresAtMs: nil, nowMs: 100))
    }

    @Test func `ownerless snapshot retains only payloads it cannot supersede`() {
        #expect(WatchDeferredPayloadOrdering.isNewerThanSnapshot(payloadSentAtMs: 201, snapshotSentAtMs: 200))
        #expect(!WatchDeferredPayloadOrdering.isNewerThanSnapshot(payloadSentAtMs: 200, snapshotSentAtMs: 200))
        #expect(WatchDeferredPayloadOrdering.isNewerThanSnapshot(payloadSentAtMs: nil, snapshotSentAtMs: 200))
    }

    @Test func `snapshot freshness treats an undated payload as preexisting`() {
        #expect(WatchDeferredPayloadOrdering.isAtOrBeforeSnapshot(payloadSentAtMs: 100, snapshotSentAtMs: 100))
        #expect(!WatchDeferredPayloadOrdering.isAtOrBeforeSnapshot(payloadSentAtMs: 101, snapshotSentAtMs: 100))
        #expect(WatchDeferredPayloadOrdering.isAtOrBeforeSnapshot(payloadSentAtMs: nil, snapshotSentAtMs: 100))
    }

    @Test func `replays reversed deliveries in event order`() {
        #expect(WatchDeferredPayloadOrdering.indicesOldestFirst(for: [200, 100]) == [1, 0])
    }

    @Test func `replays missing timestamps first in receipt order`() {
        #expect(WatchDeferredPayloadOrdering.indicesOldestFirst(for: [nil, 200, nil, 100]) == [0, 2, 3, 1])
    }
}
