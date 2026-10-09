import Darwin
import Foundation
import Synchronization
import Testing
@testable import OpenClaw

private final class FakeGatewayChild: Sendable {
    let pid: Int32
    let startup = AsyncTestGate()
    let startupObserved = AsyncTestGate()
    let exited = AsyncTestGate()
    let terminations = Mutex(0)

    init(pid: Int32, startsImmediately: Bool = true) {
        self.pid = pid
        if startsImmediately { self.startup.open() }
    }

    var child: GatewayChildSupervisor.Child {
        GatewayChildSupervisor.Child(
            waitUntilStarted: {
                self.startupObserved.open()
                await self.startup.wait()
                return self.pid
            },
            wait: {
                await self.exited.wait()
                return "exit 1"
            },
            terminate: {
                self.terminations.withLock { $0 += 1 }
                self.startup.open()
                self.exited.open()
            })
    }
}

@MainActor
struct GatewayChildSupervisorTests {
    @Test func `default launcher appends both streams and drains its isolated child`() async throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("gateway-child-launch-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let readyURL = directory.appendingPathComponent("ready")
        try #require(mkfifo(readyURL.path, 0o600) == 0)
        let descriptor = open(readyURL.path, O_RDWR | O_CLOEXEC)
        try #require(descriptor >= 0)
        let readyHandle = FileHandle(fileDescriptor: descriptor, closeOnDealloc: true)
        defer { try? readyHandle.close() }
        try """
        trap 'exit 0' TERM
        printf 'stdout\\n'
        printf 'stderr\\n' >&2
        printf R > "$OPENCLAW_TEST_READY_FIFO"
        IFS= read -r value
        """.write(to: directory.appendingPathComponent("openclaw.mjs"), atomically: true, encoding: .utf8)
        let logURL = directory.appendingPathComponent("gateway.log")
        try "previous\n".write(to: logURL, atomically: true, encoding: .utf8)
        let supervisor = GatewayChildSupervisor()
        do {
            let pid = try await supervisor.start(configuration: .init(
                bun: URL(fileURLWithPath: "/bin/sh"),
                packageRoot: directory,
                environment: ["OPENCLAW_TEST_READY_FIFO": readyURL.path],
                logPath: logURL.path,
                port: 19487,
                allowUnconfigured: false))
            { _ in
                try? readyHandle.write(contentsOf: Data("E".utf8))
            }
            let ready = try await Task.detached { try readyHandle.read(upToCount: 1) }.value
            try #require(ready == Data("R".utf8))
            #expect(getpgid(pid) == pid)
            await supervisor.stop()
            #expect(!supervisor.isActive)
            #expect(kill(pid, 0) == -1 && errno == ESRCH)
            #expect(try String(contentsOf: logURL, encoding: .utf8) == "previous\nstdout\nstderr\n")
        } catch {
            await supervisor.stop()
            throw error
        }
    }

    @Test func `quit deadlines preserve the hosted Gateway drain budget`() {
        #expect(AppTerminationTiming.cleanupDeadlineSeconds(hasAppHostedGateway: false) == 2)
        #expect(AppTerminationTiming.signalExitFailsafeSeconds(hasAppHostedGateway: false) == 3)
        let hostedDeadline = AppTerminationTiming.cleanupDeadlineSeconds(hasAppHostedGateway: true)
        #expect(hostedDeadline >= 330)
        #expect(AppTerminationTiming.signalExitFailsafeSeconds(hasAppHostedGateway: true) > hostedDeadline)
    }

    private func configuration(logPath: String = "/unused/gateway.log") -> GatewayChildSupervisor.Configuration {
        .init(
            bun: URL(fileURLWithPath: "/fixture/runtime/current/bin/bun"),
            packageRoot: URL(fileURLWithPath: "/fixture/runtime/current/lib/node_modules/openclaw"),
            environment: [:],
            logPath: logPath,
            port: 19487,
            allowUnconfigured: false)
    }

