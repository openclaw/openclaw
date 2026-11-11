import Foundation
import OpenClawKit
import Testing
@testable import OpenClaw

/// Either session's pause stops both reconnect loops until the user resumes, connects, or disconnects.
@Suite(.serialized, .testWaitLimit) struct GatewaySessionPauseTests {
    @Test @MainActor func `same config connect restarts a paused route`() async throws {
        try await Self.withFixtureGateway(connectFailures: [0: .pairingRequired]) { server, appModel in
            try await TestWait.observed("node pairing pause") { !appModel.canAutoReconnect }
            let config = try #require(appModel.activeGatewayConnectConfig)

            // Retry reapplies the unchanged config; an explicit connect leaves the pause.
            appModel.applyGatewayConnectConfig(config)

            try await TestWait.observed("node connected after retry") { appModel.gatewayConnected }
            #expect(server.roles == ["node", "node"])
        }
    }

    @Test @MainActor func `stale route events are dropped`() throws {
        let appModel = NodeAppModel()
        defer { appModel.disconnectGateway() }
        try appModel.applyGatewayConnectConfig(Self.config(
            url: #require(URL(string: "ws://127.0.0.1:1")),
            stableID: "manual|current|1"))
        let problem = try Self.rateLimitProblem()

        let applied = appModel.apply(
            .failed(problem),
            to: .operator,
            route: (generation: 1, stableID: "manual|stale|1"))

        #expect(!applied)
        #expect(appModel.canAutoReconnect)
    }

    @Test @MainActor func `node reconnect does not lift an operator pause`() async throws {
        try await Self.withFixtureGateway { server, appModel in
            try await TestWait.observed("node connected") { appModel.gatewayConnected }
            try appModel.applyOperatorGatewayConnectionProblem(Self.rateLimitProblem(), route: nil)

            // The node socket's own watchdog reconnects after this drop, while the operator stays paused.
            server.closeConnection(at: 0)
            try await TestWait.state("node socket reconnected") { server.roles.count > 1 }
            try await Task.sleep(for: .milliseconds(500))
            #expect(appModel.gatewayConnected)

            server.stop()
            try await TestWait.observed("node dropped") { !appModel.gatewayConnected }
            // An unpaused node loop would retry the stopped Gateway here and record its failure.
            try await Task.sleep(for: .seconds(3))
            #expect(appModel.lastGatewayProblem?.kind == .authRateLimited)
        }
    }

    @Test @MainActor func `credential handoff pause survives node loop exit`() async throws {
        let state = try TemporaryOpenClawState(instanceID: UUID().uuidString)
        defer { state.restore() }
        let stableID = "manual|handoff-\(UUID().uuidString)|1"
        let options = Self.nodeOptions(stableID: stableID, allowStoredDeviceAuth: false)
        let appModel = NodeAppModel()
        defer { appModel.disconnectGateway() }
        try appModel.applyGatewayConnectConfig(Self.config(
            url: #require(URL(string: "ws://127.0.0.1:1")),
            stableID: stableID,
            bootstrapToken: "one-time-bootstrap",
            nodeOptions: options))

        // No operator credential arrived, so the handoff pauses the route and cancels its loops.
        _ = await appModel._test_completeSuccessfulGatewayAuthHandoff(
            authRoles: (["node"], ["node"]),
            nodeOptions: options)
        let problem = try #require(appModel.lastGatewayProblem)
        try await Task.sleep(for: .milliseconds(500))

        #expect(!appModel.canAutoReconnect)
        #expect(appModel.lastGatewayProblem == problem)
        #expect(appModel.connectedGatewayID == stableID)
    }

    @Test @MainActor func `operator-only resume keeps a node pause`() throws {
        let appModel = NodeAppModel()
        defer { appModel.disconnectGateway() }
        try appModel.applyGatewayConnectConfig(Self.config(
            url: #require(URL(string: "ws://127.0.0.1:1")),
            stableID: "manual|operator-resume|1"))
        let problem = try Self.rateLimitProblem()
        appModel.apply(.failed(problem), to: .node, route: nil)
        appModel.apply(.failed(problem), to: .operator, route: nil)

        // Talk's background poll resumes only the operator session it owns.
        appModel.resumeAfterUserAction(only: .operator)

        #expect(!appModel.canAutoReconnect)
        #expect(appModel.connection.node.pausedProblem == problem)
        #expect(appModel.connection.operator.pausedProblem == nil)
    }

    @Test @MainActor func `resume restarts reconnect attempts after a pause`() async throws {
        try await Self.withFixtureGateway(connectFailures: [0: .pairingRequired]) { server, appModel in
            try await TestWait.observed("node pairing pause") { !appModel.canAutoReconnect }
            // The paused loop waits instead of creating another pairing request.
            try await Task.sleep(for: .milliseconds(1500))
            #expect(server.roles == ["node"])

            appModel.resumeAfterUserAction()

            try await TestWait.observed("node connected after resume") { appModel.gatewayConnected }
            #expect(server.roles == ["node", "node"])
        }
    }

    private static func rateLimitProblem() throws -> GatewayConnectionProblem {
        try #require(GatewayConnectionProblemMapper.map(error: GatewayConnectAuthError(
            message: "too many failed authentication attempts",
            detailCode: "AUTH_RATE_LIMITED",
            canRetryWithDeviceToken: false)))
    }

    @MainActor
    private static func withFixtureGateway(
        connectFailures: [Int: NativeGatewayWebSocketFixture.ConnectFailure] = [:],
        _ body: (NativeGatewayWebSocketFixture, NodeAppModel) async throws -> Void) async throws
    {
        let registryIsolation = await GatewayRegistryTestIsolation()
        defer { registryIsolation.restore() }
        let state = try TemporaryOpenClawState(instanceID: "pause-\(UUID().uuidString)")
        defer { state.restore() }
        try await withUserDefaults(["gateway.autoconnect": false]) {
            let server = try await NativeGatewayWebSocketFixture.start(
                issuedDeviceTokens: [],
                connectFailures: connectFailures)
            defer { server.stop() }
            let appModel = NodeAppModel(audioAdmissionInitiallyAllowed: false)
            appModel.setScenePhase(.active)
            appModel.applyGatewayConnectConfig(Self.config(url: server.url(), stableID: "pause-\(UUID().uuidString)"))
            do {
                try await body(server, appModel)
            } catch {
                appModel.disconnectGateway()
                await appModel.waitForGatewaySessionResetIfNeeded()
                throw error
            }
            appModel.disconnectGateway()
            await appModel.waitForGatewaySessionResetIfNeeded()
        }
    }

    private static func config(
        url: URL,
        stableID: String,
        bootstrapToken: String? = nil,
        nodeOptions: GatewayConnectOptions? = nil) -> GatewayConnectConfig
    {
        GatewayConnectConfig(
            url: url,
            stableID: stableID,
            tls: nil,
            token: nil,
            bootstrapToken: bootstrapToken,
            password: nil,
            nodeOptions: nodeOptions ?? self.nodeOptions(stableID: stableID))
    }

    private static func nodeOptions(stableID: String, allowStoredDeviceAuth: Bool = true) -> GatewayConnectOptions {
        GatewayConnectOptions(
            role: "node",
            scopes: [],
            caps: [],
            commands: [],
            permissions: [:],
            clientId: "openclaw-ios",
            clientMode: "node",
            clientDisplayName: "Pause Test",
            allowStoredDeviceAuth: allowStoredDeviceAuth,
            deviceAuthGatewayID: stableID)
    }
}
