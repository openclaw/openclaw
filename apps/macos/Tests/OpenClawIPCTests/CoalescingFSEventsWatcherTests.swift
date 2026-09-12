import Foundation
import os
import Testing
@testable import OpenClaw

struct CoalescingFSEventsWatcherTests {
    @Test(arguments: [false, true])
    func `stop discards coalesced events and a new stream can notify`(restartImmediately: Bool) async throws {
        let dir = try makeTempDirForTests()
        defer { try? FileManager.default.removeItem(at: dir) }
        let file = dir.appendingPathComponent("watched.txt")
        let accepted = AsyncTestGate()
        let delivered = AsyncTestGate()
        let notifications = OSAllocatedUnfairLock(initialState: 0)
        let enabled = OSAllocatedUnfairLock(initialState: true)
        let watcher = CoalescingFSEventsWatcher(
            paths: [dir.path],
            queue: DispatchQueue(label: "ai.openclaw.tests.coalescing-watcher"),
            coalesceDelay: 1,
            shouldNotify: { _, eventPaths in
                guard enabled.withLock({ $0 }), let eventPaths else { return false }
                let paths = unsafeBitCast(eventPaths, to: NSArray.self)
                guard paths.contains(where: { ($0 as? String)?.hasSuffix("/watched.txt") == true }) else {
                    return false
                }
                accepted.open()
                return true
            },
            onChange: {
                notifications.withLock { $0 += 1 }
                delivered.open()
            })
        watcher.start()
        defer { watcher.stop() }
        try "first".write(to: file, atomically: false, encoding: .utf8)
        let sawEvent = await self.wait(for: accepted)
        try #require(sawEvent)
        #expect(notifications.withLock { $0 } == 0)

        watcher.stop()
        enabled.withLock { $0 = false }
        if restartImmediately {
            watcher.start()
        }
        // Wait beyond the old stream's coalescing deadline, including after restart.
        try await Task.sleep(for: .milliseconds(1200))
        #expect(notifications.withLock { $0 } == 0)

        if !restartImmediately {
            watcher.start()
        }
        enabled.withLock { $0 = true }
        try "second write".write(to: file, atomically: false, encoding: .utf8)
        let sawNotification = await self.wait(for: delivered)
        #expect(sawNotification)
    }

    @Test func `a started stream does not retain its watcher`() async throws {
        let dir = try makeTempDirForTests()
        defer { try? FileManager.default.removeItem(at: dir) }
        var watcher: CoalescingFSEventsWatcher? = CoalescingFSEventsWatcher(
            paths: [dir.path],
            queue: DispatchQueue(label: "ai.openclaw.tests.watcher-lifetime"),
            onChange: {})
        weak var releasedWatcher = watcher
        watcher?.start()
        watcher = nil
        defer { releasedWatcher?.stop() }
        let deadline = ContinuousClock.now + .seconds(1)
        while releasedWatcher != nil, ContinuousClock.now < deadline {
            try await Task.sleep(for: .milliseconds(10))
        }
        #expect(releasedWatcher == nil)
    }

    private func wait(for gate: AsyncTestGate) async -> Bool {
        await withTaskGroup(of: Bool.self) { group in
            group.addTask {
                await gate.wait()
                return !Task.isCancelled
            }
            group.addTask {
                try? await Task.sleep(for: .seconds(3))
                return false
            }
            let result = await group.next() ?? false
            group.cancelAll()
            return result
        }
    }
}
