import Testing
import XCTest
@testable import OpenClaw

private actor SimpleTaskSignal {
    private var signaled = false
    private var waiters: [CheckedContinuation<Void, Never>] = []

    func signal() {
        self.signaled = true
        let waiters = self.waiters
        self.waiters.removeAll()
        for waiter in waiters {
            waiter.resume()
        }
    }

    func wait() async {
        if self.signaled {
            return
        }
        await withCheckedContinuation { continuation in
            self.waiters.append(continuation)
        }
    }
}

private actor SimpleTaskOperationProbe {
    private var recordedCalls: [String] = []

    func recordCall(_ value: String) {
        self.recordedCalls.append(value)
    }

    func calls() -> [String] {
        self.recordedCalls
    }
}

struct SimpleTaskSupportTests {
    @Test
    @MainActor
    func `cancelling during sleep does not run another operation`() async {
        let sleepStarted = SimpleTaskSignal()
        let operation = SimpleTaskOperationProbe()
        var task: Task<Void, Never>?

        SimpleTaskSupport.startDetachedLoop(
            task: &task,
            interval: 60,
            sleep: { nanoseconds in
                await sleepStarted.signal()
                try await Task.sleep(nanoseconds: nanoseconds)
            },
            operation: {
                await operation.recordCall("loop")
            })

        await sleepStarted.wait()
        guard let runningTask = task else {
            Issue.record("detached loop did not start")
            return
        }

        SimpleTaskSupport.stop(task: &task)
        await runningTask.value

        #expect(await operation.calls() == ["loop"])
        #expect(task == nil)
    }

    @Test
    @MainActor
    func `cancelling after sleep completes does not run the scheduled operation`() async {
        let operation = SimpleTaskOperationProbe()
        var task: Task<Void, Never>?

        SimpleTaskSupport.schedule(
            task: &task,
            delay: 0,
            sleep: { _ in },
            beforeOperationCheck: {
                withUnsafeCurrentTask { currentTask in
                    currentTask?.cancel()
                }
            },
            operation: {
                await operation.recordCall("stale")
            })

        guard let runningTask = task else {
            Issue.record("scheduled task did not start")
            return
        }

        await runningTask.value
        SimpleTaskSupport.stop(task: &task)

        #expect(await operation.calls().isEmpty)
        #expect(task == nil)
    }
}

final class SimpleTaskSupportSchedulingTests: XCTestCase {
    @MainActor
    func testRapidReschedulingOnlyRunsTheLatestOperation() async throws {
        let firstSleepStarted = SimpleTaskSignal()
        let operation = SimpleTaskOperationProbe()
        var task: Task<Void, Never>?
        defer { SimpleTaskSupport.stop(task: &task) }

        SimpleTaskSupport.schedule(
            task: &task,
            delay: 60,
            sleep: { nanoseconds in
                await firstSleepStarted.signal()
                try await Task.sleep(nanoseconds: nanoseconds)
            },
            operation: {
                await operation.recordCall("superseded")
            })
        await firstSleepStarted.wait()
        var scheduled = try [XCTUnwrap(task)]

        for generation in 0..<32 {
            SimpleTaskSupport.schedule(task: &task, delay: 0) {
                await operation.recordCall(String(generation))
            }
            try scheduled.append(XCTUnwrap(task))
        }
        for scheduledTask in scheduled {
            await scheduledTask.value
        }

        let calls = await operation.calls()
        XCTAssertEqual(calls, ["31"])
        SimpleTaskSupport.stop(task: &task)
        XCTAssertNil(task)
    }
}
