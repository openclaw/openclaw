import Foundation
import Observation
import Testing
@testable import OpenClawChatUI

/// Outbox waits are canceled by the suite limit instead of retaining a stuck test.
@MainActor
func waitForOutboxState(_ condition: @escaping @MainActor () -> Bool) async throws {
    while true {
        try Task.checkCancellation()
        let changed = DeleteGate()
        if withObservationTracking({ condition() }, onChange: {
            Task { await changed.open() }
        }) { return }
        await changed.wait()
    }
}

@MainActor
func finishOutboxFlush(_ vm: OpenClawChatViewModel, at gate: OutboxTestGate) async throws {
    await gate.waitUntilStarted()
    try Task.checkCancellation()
    let flush = try #require(vm.outboxFlushTask)
    await gate.release()
    await withTaskCancellationHandler {
        await flush.value
    } onCancel: {
        flush.cancel()
    }
    try Task.checkCancellation()
}

actor OutboxTestGate {
    private let started = DeleteGate()
    private let released = DeleteGate()

    func wait() async {
        await self.started.open()
        await self.released.wait()
    }

    func waitUntilStarted() async {
        await self.started.wait()
    }

    func release() async {
        await self.released.open()
    }
}

actor DeleteGate {
    private var isOpen = false
    private var waiters: [UUID: CheckedContinuation<Void, Never>] = [:]

    func open() {
        self.isOpen = true
        let continuations = self.waiters.values
        self.waiters.removeAll()
        for continuation in continuations {
            continuation.resume()
        }
    }

    func wait() async {
        let id = UUID()
        await withTaskCancellationHandler {
            await withCheckedContinuation { continuation in
                if self.isOpen || Task.isCancelled {
                    continuation.resume()
                } else {
                    self.waiters[id] = continuation
                }
            }
        } onCancel: {
            Task { await self.cancelWaiter(id) }
        }
    }

    private func cancelWaiter(_ id: UUID) {
        self.waiters.removeValue(forKey: id)?.resume()
    }

    func opened() -> Bool {
        self.isOpen
    }
}
