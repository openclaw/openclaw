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

    @Test func `watchdog starts automatically`() {
        let store = WorkActivityStore()
        #expect(store.watchdogTask != nil)
    }

    @Test func `streaming updates preserve job activity`() {
        let store = WorkActivityStore()

        store.handleJob(sessionKey: "main", state: "started")
        #expect(store.iconState == .workingMain(.job))

        store.handleJob(sessionKey: "main", state: "streaming")
        #expect(store.iconState == .workingMain(.job))
    }

    @Test func `tool activity maintains job state`() {
        let store = WorkActivityStore()

        store.handleJob(sessionKey: "main", state: "started")
        #expect(store.iconState == .workingMain(.job))

        store.handleTool(
            sessionKey: "main",
            phase: "start",
            name: "bash",
            meta: nil,
            args: ["command": AnyCodable("echo hello")])

        #expect(store.current?.sessionKey == "main")
        #expect(store.iconState != .idle)
    }

    @Test func `streaming job recomputes role when main session key changes`() {
        let store = WorkActivityStore()

        // Start job on discord session
        store.handleJob(sessionKey: "discord:group:1", state: "started")
        #expect(store.iconState == .workingOther(.job))

        // Change main session to the discord session
        store.setMainSessionKey("discord:group:1")

        // Send streaming update - should recompute role to main
        store.handleJob(sessionKey: "discord:group:1", state: "streaming")
        #expect(store.iconState == .workingMain(.job))
        #expect(store.current?.sessionKey == "discord:group:1")
    }

    @Test func `tool start refreshes job timestamp`() {
        let store = WorkActivityStore()

        // Start job and tool
        store.handleJob(sessionKey: "main", state: "started")
        store.handleTool(
            sessionKey: "main",
            phase: "start",
            name: "bash",
            meta: nil,
            args: ["command": AnyCodable("command")])

        #expect(store.iconState == .workingMain(.tool(.bash)))
        #expect(store.current?.sessionKey == "main")
    }

    @Test func `stale jobs are evicted to prevent frozen menubar`() {
        let store = WorkActivityStore()

        // Start a job
        store.handleJob(sessionKey: "main", state: "started")
        #expect(store.iconState == .workingMain(.job))

        // Manual eviction clears stale activities (3-minute threshold prevents frozen menubar)
        store.evictStaleActivities()
        #expect(store.iconState == .idle)
        #expect(store.current == nil)
    }

    @Test func `clearAllActivities removes all jobs and tools`() {
        let store = WorkActivityStore()

        // Set up multiple active sessions
        store.handleJob(sessionKey: "main", state: "started")
        store.handleJob(sessionKey: "discord:1", state: "started")
        store.handleTool(sessionKey: "main", phase: "start", name: "bash", meta: nil, args: nil)

        #expect(store.current != nil)
        #expect(store.iconState != .idle)

        // Clear all activities (simulates gateway disconnect)
        store.clearAllActivities()
        #expect(store.current == nil)
        #expect(store.iconState == .idle)
    }
}
