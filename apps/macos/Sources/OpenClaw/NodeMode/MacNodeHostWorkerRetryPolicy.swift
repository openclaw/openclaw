import Foundation

struct MacNodeHostWorkerRetryPolicy: Sendable {
    enum UnexpectedExitDisposition: Equatable, Sendable {
        case retry(attempt: Int, delayNanoseconds: UInt64)
        case giveUp(unexpectedExitCount: Int)
    }

    struct RetryBudgetExhausted: LocalizedError, Equatable, Sendable {
        let unexpectedExitCount: Int

        var errorDescription: String? {
            "node-host worker stopped after \(self.unexpectedExitCount) unexpected exits"
        }
    }

    struct RetryBackoffPending: LocalizedError, Equatable, Sendable {
        var errorDescription: String? {
            "node-host worker retry backoff is still pending"
        }
    }

    private let maximumRetryCount: Int
    private let initialDelayNanoseconds: UInt64
    private let maximumDelayNanoseconds: UInt64
    private var input: MacNodeHostWorkerLaunch?
    private var unexpectedExitCount = 0

    init(
        maximumRetryCount: Int = 5,
        initialDelayNanoseconds: UInt64 = 1_000_000_000,
        maximumDelayNanoseconds: UInt64 = 10_000_000_000)
    {
        precondition(maximumRetryCount >= 0)
        precondition(initialDelayNanoseconds > 0)
        precondition(maximumDelayNanoseconds >= initialDelayNanoseconds)
        self.maximumRetryCount = maximumRetryCount
        self.initialDelayNanoseconds = initialDelayNanoseconds
        self.maximumDelayNanoseconds = maximumDelayNanoseconds
    }

    mutating func prepareForStart(_ input: MacNodeHostWorkerLaunch) throws {
        self.adopt(input)
        if self.unexpectedExitCount > self.maximumRetryCount {
            throw RetryBudgetExhausted(unexpectedExitCount: self.unexpectedExitCount)
        }
    }

    mutating func recordUnexpectedExit(for input: MacNodeHostWorkerLaunch) -> UnexpectedExitDisposition {
        self.adopt(input)
        guard self.unexpectedExitCount <= self.maximumRetryCount else {
            return .giveUp(unexpectedExitCount: self.unexpectedExitCount)
        }

        self.unexpectedExitCount += 1
        guard self.unexpectedExitCount <= self.maximumRetryCount else {
            return .giveUp(unexpectedExitCount: self.unexpectedExitCount)
        }
        return .retry(
            attempt: self.unexpectedExitCount,
            delayNanoseconds: self.retryDelay(for: self.unexpectedExitCount))
    }

    mutating func reset() {
        self.input = nil
        self.unexpectedExitCount = 0
    }

    private mutating func adopt(_ input: MacNodeHostWorkerLaunch) {
        guard self.input != input else { return }
        self.input = input
        self.unexpectedExitCount = 0
    }

    private func retryDelay(for attempt: Int) -> UInt64 {
        var delay = self.initialDelayNanoseconds
        for _ in 1..<attempt {
            if delay >= self.maximumDelayNanoseconds / 2 {
                return self.maximumDelayNanoseconds
            }
            delay *= 2
        }
        return delay
    }
}
