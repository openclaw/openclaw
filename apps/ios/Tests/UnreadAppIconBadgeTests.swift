import Foundation
import Testing
@testable import OpenClaw

@MainActor
struct UnreadAppIconBadgeTests {
    private let first = UnreadAppIconBadge.Scope(
        gatewayDeviceID: "gateway-a", principalID: "profile-reader", credentialFingerprint: "credential-a")
    private let second = UnreadAppIconBadge.Scope(
        gatewayDeviceID: "gateway-b", principalID: "profile-reader", credentialFingerprint: "credential-b")

    @Test func retainsProjectionOnFailureAndAppliesExplicitZero() async {
        var writes: [Int] = []
        let badge = UnreadAppIconBadge { writes.append($0) }
        await badge.refresh(scope: self.first) { 3 }
        await badge.refresh(scope: self.first) { throw CancellationError() }
        #expect(writes == [0, 3])
        await badge.refresh(scope: self.first) { 0 }
        #expect(writes == [0, 3, 0])
    }

    @Test func rejectsOldReadAfterScopeDeparture() async {
        var writes: [Int] = []
        let badge = UnreadAppIconBadge { writes.append($0) }
        let read = SuspendedBadgeRead()
        let old = Task { await badge.refresh(scope: self.first) { try await read.value() } }
        await read.waitUntilStarted()
        await badge.reset().value
        #expect(writes == [0, 0]) // Reset completed while the old network read is still suspended.
        read.finish(8)
        await old.value
        #expect(writes == [0, 0])
        await badge.refresh(scope: self.second) { 1 }
        #expect(writes.last == 1)
        #expect(!writes.contains(8))
    }

    @Test func invalidatedSameScopeReadCannotRestoreClearedBadge() async {
        var writes: [Int] = []
        let badge = UnreadAppIconBadge { writes.append($0) }
        let read = SuspendedBadgeRead()
        let old = Task { await badge.refresh(scope: self.first) { try await read.value() } }
        await read.waitUntilStarted()
        badge.invalidate()
        read.finish(9)
        await old.value
        await badge.refresh(scope: self.first) { 0 }
        #expect(writes == [0, 0])
    }

    @Test func settlesStartedOSWriteBeforeNewScopeReset() async {
        var writes: [Int] = []
        let setter = SuspendedBadgeRead()
        let badge = UnreadAppIconBadge { count in
            writes.append(count)
            if count == 2 { _ = try await setter.value() }
        }
        let old = Task { await badge.refresh(scope: self.first) { 2 } }
        await setter.waitUntilStarted()
        badge.reset()
        setter.finish(0)
        await old.value
        await badge.refresh(scope: self.second) { 1 }
        #expect(writes == [0, 2, 0, 0, 1])
    }
}

@MainActor
private final class SuspendedBadgeRead {
    private let started = AsyncStream<Void>.makeStream()
    private var continuation: CheckedContinuation<Int, any Error>?

    func value() async throws -> Int {
        try await withCheckedThrowingContinuation { continuation in
            self.continuation = continuation
            self.started.continuation.yield(())
        }
    }

    func waitUntilStarted() async {
        var iterator = self.started.stream.makeAsyncIterator()
        _ = await iterator.next()
    }

    func finish(_ count: Int) {
        self.continuation?.resume(returning: count)
        self.continuation = nil
    }
}
