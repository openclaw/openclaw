import ConcurrencyExtras
import Foundation
import Testing
@testable import OpenClaw
@testable import OpenClawKit

@MainActor
struct MacNodeConnectionStatusTests {
    @Test(.serialized, arguments: [false, true])
    func `unchanged provider retains route and changed options retire connected identity`(scoped: Bool) async throws {
        let root = try makeTempDirForTests()
        defer { try? FileManager.default.removeItem(at: root) }
        let initialState = root.appendingPathComponent("initial", isDirectory: true)
        let replacementState = root.appendingPathComponent("replacement", isDirectory: true)
        for directory in [initialState, replacementState] {
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        }
        try await TestIsolation.withEnvValues(["OPENCLAW_STATE_DIR": initialState.path]) {
            if scoped {
                try await DeviceIdentityStore.withStateDirectory(initialState) {
                    try await self.runConnectionScenario(scoped: scoped, replacementState: replacementState)
                }
            } else {
                try await self.runConnectionScenario(scoped: scoped, replacementState: replacementState)
            }
        }
    }

    private func runConnectionScenario(scoped: Bool, replacementState: URL) async throws {
        let entered = AsyncTestGate()
        let release = AsyncTestGate()
        let count = LockIsolated(0)
        let holdHandshake = LockIsolated(false)
        let sockets = GatewayTestWebSocketSession(taskFactory: {
            count.withValue { $0 += 1 }
            return GatewayTestWebSocketTask(receiveHook: { task, receiveIndex in
                if receiveIndex == 0 {
                    return .data(GatewayWebSocketTestSupport.connectChallengeData())
                }
                if holdHandshake.value {
                    entered.open()
                    await release.wait()
                }
                return .data(GatewayWebSocketTestSupport.connectOkData(
                    id: task.snapshotConnectRequestID() ?? "connect"))
            })
        })
        let session = GatewayNodeSession()
        let endpoint = try GatewayConnection.EndpointSnapshot(
            config: (url: #require(URL(string: "ws://node.example.invalid")), token: nil, password: nil),
            tls: nil,
            routeAuthority: nil)
        let defaults = try #require(UserDefaults(suiteName: "NodeConnectionStatus.\(UUID().uuidString)"))
        let coordinator = MacNodeModeCoordinator(
            session: session,
            runtime: MacNodeRuntime(computerControlEnabled: { false }),
            endpointProvider: { endpoint },
            presenceReporter: MacNodePresenceReporter(reportingEnabled: false),
            desktopAvailability: MacDesktopAvailabilityCoordinator(defaults: defaults),
            channelStatus: MacNodeChannelStatusStore(),
            notificationCenter: NotificationCenter(),
            initialPaused: false,
            initialComputerControlEnabled: false,
            initialComputerControlProvider: .peekaboo)
        let generations = coordinator.generationsForTesting()
        func attempt(_ name: String) -> ConnectionAttempt {
            ConnectionAttempt(
                endpointGeneration: generations.endpointAttempt,
                routeAuthorityGeneration: generations.routeAuthority,
                workerUnavailable: nil,
                endpoint: endpoint,
                options: GatewayConnectOptions(
                    role: "node",
                    scopes: [],
                    caps: [],
                    commands: [],
                    computerUse: MacNodeModeCoordinator.computerUseDescriptor(
                        provider: .peekaboo,
                        commands: [OpenClawScreenCommand.snapshot.rawValue, OpenClawComputerCommand.act.rawValue],
                        workerManifest: nil),
                    permissions: [:],
                    clientId: "openclaw-macos",
                    clientMode: "node",
                    clientDisplayName: name,
                    deviceIdentityProfile: .node,
                    allowStoredDeviceAuth: false),
                sessionBox: WebSocketSessionBox(session: sockets),
                workerTransportURL: nil,
                fallbackMainSessionKey: "main")
        }
        do {
            _ = try await coordinator.connectWithTLSRepair(attempt("Before refresh"))
            let originalID = try #require(coordinator.connectedDeviceId())
            let originalState = DeviceIdentityStore.stateDirectoryURL.standardizedFileURL
            let originalRoute = try #require(await session.currentRoute())
            _ = try await coordinator.connectWithTLSRepair(attempt("Before refresh"))
            #expect(count.value == 1)
            #expect(await session.currentRoute() == originalRoute)
            let identityRetainedBeforeRefresh = coordinator.connectedDeviceId() == originalID
            #expect(identityRetainedBeforeRefresh)
            #expect(setenv("OPENCLAW_STATE_DIR", replacementState.path, 1) == 0)
            holdHandshake.setValue(true)
            let replacement = Task { try await coordinator.connectWithTLSRepair(attempt("After refresh")) }
            await entered.wait()
            #expect(await session.currentRoute() == nil)
            #expect(coordinator.connectedDeviceId() == nil)
            release.open()
            _ = try await replacement.value
            let identityRetained = coordinator.connectedDeviceId() == originalID
            let effectiveRootChanged = DeviceIdentityStore.stateDirectoryURL.standardizedFileURL != originalState
            let ambientRootChanged = ProcessInfo.processInfo.environment["OPENCLAW_STATE_DIR"] == replacementState.path
            print("[mac-node-identity-diagnostic] scoped=\(scoped) ambientRootChanged=\(ambientRootChanged) " +
                "effectiveRootChanged=\(effectiveRootChanged) identityRetained=\(identityRetained)")
            #expect(identityRetained)
        } catch {
            release.open()
            await coordinator.stopAndWait()
            throw error
        }
        await coordinator.stopAndWait()
    }
}
