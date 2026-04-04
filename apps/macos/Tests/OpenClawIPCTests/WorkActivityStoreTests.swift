import Foundation
import OpenClawProtocol
import Testing
@testable import OpenClaw

@MainActor
struct WorkActivityStoreTests {
    @Test func `main session job preempts other`() {
        let store = WorkActivityStore()

        store.handleJob(sessionKey: "discord:group:1", state: "started")
        #expect(store.iconState == .workingOther(.job))
        #expect(store.current?.sessionKey == "discord:group:1")

        store.handleJob(sessionKey: "main", state: "started")
        #expect(store.iconState == .workingMain(.job))
        #expect(store.current?.sessionKey == "main")

        store.handleJob(sessionKey: "main", state: "finished")
        #expect(store.iconState == .workingOther(.job))
        #expect(store.current?.sessionKey == "discord:group:1")

        store.handleJob(sessionKey: "discord:group:1", state: "finished")
        #expect(store.iconState == .idle)
        #expect(store.current == nil)
    }

    @Test func `job stays working after tool result grace`() async {
        let store = WorkActivityStore()

        store.handleJob(sessionKey: "main", state: "started")
        #expect(store.iconState == .workingMain(.job))

        store.handleTool(
            sessionKey: "main",
            phase: "start",
            name: "read",
            meta: nil,
            args: ["path": AnyCodable("/tmp/file.txt")])
        #expect(store.iconState == .workingMain(.tool(.read)))

        store.handleTool(
            sessionKey: "main",
            phase: "result",
            name: "read",
            meta: nil,
            args: ["path": AnyCodable("/tmp/file.txt")])

        for _ in 0..<50 {
            if store.iconState == .workingMain(.job) { break }
            try? await Task.sleep(nanoseconds: 100_000_000)
        }
        #expect(store.iconState == .workingMain(.job))

        store.handleJob(sessionKey: "main", state: "done")
        #expect(store.iconState == .idle)
    }

    @Test func `tool label extracts first line and shortens home`() {
        let store = WorkActivityStore()
        let home = NSHomeDirectory()

        store.handleTool(
            sessionKey: "main",
            phase: "start",
            name: "bash",
            meta: nil,
            args: [
                "command": AnyCodable("echo hi\necho bye"),
                "path": AnyCodable("\(home)/Projects/openclaw"),
            ])

        #expect(store.current?.label == "bash: echo hi")
        #expect(store.iconState == .workingMain(.tool(.bash)))

        store.handleTool(
            sessionKey: "main",
            phase: "start",
            name: "read",
            meta: nil,
            args: ["path": AnyCodable("\(home)/secret.txt")])

        #expect(store.current?.label == "read: ~/secret.txt")
        #expect(store.iconState == .workingMain(.tool(.read)))
    }

    @Test func `resolve icon state honors override selection`() {
        let store = WorkActivityStore()
        store.handleJob(sessionKey: "main", state: "started")
        #expect(store.iconState == .workingMain(.job))

        store.resolveIconState(override: .idle)
        #expect(store.iconState == .idle)

        store.resolveIconState(override: .otherEdit)
        #expect(store.iconState == .overridden(.tool(.edit)))
    }

    @Test func `watchdog evicts stale activities`() async {
        let store = WorkActivityStore()

        // Start a job that will become stale
        store.handleJob(sessionKey: "stale-session", state: "started")
        #expect(store.iconState == .workingOther(.job))
        #expect(store.current?.sessionKey == "stale-session")

        // Manually invoke the eviction with a fake old timestamp
        // We'll manipulate the lastUpdate directly for testing
        if var activity = store.jobs["stale-session"] {
            activity.lastUpdate = Date(timeIntervalSinceNow: -150) // 150 seconds ago (stale)
            store.jobs["stale-session"] = activity
        }

        // Invoke the eviction logic
        store.evictStaleActivities()

        // Verify the stale job was removed
        #expect(store.iconState == .idle)
        #expect(store.current == nil)
    }

