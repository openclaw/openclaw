import Foundation
import Testing
@testable import OpenClaw

private actor Counter {
    private var value = 0

    func increment() {
        value += 1
    }

    func get() -> Int {
        value
    }

    func set(_ newValue: Int) {
        value = newValue
    }
}

@Suite struct GatewayHealthMonitorTests {
    @Test @MainActor func triggersFailureAfterThreshold() async {
        let failureCount = Counter()
        let monitor = GatewayHealthMonitor(
            config: .init(intervalSeconds: 0.001, timeoutSeconds: 0.0, maxFailures: 2))

        monitor.start(
            check: { false },
            onFailure: { _ in
                await failureCount.increment()
                await monitor.stop()
            })

        try? await Task.sleep(nanoseconds: 60_000_000)
        #expect(await failureCount.get() == 1)
    }

    @Test @MainActor func resetsFailuresAfterSuccess() async {
        let failureCount = Counter()
        let calls = Counter()
        let monitor = GatewayHealthMonitor(
            config: .init(intervalSeconds: 0.001, timeoutSeconds: 0.0, maxFailures: 2))

        monitor.start(
            check: {
                await calls.increment()
                let callCount = await calls.get()
                if callCount >= 6 {
                    await monitor.stop()
                }
                return callCount % 2 == 0
            },
            onFailure: { _ in
                await failureCount.increment()
            })

        try? await Task.sleep(nanoseconds: 60_000_000)
        #expect(await failureCount.get() == 0)
    }
}
