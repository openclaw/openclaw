import Foundation
import os
import Testing
@testable import OpenClaw

@Suite(.serialized) struct CanvasFileWatcherTests {
    @Test func `detects in place file writes`() async throws {
        let dir = try makeTempDirForTests()
        defer { try? FileManager.default.removeItem(at: dir) }

        let file = dir.appendingPathComponent("index.html")
        try "hello".write(to: file, atomically: false, encoding: .utf8)

        let fired = AsyncTestGate()
        let watcher = CanvasFileWatcher(url: dir) {
            fired.open()
        }
        watcher.start()
        defer { watcher.stop() }

        // Modify the file in-place (no rename). Directory vnode watching missed this.
        let handle = try FileHandle(forUpdating: file)
        try handle.seekToEnd()
        try handle.write(contentsOf: Data(" world".utf8))
        try handle.close()

        let observedChange = await self.wait(for: fired)
        #expect(observedChange)
    }

    @Test(arguments: [false, true])
    func `change callback can stop and release its watcher`(eventsEnabled: Bool) async throws {
        let dir = try makeTempDirForTests()
        defer { try? FileManager.default.removeItem(at: dir) }
        let stopped = AsyncTestGate()
        let owner = OSAllocatedUnfairLock<CanvasFileWatcher?>(initialState: nil)
        owner.withLock { watcher in
            watcher = CanvasFileWatcher(url: dir) {
                let watcher = owner.withLock { current in
                    defer { current = nil }
                    return current
                }
                watcher?.stop()
                stopped.open()
            }
            if eventsEnabled {
                watcher?.start()
            } else {
                watcher?.setPollingEnabled(true)
            }
        }
        defer {
            let watcher = owner.withLock { current in
                defer { current = nil }
                return current
            }
            watcher?.stop()
        }

        try "changed".write(to: dir.appendingPathComponent("index.html"), atomically: false, encoding: .utf8)
        let stoppedFromCallback = await self.wait(for: stopped)
        #expect(stoppedFromCallback)
    }

    @Test func `polling and stream callbacks do not overlap`() async throws {
        let dir = try makeTempDirForTests()
        defer { try? FileManager.default.removeItem(at: dir) }
        let completed = AsyncTestGate()
        let callbacks = OSAllocatedUnfairLock(initialState: (active: 0, finished: 0, overlapped: false))
        let watcher = CanvasFileWatcher(url: dir) {
            let isFirst = callbacks.withLock { state in
                state.active += 1
                state.overlapped = state.overlapped || state.active > 1
                return state.active == 1 && state.finished == 0
            }
            if isFirst {
                // Keep one producer in onChange while the other detects the same write.
                Thread.sleep(forTimeInterval: 0.5)
            }
            let bothFinished = callbacks.withLock { state in
                state.active -= 1
                state.finished += 1
                return state.finished >= 2
            }
            if bothFinished {
                completed.open()
            }
        }
        watcher.start()
        defer { watcher.stop() }

        try "changed".write(to: dir.appendingPathComponent("index.html"), atomically: false, encoding: .utf8)
        let sawBothCallbacks = await self.wait(for: completed)
        #expect(sawBothCallbacks)
        #expect(callbacks.withLock { !$0.overlapped })
    }

    private func wait(for gate: AsyncTestGate) async -> Bool {
        await withTaskGroup(of: Bool.self) { group in
            group.addTask {
                await gate.wait()
                return !Task.isCancelled
            }
            group.addTask {
                try? await Task.sleep(for: .seconds(2))
                return false
            }
            let result = await group.next() ?? false
            group.cancelAll()
            return result
        }
    }
}