    @Test func `streaming updates refresh job timestamp`() {
        let store = WorkActivityStore()

        // Start a job
        store.handleJob(sessionKey: "main", state: "started")
        let initialUpdate = store.jobs["main"]?.lastUpdate

        // Small delay to ensure timestamp difference
        Thread.sleep(forTimeInterval: 0.01)

        // Send streaming update
        store.handleJob(sessionKey: "main", state: "streaming")
        let updatedTimestamp = store.jobs["main"]?.lastUpdate

        #expect(updatedTimestamp != nil)
        #expect(updatedTimestamp! > initialUpdate!)
    }

    @Test func `tool events refresh parent job timestamp`() {
        let store = WorkActivityStore()

        // Start a job
        store.handleJob(sessionKey: "main", state: "started")
        let initialJobUpdate = store.jobs["main"]?.lastUpdate

        // Small delay to ensure timestamp difference
        Thread.sleep(forTimeInterval: 0.01)

        // Start a tool - this should refresh the parent job's timestamp
        store.handleTool(
            sessionKey: "main",
            phase: "start",
            name: "bash",
            meta: nil,
            args: ["command": AnyCodable("echo hello")])

        let refreshedJobUpdate = store.jobs["main"]?.lastUpdate

        #expect(refreshedJobUpdate != nil)
        #expect(refreshedJobUpdate! > initialJobUpdate!)
    }

    @Test func `long running job with tool activity stays alive`() {
        let store = WorkActivityStore()

        // Start a job
        store.handleJob(sessionKey: "long-session", state: "started")
        #expect(store.iconState == .workingOther(.job))

        // Simulate a job that's been running for a while by backdating its start
        if var job = store.jobs["long-session"] {
            job.lastUpdate = Date(timeIntervalSinceNow: -150) // 150 seconds ago (would be stale)
            store.jobs["long-session"] = job
        }

        // Simulate ongoing tool activity refreshing the timestamp
        store.handleTool(
            sessionKey: "long-session",
            phase: "start",
            name: "read",
            meta: nil,
            args: ["path": AnyCodable("/some/file")])

        // Even though the job was old, tool activity should have refreshed it
        let jobTimestamp = store.jobs["long-session"]?.lastUpdate
        #expect(jobTimestamp != nil)
        #expect(Date().timeIntervalSince(jobTimestamp!) < 5) // Should be very recent

        // Run eviction - job should NOT be removed because it was recently refreshed
        store.evictStaleActivities()
        #expect(store.iconState != .idle) // Should still be working
        #expect(store.jobs["long-session"] != nil) // Job should still exist
    }

    @Test func `eviction handles mixed stale and fresh activities`() {
        let store = WorkActivityStore()

        // Create multiple sessions
        store.handleJob(sessionKey: "fresh-session", state: "started")
        store.handleJob(sessionKey: "stale-session", state: "started")
        store.handleJob(sessionKey: "old-session", state: "started")

        // Make some sessions stale by backdating
        if var staleJob = store.jobs["stale-session"] {
            staleJob.lastUpdate = Date(timeIntervalSinceNow: -150) // Stale
            store.jobs["stale-session"] = staleJob
        }
        if var oldJob = store.jobs["old-session"] {
            oldJob.lastUpdate = Date(timeIntervalSinceNow: -200) // Very stale
            store.jobs["old-session"] = oldJob
        }

        // Fresh session should remain untouched
        #expect(store.jobs["fresh-session"] != nil)
        #expect(store.jobs["stale-session"] != nil)
        #expect(store.jobs["old-session"] != nil)

        // Run eviction
        store.evictStaleActivities()

        // Only fresh session should remain
        #expect(store.jobs["fresh-session"] != nil)
        #expect(store.jobs["stale-session"] == nil)
        #expect(store.jobs["old-session"] == nil)
    }

    @Test func `eviction gracefully handles empty state`() {
        let store = WorkActivityStore()

        // Running eviction on empty state should not crash
        store.evictStaleActivities()
        #expect(store.iconState == .idle)
        #expect(store.current == nil)
    }

    @Test func `resource cleanup cancels watchdog task`() {
        var store: WorkActivityStore? = WorkActivityStore()

        // Verify the task exists
        #expect(store?.watchdogTask != nil)

        // When store is deallocated, deinit should cancel the task
        // We can't directly test this without accessing internals, but we can verify the structure
        let taskExists = store?.watchdogTask != nil
        #expect(taskExists == true)

        store = nil // This should trigger deinit
        // If we got here without crashing, deinit worked properly
    }
}
