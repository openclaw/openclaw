import Foundation
import OpenClawKit
import Testing

private struct ExpectedTimeout: Error {}

struct AsyncTimeoutTests {
    @Test func timeoutReturnsWhenOperationIgnoresCancellation() async {
        let startedAt = ContinuousClock.now

        await #expect(throws: ExpectedTimeout.self) {
            try await AsyncTimeout.withTimeout(
                seconds: 0.01,
                onTimeout: { ExpectedTimeout() },
                operation: {
                    do {
                        try await Task.sleep(for: .seconds(1))
                    } catch is CancellationError {
                        try? await Task.sleep(for: .milliseconds(100))
                    }
                    return "late"
                })
        }

        #expect(startedAt.duration(to: .now) < .milliseconds(100))
    }
}
