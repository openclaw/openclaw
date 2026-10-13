import Synchronization

private final class AsyncTimeoutRace<T: Sendable>: Sendable {
    private enum State {
        case pending
        case cancelledBeforeStart
        case running(CheckedContinuation<T, any Error>, [Task<Void, Never>])
        case resolved([Task<Void, Never>])
    }

    private let state = Mutex<State>(.pending)

    func wait(
        seconds: Double,
        sleep: @escaping @Sendable (Double) async throws -> Void,
        onTimeout: @escaping @Sendable () -> Error,
        operation: @escaping @Sendable () async throws -> T) async throws -> T
    {
        try await withCheckedThrowingContinuation { continuation in
            let cancelled = self.state.withLock { state in
                switch state {
                case .cancelledBeforeStart:
                    return true
                case .running, .resolved:
                    preconditionFailure("A timeout race has only one waiter")
                case .pending:
                    // Admission and handle installation share cancellation's lock.
                    // A cancelled caller cannot leave an unregistered operation running.
                    let operationTask = Task {
                        do {
                            let value = try await operation()
                            self.resolve(.success(value))
                        } catch {
                            self.resolveFailure(error)
                        }
                    }
                    var tasks = [operationTask]
                    if seconds > 0 {
                        tasks.append(Task {
                            do {
                                try await sleep(seconds)
                                self.resolveFailure(onTimeout())
                            } catch is CancellationError {
                                // The operation or caller resolved the race first.
                            } catch {
                                self.resolveFailure(error)
                            }
                        })
                    }
                    state = .running(continuation, tasks)
                    return false
                }
            }
            if cancelled {
                continuation.resume(throwing: CancellationError())
            }
        }
    }

    func resolveFailure(_ error: @autoclosure () -> any Error) {
        self.resolve(.failure(error()))
    }

    private func resolve(_ outcome: @autoclosure () -> Result<T, any Error>) {
        let (continuation, tasks): (CheckedContinuation<T, any Error>?, [Task<Void, Never>]) =
            self.state.withLock { state in
                switch state {
                case .pending:
                    // Only caller cancellation can precede atomic racer installation.
                    state = .cancelledBeforeStart
                    return (nil, [])
                case .cancelledBeforeStart:
                    return (nil, [])
                case let .running(continuation, tasks):
                    state = .resolved(tasks)
                    return (continuation, tasks)
                case let .resolved(tasks):
                    return (nil, tasks)
                }
            }
        guard !tasks.isEmpty else { return }
        // Handlers may reenter the race. Keep handles visible until cancellation is applied,
        // but cancel and resume outside the lock to avoid Swift runtime lock inversion.
        tasks.forEach { $0.cancel() }
        self.state.withLock { $0 = .resolved([]) }
        if let continuation {
            // Only the winner consumes its factory; it may log or call back into a caller.
            continuation.resume(with: outcome())
        }
    }
}

public enum AsyncTimeout {
    public static func withTimeout<T: Sendable>(
        seconds: Double,
        onTimeout: @escaping @Sendable () -> Error,
        operation: @escaping @Sendable () async throws -> T) async throws -> T
    {
        try await self.withTimeout(
            seconds: seconds,
            sleep: { try await Task.sleep(nanoseconds: UInt64($0 * 1_000_000_000)) },
            onTimeout: onTimeout,
            operation: operation)
    }

    public static func withTimeout<T: Sendable, C: Clock>(
        seconds: Double,
        clock: C,
        onTimeout: @escaping @Sendable () -> Error,
        operation: @escaping @Sendable () async throws -> T) async throws -> T
        where C.Duration == Duration
    {
        // Call the clock requirement directly, avoiding a coalesced Clock.sleep(for:) specialization.
        try await self.withTimeout(
            seconds: seconds,
            sleep: { try await clock.sleep(until: clock.now.advanced(by: .seconds($0)), tolerance: nil) },
            onTimeout: onTimeout,
            operation: operation)
    }

    private static func withTimeout<T: Sendable>(
        seconds: Double,
        sleep: @escaping @Sendable (Double) async throws -> Void,
        onTimeout: @escaping @Sendable () -> Error,
        operation: @escaping @Sendable () async throws -> T) async throws -> T
    {
        // Unstructured racers avoid joining a cancellation-ignoring loser. Cancellation
        // marks every racer synchronously; callers still own cleanup and stale-result safety.
        let race = AsyncTimeoutRace<T>()
        return try await withTaskCancellationHandler {
            try await race.wait(
                seconds: max(0, seconds), sleep: sleep, onTimeout: onTimeout, operation: operation)
        } onCancel: {
            race.resolveFailure(CancellationError())
        }
    }

    public static func withTimeoutMs<T: Sendable>(
        timeoutMs: Int,
        onTimeout: @escaping @Sendable () -> Error,
        operation: @escaping @Sendable () async throws -> T) async throws -> T
    {
        let clamped = max(0, timeoutMs)
        let seconds = Double(clamped) / 1000.0
        return try await self.withTimeout(seconds: seconds, onTimeout: onTimeout, operation: operation)
    }
}