    @Test func `child keeps profile and SQLite while dropping inherited service ownership`() {
        let configuration = GatewayChildSupervisor.Configuration(
            bun: URL(fileURLWithPath: "/fixture/runtime/current/bin/bun"),
            packageRoot: URL(fileURLWithPath: "/fixture/runtime/current/lib/node_modules/openclaw"),
            environment: [
                "PATH": "/usr/bin:/bin", "OPENCLAW_PROFILE": "test-hosted",
                "OPENCLAW_SQLITE_LIBRARY": "/fixture/runtime/current/lib/libsqlite3.dylib",
                "OPENCLAW_LAUNCHD_LABEL": "ai.openclaw.gateway", "LAUNCH_JOB_LABEL": "ai.openclaw.gateway",
                "LAUNCH_JOB_NAME": "ai.openclaw.gateway", "LAUNCH_JOB_EXTRA": "inherited",
                "XPC_SERVICE_NAME": "ai.openclaw.gateway", "OPENCLAW_SUPERVISOR_MODE": "external",
                "OPENCLAW_SERVICE_KIND": "gateway", "OPENCLAW_SERVICE_MARKER": "openclaw",
                "OPENCLAW_GATEWAY_HOST_LIFELINE": "inherited",
            ],
            logPath: "/unused/gateway.log",
            port: 19487,
            allowUnconfigured: true)

        #expect(configuration.arguments == [
            "/fixture/runtime/current/lib/node_modules/openclaw/openclaw.mjs",
            "gateway", "run", "--port", "19487", "--allow-unconfigured",
        ])
        #expect(configuration.childEnvironment == [
            "PATH": "/usr/bin:/bin", "OPENCLAW_PROFILE": "test-hosted",
            "OPENCLAW_SQLITE_LIBRARY": "/fixture/runtime/current/lib/libsqlite3.dylib",
            "OPENCLAW_GATEWAY_HOST_LIFELINE": "stdin",
        ])
    }

    @Test func `crashes back off and stop after five failures with a log tail`() async throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("gateway-child-log-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let log = directory.appendingPathComponent("gateway.log")
        try Data("fixture startup failure".utf8).write(to: log)
        let clock = ManualTestClock()
        var children: [FakeGatewayChild] = []
        let supervisor = GatewayChildSupervisor(clock: clock, launcher: { _ in
            let child = FakeGatewayChild(pid: Int32(100 + children.count))
            children.append(child)
            return child.child
        })
        let (events, continuation) = AsyncStream<GatewayChildSupervisor.Event>.makeStream()
        defer { continuation.finish() }
        var iterator = events.makeAsyncIterator()
        let pid = try await supervisor.start(configuration: self.configuration(logPath: log.path)) {
            continuation.yield($0)
        }
        #expect(pid == 100)
        for seconds in [1, 2, 4, 8] {
            children.last?.exited.open()
            #expect(await iterator.next() == .restarting(delay: .seconds(seconds)))
            #expect(supervisor.processIdentifier == nil)
            await clock.waitForSleep(until: clock.now + .seconds(seconds))
            clock.advance(by: .seconds(seconds))
            #expect(await iterator.next() == .started(Int32(99 + children.count)))
        }
        children.last?.exited.open()
        guard case let .failed(message) = await iterator.next() else {
            Issue.record("expected terminal failure after five exits")
            await supervisor.stop()
            return
        }
        #expect(message.contains("five failed starts"))
        #expect(message.contains("fixture startup failure"))
        #expect(children.count == 5)
        #expect(supervisor.processIdentifier == nil)
        await supervisor.stop()
    }

    @Test func `readiness retry keeps child restart and terminal failure events attached`() async throws {
        let clock = ManualTestClock()
        let manager = GatewayProcessManager(readinessClock: clock)
        var children: [FakeGatewayChild] = []
        let supervisor = GatewayChildSupervisor(clock: clock, launcher: { _ in
            let child = FakeGatewayChild(pid: Int32(500 + children.count))
            children.append(child)
            return child.child
        })
        let (events, continuation) = AsyncStream<GatewayChildSupervisor.Event>.makeStream()
        defer {
            continuation.finish()
            manager._testResetGatewayStartTask()
        }
        var iterator = events.makeAsyncIterator()
        manager._testBeginGatewayStartGeneration()
        _ = try await supervisor.start(configuration: self.configuration()) { event in
            manager.handleChildEvent(event, port: 19487)
            continuation.yield(event)
        }
        manager.setTestingStatus(.failed("initial readiness failed"))
        // Retry advances readiness ownership while retaining the original child and callback.
        manager._testBeginGatewayStartGeneration()

        for seconds in [1, 2, 4, 8] {
            children.last?.exited.open()
            #expect(await iterator.next() == .restarting(delay: .seconds(seconds)))
            #expect(manager.status == .starting)
            await clock.waitForSleep(until: clock.now + .seconds(seconds))
            clock.advance(by: .seconds(seconds))
            #expect(await iterator.next() == .started(Int32(499 + children.count)))
            await manager.waitForStartupAttempt()
            #expect(manager.status == .starting)
        }
        children.last?.exited.open()
        guard case let .failed(reason) = await iterator.next() else {
            Issue.record("expected the current lifecycle to receive the supervisor failure")
            await supervisor.stop()
            return
        }
        #expect(manager.status == .failed(reason))
        #expect(manager.lastFailureReason == reason)

        manager._testResetGatewayStartTask()
        manager.handleChildEvent(.restarting(delay: .seconds(1)), port: 19487)
        #expect(manager.status == .failed(reason))
        await supervisor.stop()
    }

    @Test(arguments: [59, 60])
    func `failure backoff resets only after sixty healthy seconds`(healthySeconds: Int) async throws {
        let clock = ManualTestClock()
        var children: [FakeGatewayChild] = []
        let supervisor = GatewayChildSupervisor(clock: clock, launcher: { _ in
            let child = FakeGatewayChild(pid: Int32(200 + children.count))
            children.append(child)
            return child.child
        })
        let (events, continuation) = AsyncStream<GatewayChildSupervisor.Event>.makeStream()
        defer { continuation.finish() }
        var iterator = events.makeAsyncIterator()
        _ = try await supervisor.start(configuration: self.configuration()) { continuation.yield($0) }
        // Time alive is insufficient: readiness must positively mark the child healthy.
        clock.advance(by: .seconds(60))
        for seconds in [1, 2] {
            children.last?.exited.open()
            #expect(await iterator.next() == .restarting(delay: .seconds(seconds)))
            await clock.waitForSleep(until: clock.now + .seconds(seconds))
            clock.advance(by: .seconds(seconds))
            #expect(await iterator.next() == .started(Int32(199 + children.count)))
        }
        let healthyPID = try #require(supervisor.processIdentifier)
        supervisor.markHealthy(pid: healthyPID)
        clock.advance(by: .seconds(healthySeconds))
        children.last?.exited.open()
        #expect(await iterator.next() == .restarting(delay: .seconds(healthySeconds == 60 ? 1 : 4)))
        await supervisor.stop()
    }

    @Test func `stop joins child teardown and cancels a queued restart`() async throws {
        let clock = ManualTestClock()
        var children: [FakeGatewayChild] = []
        let supervisor = GatewayChildSupervisor(clock: clock, launcher: { _ in
            let child = FakeGatewayChild(pid: Int32(300 + children.count))
            children.append(child)
            return child.child
        })
        let (events, continuation) = AsyncStream<GatewayChildSupervisor.Event>.makeStream()
        defer { continuation.finish() }
        var iterator = events.makeAsyncIterator()
        _ = try await supervisor.start(configuration: self.configuration()) { continuation.yield($0) }
        await supervisor.stop()
        #expect(children[0].terminations.withLock { $0 } == 1)
        #expect(supervisor.processIdentifier == nil)

        _ = try await supervisor.start(configuration: self.configuration()) { continuation.yield($0) }
        children[1].exited.open()
        #expect(await iterator.next() == .restarting(delay: .seconds(1)))
        await clock.waitForSleep(until: clock.now + .seconds(1))
        await supervisor.stop()
        clock.advance(by: .seconds(60))
        #expect(children.count == 2)
        #expect(supervisor.processIdentifier == nil)
    }

    @Test func `stop during spawn drains the child without publishing its late PID`() async {
        let child = FakeGatewayChild(pid: 400, startsImmediately: false)
        let supervisor = GatewayChildSupervisor(launcher: { _ in child.child })
        var events: [GatewayChildSupervisor.Event] = []
        let start = Task {
            try await supervisor.start(configuration: self.configuration()) { events.append($0) }
        }
        await child.startupObserved.wait()
        await supervisor.stop()
        do {
            _ = try await start.value
            Issue.record("a stopped startup must not return its child PID")
        } catch { #expect(error is CancellationError) }
        #expect(child.terminations.withLock { $0 } == 1)
        #expect(supervisor.processIdentifier == nil)
        #expect(events.isEmpty)
    }
}
