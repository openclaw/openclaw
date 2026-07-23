import Foundation
import Testing
@testable import OpenClaw

private actor DelayActionRecorder {
    private var values: [String] = []

    func append(_ value: String) {
        self.values.append(value)
    }

    func snapshot() -> [String] {
        self.values
    }
}

struct CancellableDelayTests {
    @Test func `completed delay permits its action`() async {
        let shouldContinue = await CancellableDelay.wait(for: .nanoseconds(1))

        #expect(shouldContinue)
    }

    @Test func `cancelled delay suppresses its action`() async {
        let task = Task {
            await CancellableDelay.wait(for: .seconds(30))
        }

        await Task.yield()
        task.cancel()

        #expect(await task.value == false)
    }

    @Test func `replacement delay is the only task that applies state`() async {
        let recorder = DelayActionRecorder()
        let staleTask = Task {
            guard await CancellableDelay.wait(for: .seconds(30)) else { return }
            await recorder.append("stale")
        }

        await Task.yield()
        staleTask.cancel()
        let currentTask = Task {
            guard await CancellableDelay.wait(for: .nanoseconds(1)) else { return }
            await recorder.append("current")
        }

        await staleTask.value
        await currentTask.value
        #expect(await recorder.snapshot() == ["current"])
    }
}
