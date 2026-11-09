import Foundation
import Observation
import Testing

/// Test waits have no deadline of their own. Suites that use them declare
/// `.testWaitLimit`, so a saturated runner delays these waits instead of failing them.
/// A wait that the limit cancels records the stage it was still waiting for at the caller.
enum TestWait {
    /// Re-reads state that publishes no change signal every 10 ms until it holds: AppKit
    /// and accessibility trees, page script, transport state, or files another process
    /// writes. State with a signal belongs in `observed(_:_:)` or `AsyncTestSignal`.
    static func state(
        _ stage: String,
        isolation: isolated (any Actor)? = #isolation,
        sourceLocation: SourceLocation = #_sourceLocation,
        _ condition: () async throws -> Bool) async throws
    {
        while try await !condition() {
            do {
                try await Task.sleep(for: .milliseconds(10))
            } catch {
                Issue.record("Still waiting for \(stage)", sourceLocation: sourceLocation)
                throw error
            }
        }
    }

    /// Re-evaluates `condition` whenever Observation reports a change to a property it
    /// read. It must read only tracked `@Observable` storage: a computed property that
    /// also derives from untracked state can become true without waking this wait.
    @MainActor
    static func observed(
        _ stage: String,
        sourceLocation: SourceLocation = #_sourceLocation,
        _ condition: @MainActor () -> Bool) async throws
    {
        while true {
            let changed = AsyncTestGate()
            // Observation reports before the write lands; the gate resumes this task in a
            // later main-actor job, after the write.
            if withObservationTracking({ condition() }, onChange: { changed.open() }) { return }
            try await self.wait(for: changed, stage, sourceLocation)
        }
    }

    /// Joins an owned task under the suite limit, forwarding cancellation and recording
    /// the stage. The task must finish when cancelled.
    static func value<Success: Sendable>(
        of task: Task<Success, Never>,
        _ stage: String,
        sourceLocation: SourceLocation = #_sourceLocation) async throws -> Success
    {
        try await self.taskResult(of: task, stage, sourceLocation: sourceLocation).get()
    }

    /// Preserves the task's own error unless the waiting test was cancelled.
    static func value<Success: Sendable>(
        of task: Task<Success, any Error>,
        _ stage: String,
        sourceLocation: SourceLocation = #_sourceLocation) async throws -> Success
    {
        try await self.taskResult(of: task, stage, sourceLocation: sourceLocation).get()
    }

    private static func taskResult<Success: Sendable, Failure: Error>(
        of task: Task<Success, Failure>,
        _ stage: String,
        sourceLocation: SourceLocation) async throws -> Result<Success, Failure>
    {
        let result = await withTaskCancellationHandler {
            await task.result
        } onCancel: {
            task.cancel()
        }
        guard !Task.isCancelled else {
            Issue.record("Still waiting for \(stage)", sourceLocation: sourceLocation)
            throw CancellationError()
        }
        return result
    }

    fileprivate static func wait(
        for change: AsyncTestGate,
        _ stage: String,
        _ sourceLocation: SourceLocation) async throws
    {
        await change.wait()
        guard !Task.isCancelled else {
            Issue.record("Still waiting for \(stage)", sourceLocation: sourceLocation)
            throw CancellationError()
        }
    }
}

extension AsyncTestGate {
    /// Waits for `open()` under the suite limit (see `TestWait`), recording `stage` if cancelled first.
    func wait(_ stage: String, sourceLocation: SourceLocation = #_sourceLocation) async throws {
        try await TestWait.wait(for: self, stage, sourceLocation)
    }
}

extension Trait where Self == TimeLimitTrait {
    /// Converts a lost signal into a failure well inside the 30-minute `macos-swift` job.
    /// It bounds hangs, not speed: the clock skips parallel queueing but still counts time
    /// queued on `TestIsolation` or a starved main actor, which took single tests up to
    /// five minutes on a saturated three-core runner.
    static var testWaitLimit: Self {
        .timeLimit(.minutes(10))
    }
}

/// Wakes `wait(_:until:)` callers each time a fixture records state that publishes no
/// other change signal, such as a request captured by a test socket. Fixtures update
/// that state before calling `notify()`. Waits follow `TestWait`'s deadline contract.
final class AsyncTestSignal: @unchecked Sendable {
    private let lock = NSLock()
    private var next = AsyncTestGate()

    func notify() {
        let current = self.lock.withLock {
            defer { self.next = AsyncTestGate() }
            return self.next
        }
        current.open()
    }

    func wait(
        _ stage: String,
        isolation: isolated (any Actor)? = #isolation,
        sourceLocation: SourceLocation = #_sourceLocation,
        until condition: () -> Bool) async throws
    {
        while true {
            let change = self.lock.withLock { self.next }
            if condition() { return }
            try await TestWait.wait(for: change, stage, sourceLocation)
        }
    }
}
