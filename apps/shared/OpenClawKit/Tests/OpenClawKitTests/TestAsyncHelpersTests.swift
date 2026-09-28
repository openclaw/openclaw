import Foundation
import Synchronization
import Testing

private actor CompletingAsyncCondition {
    nonisolated let clock = Mutex(Date(timeIntervalSince1970: 0))
    private(set) var completed = false

    func snapshot() async -> Bool {
        let snapshot = self.completed
        if snapshot { return snapshot }

        // Keep time frozen until predicate entry so preemption cannot skip the first poll.
        await Task.yield()
        self.clock.withLock { $0.addTimeInterval(16) }
        self.completed = true
        return snapshot
    }
}

struct TestAsyncHelpersTests {
    @Test func `rechecks completion after an async predicate outlasts the deadline`() async throws {
        let condition = CompletingAsyncCondition()

        try await waitUntil(
            "completed async snapshot",
            now: { condition.clock.withLock { $0 } }) { await condition.snapshot() }

        #expect(await condition.completed)
    }

    @Test func `an incomplete condition retains its timeout label`() async throws {
        let label = "incomplete condition"
        do {
            try await waitUntil(label, timeoutSeconds: 0) { false }
            Issue.record("Expected a timeout for an incomplete condition")
        } catch let error as AsyncWaitTimeoutError {
            #expect(error.label == label)
        }
    }

    @Test func `cancellation from an incomplete predicate reaches its caller`() async {
        let task = Task {
            try await waitUntil("cancelled condition") {
                withUnsafeCurrentTask { $0?.cancel() }
                return false
            }
        }

        await #expect(throws: CancellationError.self) {
            try await task.value
        }
    }
}
