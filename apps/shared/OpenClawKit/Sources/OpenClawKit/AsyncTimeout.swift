import Foundation

private actor AsyncTimeoutRace<T: Sendable> {
    private enum Outcome {
        case success(T)
        case failure(any Error)
    }

    private var outcome: Outcome?
    private var continuation: CheckedContinuation<T, any Error>?
    private var operationTask: Task<Void, Never>?
    private var timeoutTask: Task<Void, Never>?

    func setOperationTask(_ task: Task<Void, Never>) {
        self.operationTask = task
        self.cancelTasksIfResolved()
    }

    func setTimeoutTask(_ task: Task<Void, Never>) {
        self.timeoutTask = task
        self.cancelTasksIfResolved()
    }

    func installContinuation(_ continuation: CheckedContinuation<T, any Error>) {
        if let outcome {
            self.resume(continuation, with: outcome)
            return
        }
        self.continuation = continuation
    }

    private func resolve(_ outcome: Outcome) {
        guard self.outcome == nil else { return }
        self.outcome = outcome
        self.cancelTasksIfResolved()
        if let continuation = self.continuation {
            self.continuation = nil
            self.resume(continuation, with: outcome)
        }
    }

    func resolveSuccess(_ value: T) {
        self.resolve(.success(value))
    }

    func resolveFailure(_ error: any Error) {
        self.resolve(.failure(error))
    }

    private func cancelTasksIfResolved() {
        guard self.outcome != nil else { return }
        self.operationTask?.cancel()
        self.timeoutTask?.cancel()
    }

    private func resume(_ continuation: CheckedContinuation<T, any Error>, with outcome: Outcome) {
        switch outcome {
        case let .success(value):
            continuation.resume(returning: value)
        case let .failure(error):
            continuation.resume(throwing: error)
        }
    }
}

public enum AsyncTimeout {
    public static func withTimeout<T: Sendable>(
        seconds: Double,
        onTimeout: @escaping @Sendable () -> Error,
        operation: @escaping @Sendable () async throws -> T) async throws -> T
    {
        let clamped = max(0, seconds)
        if clamped == 0 {
            return try await operation()
        }

        let race = AsyncTimeoutRace<T>()
        let operationTask = Task {
            do {
                await race.resolveSuccess(try await operation())
            } catch {
                await race.resolveFailure(error)
            }
        }
        await race.setOperationTask(operationTask)
        let timeoutTask = Task {
            do {
                try await Task.sleep(nanoseconds: UInt64(clamped * 1_000_000_000))
                await race.resolveFailure(onTimeout())
            } catch is CancellationError {
                // The operation or caller resolved the race first.
            } catch {
                await race.resolveFailure(error)
            }
        }
        await race.setTimeoutTask(timeoutTask)

        return try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in
                Task { await race.installContinuation(continuation) }
            }
        } onCancel: {
            Task { await race.resolveFailure(CancellationError()) }
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
