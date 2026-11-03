import Foundation
import os
import Testing
@testable import OpenClaw

@MainActor
private final class HealthMonitorCheckGate {
    private let started = AsyncStream<Void>.makeStream()
    private var result: Bool?
    private var continuation: CheckedContinuation<Bool, Never>?

    func check() async -> Bool {
        self.started.continuation.finish()
        if let result { return result }
        return await withCheckedContinuation { self.continuation = $0 }
    }

    func waitUntilStarted() async {
        for await _ in self.started.stream {}
    }

    func release(_ result: Bool) {
        self.result = result
        let continuation = self.continuation
        self.continuation = nil
        continuation?.resume(returning: result)
    }
}

private final class HealthMonitorFailureLifetime: Sendable {
    private let failures: OSAllocatedUnfairLock<[Int]>
    private let finished: AsyncStream<Void>.Continuation

    init(failures: OSAllocatedUnfairLock<[Int]>, finished: AsyncStream<Void>.Continuation) {
        self.failures = failures
        self.finished = finished
    }

    func record(_ count: Int) {
        self.failures.withLock { $0.append(count) }
    }

    deinit {
        // Only the monitor task owns this callback capture. Release proves it has exited,
        // so absence assertions need neither scheduler yields nor a production test seam.
        self.finished.finish()
    }
}

@MainActor
struct GatewayHealthMonitorTests {
    @Test(arguments: [false, true])
    func `retiring an in-flight final health check cannot fail its replacement`(replace: Bool) async
    {
        let monitor = GatewayHealthMonitor(
            config: .init(intervalSeconds: 1, maxFailures: 1),
            sleep: { _ in Issue.record("A retired monitor must not schedule another check") })
        let retiredCheck = HealthMonitorCheckGate()
        let replacementCheck = HealthMonitorCheckGate()
        let retiredFailures = OSAllocatedUnfairLock(initialState: [Int]())
        let replacementFailures = OSAllocatedUnfairLock(initialState: [Int]())
        let retired = AsyncStream<Void>.makeStream()
        let replacement = AsyncStream<Void>.makeStream()
        defer {
            monitor.stop()
            retiredCheck.release(false)
            replacementCheck.release(false)
        }

        monitor.start(
            check: { await retiredCheck.check() },
            onFailure: { [lifetime = HealthMonitorFailureLifetime(
                failures: retiredFailures,
                finished: retired.continuation)] count in
                lifetime.record(count)
            })
        await retiredCheck.waitUntilStarted()

        if replace {
            monitor.start(
                check: { await replacementCheck.check() },
                onFailure: { [lifetime = HealthMonitorFailureLifetime(
                    failures: replacementFailures,
                    finished: replacement.continuation)] count in
                    lifetime.record(count)
                    await monitor.stop()
                })
            await replacementCheck.waitUntilStarted()
        } else {
            monitor.stop()
        }
        retiredCheck.release(false)
        for await _ in retired.stream {}

        #expect(retiredFailures.withLock { $0 }.isEmpty)
        #expect(replacementFailures.withLock { $0 }.isEmpty)
        if replace {
            replacementCheck.release(false)
            for await _ in replacement.stream {}
            #expect(replacementFailures.withLock { $0 } == [1])
        }
    }
}
