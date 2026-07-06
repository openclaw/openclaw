import Testing

private actor StateDirectoryTestGate {
    private var locked = false
    private var waiters: [CheckedContinuation<Void, Never>] = []

    func acquire() async {
        if !self.locked {
            self.locked = true
            return
        }
        await withCheckedContinuation { continuation in
            self.waiters.append(continuation)
        }
    }

    func release() {
        guard !self.waiters.isEmpty else {
            self.locked = false
            return
        }
        self.waiters.removeFirst().resume()
    }
}

/// Prevents process-wide state-directory overrides from crossing suite boundaries.
struct StateDirectoryIsolationTrait: TestTrait, TestScoping {
    private static let gate = StateDirectoryTestGate()

    func provideScope(
        for test: Test,
        testCase: Test.Case?,
        performing function: @Sendable () async throws -> Void) async throws
    {
        await Self.gate.acquire()
        do {
            try await function()
        } catch {
            await Self.gate.release()
            throw error
        }
        await Self.gate.release()
    }
}

extension Trait where Self == StateDirectoryIsolationTrait {
    static var stateDirectoryIsolated: Self {
        Self()
    }
}
