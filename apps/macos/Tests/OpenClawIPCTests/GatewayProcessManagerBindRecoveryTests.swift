import Foundation
import Testing
@testable import OpenClaw
@testable import OpenClawKit

extension GatewayProcessManagerTests {
    @Test(.testWaitLimit, arguments: ["::1", "my host"], [false, true])
    func `invalid custom bind preserves recovery intent`(host: String, wasActive: Bool) async throws {
        let port = AppProfile.current.defaultGatewayPort
        try await self.withLaunchAgentEnvironment(port: port) {
            let manager = GatewayProcessManager()
            let app = AppStateStore.shared
            let previousMode = app.connectionMode
            let previousPause = app.isPaused
            app.connectionMode = .local
            app.isPaused = false
            defer {
                app.connectionMode = previousMode
                app.isPaused = previousPause
            }
            let store = GatewayEndpointStore.shared
            await store.setLocalUnavailableReason(nil)
            let configURL = OpenClawPaths.configURL
            func config(_ host: String) throws -> Data {
                try JSONSerialization.data(withJSONObject: [
                    "gateway": [
                        "mode": "local", "port": port, "bind": "custom", "customBindHost": host,
                    ],
                ])
            }
            let invalid = try config(host)
            let corrected = try config("127.0.0.2")
            try invalid.write(to: configURL, options: .atomic)
            manager.desiredActive = wasActive

            @MainActor
            func retireFixture() async {
                let startup = manager.gatewayStartTask
                manager._testResetGatewayStartTask()
                await startup?.value
                await manager.waitForStartupAttempt()
                await store.setLocalUnavailableReason(nil)
            }

            do {
                manager.setActive(true, source: wasActive ? .recovery : .request)
                await manager.waitForStartupAttempt()
                #expect(manager.desiredActive)
                #expect(manager.lastFailureReason?.contains("gateway.customBindHost") == true)
                #expect(manager.gatewayStartTask == nil)
                await store.refresh()
                guard case let .unavailable(.local, reason, _) = await store.currentState() else {
                    Issue.record("Invalid activation must expose the local configuration error")
                    await retireFixture()
                    return
                }
                #expect(reason.contains("gateway.customBindHost"))
                await #expect(throws: Error.self) { _ = try await store.requireEndpoint() }
                try #expect(Data(contentsOf: configURL) == invalid)

                try corrected.write(to: configURL, options: .atomic)
                await store.refresh()
                let endpoint = try await store.requireEndpoint()
                #expect(endpoint.config.url.absoluteString == "ws://127.0.0.2:\(port)")
                manager.setActive(true, source: .recovery)
                #expect(manager.desiredActive)
                #expect(manager.status == .starting)
                #expect(manager.gatewayStartTask != nil)
                // Accept the real startup decision, but do not launch a service from this fixture.
                let startup = manager.gatewayStartTask
                manager._testResetGatewayStartTask()
                await startup?.value
                try await TestWait.observed("activation environment check") {
                    manager.environmentStatus.kind != .checking
                }
                try #expect(Data(contentsOf: configURL) == corrected)
                #expect(!GatewayLaunchAgentManager.testingDaemonCommandCallsSnapshot()
                    .contains { $0.first == "install" })
                await retireFixture()
            } catch {
                await retireFixture()
                throw error
            }
        }
    }

    @Test(.testWaitLimit)
    func `companion port conflict still blocks background recovery`() async throws {
        // Enabling config sync on the app singleton is process-lifetime. Keep
        // that fixture state and queued endpoint publications out of the parent runner.
        await #expect(processExitsWith: .success) {
            try await GatewayProcessManagerTests.checkCompanionPortConflict()
        }
    }

    @MainActor
    private static func checkCompanionPortConflict() async throws {
        let fixture = GatewayProcessManagerTests()
        let port = AppProfile.current.defaultGatewayPort
        try await fixture.withLaunchAgentEnvironment(mode: "remote", port: port) {
            let manager = GatewayProcessManager()
            let app = AppStateStore.shared
            app._testEnableGatewayConfigSync()
            let remoteURL = try #require(URL(string: "ws://127.0.0.1:\(port + 1)"))
            try app.setPrimaryGateway(.direct(url: remoteURL, token: nil, password: nil, tlsFingerprint: nil))
            try app.setHostsLocalGatewayWithRemotePrimary(true)
            await app._testAwaitGatewayConfigSync()
            try #require(app.hostsLocalGatewayWithRemotePrimary)

            // Enable hosting through its owner with distinct ports, then model
            // an external file edit that makes the primary collide with the companion.
            let configURL = OpenClawPaths.configURL
            var root = OpenClawConfigFile.loadDict()
            var gateway = try #require(root["gateway"] as? [String: Any])
            var remote = try #require(gateway["remote"] as? [String: Any])
            remote["url"] = "ws://127.0.0.1:\(port)"
            gateway["remote"] = remote
            root["gateway"] = gateway
            let config = try JSONSerialization.data(withJSONObject: root)
            try config.write(to: configURL, options: .atomic)
            manager.setActive(true)
            #expect(!manager.desiredActive)
            #expect(manager.lastFailureReason?.contains("also used by the remote primary") == true)
            let failure = manager.status
            manager.setActive(true, source: .recovery)
            #expect(!manager.desiredActive)
            #expect(manager.status == failure)
            #expect(manager.gatewayStartTask == nil)
            try #expect(Data(contentsOf: configURL) == config)
        }
    }
}
