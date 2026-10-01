import Foundation
import Testing
@testable import OpenClaw
@testable import OpenClawKit

@MainActor
struct ConnectionModeCoordinatorTests {
    @Test(arguments: [
        (AppState.ConnectionMode.unconfigured, AppState.ConnectionMode.local),
        (AppState.ConnectionMode.remote, AppState.ConnectionMode.local),
        (AppState.ConnectionMode.local, AppState.ConnectionMode.remote),
    ])
    func `newer connection mode owns transition side effects`(
        previousMode: AppState.ConnectionMode,
        nextMode: AppState.ConnectionMode)
    {
        var transition = ConnectionModeCoordinator.Transition()
        let previousGeneration = transition.begin(previousMode)
        let currentGeneration = transition.begin(nextMode)

        #expect(!transition.isCurrent(previousGeneration, mode: previousMode))
        #expect(transition.isCurrent(currentGeneration, mode: nextMode))
    }

    @Test func `reselecting the same mode invalidates its prior transition`() {
        var transition = ConnectionModeCoordinator.Transition()
        let previousGeneration = transition.begin(.remote)
        let currentGeneration = transition.begin(.remote)

        #expect(!transition.isCurrent(previousGeneration, mode: .remote))
        #expect(transition.isCurrent(currentGeneration, mode: .remote))
    }

    @Test func `local connection cleanup preserves an unrecorded listener`() async throws {
        // The default disposable CI partition exercises the formerly destructive path.
        // A listener in this test process would let the regression kill the test runner.
        try #require(!AppProfile.current.isActive)
        let root = try makeTempDirForTests()
        defer { try? FileManager.default.removeItem(at: root) }
        let ready = root.appendingPathComponent("listener-port")
        let input = Pipe()
        let listener = Process()
        listener.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        listener.arguments = ["node", "-e", """
        const fs = require('node:fs');
        const server = require('node:net').createServer(socket => socket.end());
        server.listen(0, '127.0.0.1', () => {
          fs.writeFileSync(process.argv[1], String(server.address().port), {mode: 0o600});
        });
        process.stdin.resume();
        process.stdin.on('end', () => server.close());
        """, ready.path]
        listener.environment = ["PATH": ProcessInfo.processInfo.environment["PATH"] ?? "/usr/bin:/bin"]
        listener.standardInput = input
        listener.standardOutput = FileHandle.nullDevice
        listener.standardError = FileHandle.nullDevice
        try listener.run()
        defer {
            try? input.fileHandleForWriting.close()
            if listener.isRunning { listener.terminate() }
            listener.waitUntilExit()
        }
        let startupDeadline = ContinuousClock.now.advanced(by: .seconds(5))
        while !FileManager.default.fileExists(atPath: ready.path), ContinuousClock.now < startupDeadline {
            try #require(listener.isRunning)
            try await Task.sleep(for: .milliseconds(20))
        }
        let port = try #require(Int(String(contentsOf: ready, encoding: .utf8)))
        let config = root.appendingPathComponent("openclaw.json")
        try Data("{\"gateway\":{\"mode\":\"local\",\"port\":\(port)}}".utf8).write(to: config)
        let marker = root.appendingPathComponent("disable-launchagent")
        try Data().write(to: marker)

        try await TestIsolation.withIsolatedState(env: [
            "OPENCLAW_CONFIG_PATH": config.path,
            "OPENCLAW_GATEWAY_PORT": nil,
        ]) {
            let state = AppStateStore.shared
            let previousMode = state.connectionMode
            let previousPaused = state.isPaused
            state.connectionMode = .local
            state.isPaused = false
            defer {
                state.connectionMode = previousMode
                state.isPaused = previousPaused
            }
            GatewayLaunchAgentManager.setTestingDisableLaunchAgentMarkerURL(marker)
            GatewayLaunchAgentManager.setTestingInterceptDaemonCommands(true)
            GatewayLaunchAgentManager.setTestingDaemonStatusPayload(#"{"ok":true,"service":{"loaded":false}}"#)
            defer {
                GatewayLaunchAgentManager.setTestingDisableLaunchAgentMarkerURL(nil)
                GatewayLaunchAgentManager.setTestingInterceptDaemonCommands(false)
                GatewayLaunchAgentManager.setTestingDaemonStatusPayload(nil)
                GatewayLaunchAgentManager.clearTestingDaemonCommandCalls()
            }
            let session = GatewayTestWebSocketSession {
                GatewayTestWebSocketTask(sendHook: { socket, message, sendIndex in
                    guard sendIndex > 0, let id = GatewayWebSocketTestSupport.requestID(from: message) else { return }
                    socket.emitReceiveSuccess(.data(GatewayWebSocketTestSupport.okResponseData(id: id)))
                })
            }
            let connection = GatewayConnection(
                configProvider: { (url: URL(string: "ws://127.0.0.1:\(port)")!, token: nil, password: nil) },
                sessionBox: WebSocketSessionBox(session: session))
            let manager = GatewayProcessManager.shared
            manager._testResetGatewayStartTask()
            manager.setTestingStatus(.stopped)
            manager.setTestingConnection(connection)
            manager.setTestingSkipControlChannelRefresh(true)
            defer {
                manager._testResetGatewayStartTask()
                manager.setTestingStatus(.stopped)
                manager.setTestingConnection(nil)
                manager.setTestingSkipControlChannelRefresh(false)
            }

            // The native CI launcher owns this process-lifetime AppSupport database.
            // Removing only our stale receipt proves apply's scheduled cleanup actually ran.
            let store = try PortGuardianRecordStore(databaseURL: PortGuardianRecordStore.liveDatabaseURL)
            let sentinel = PortGuardian.Record(
                port: port, pid: 2_000_000_000, command: "/usr/bin/ssh", mode: "remote", timestamp: 1)
            try #require(!store.records().contains(where: { $0.pid == sentinel.pid }))
            try store.upsert(sentinel)
            defer { _ = try? store.deleteIfMatches(sentinel) }
            let coordinator = ConnectionModeCoordinator()

            func finish() async {
                // Supersede any pending local cleanup before releasing the listener or fixture state.
                await coordinator.apply(mode: .unconfigured, paused: true)
                await ControlChannel.shared.disconnect()
                await manager.waitForStartupAttempt()
                await connection.shutdown()
            }

            do {
                let descriptor = await PortGuardian.shared.describe(port: port)
                try #require(descriptor?.pid == listener.processIdentifier)
                await coordinator.apply(mode: .local, paused: false)
                guard case .attachedExisting = manager.status else {
                    Issue.record("Expected the existing listener to be attached before cleanup")
                    await finish()
                    return
                }
                let cleanupDeadline = ContinuousClock.now.advanced(by: .seconds(5))
                while try store.records().contains(sentinel), ContinuousClock.now < cleanupDeadline {
                    try #require(listener.isRunning)
                    try await Task.sleep(for: .milliseconds(20))
                }
                try #require(!store.records().contains(sentinel), "Connection cleanup did not reach its ledger")
                // The retired sweep continued after its ledger read: lsof had a five-second
                // bound, followed by two seconds of TERM/KILL waits. Observe that entire window.
                let preservationDeadline = ContinuousClock.now.advanced(by: .seconds(8))
                while ContinuousClock.now < preservationDeadline {
                    try #require(listener.isRunning, "Connection cleanup terminated an unrecorded listener")
                    try await Task.sleep(for: .milliseconds(50))
                }
                let surviving = await PortGuardian.shared.describe(port: port)
                #expect(surviving?.pid == listener.processIdentifier)
                await finish()
            } catch {
                await finish()
                throw error
            }
        }
    }
}
