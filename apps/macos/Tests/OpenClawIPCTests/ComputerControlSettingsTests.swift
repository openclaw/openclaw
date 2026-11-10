import ConcurrencyExtras
import Foundation
import OpenClawKit
import Testing
@testable import OpenClaw

struct ComputerControlSettingsTests {
    @MainActor
    @Test func `Peekaboo refresh preserves the node route while changed options reconnect`() async throws {
        let count = LockIsolated(0)
        let sockets = GatewayTestWebSocketSession(taskFactory: {
            count.withValue { $0 += 1 }
            return GatewayTestWebSocketTask(receiveHook: { task, receiveIndex in
                if receiveIndex == 0 {
                    return .data(GatewayWebSocketTestSupport.connectChallengeData())
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
        let suiteName = "PeekabooNodeConnection.\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suiteName))
        defer { defaults.removePersistentDomain(forName: suiteName) }
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
                    includeDeviceIdentity: false,
                    allowStoredDeviceAuth: false),
                sessionBox: WebSocketSessionBox(session: sockets),
                fallbackMainSessionKey: "main")
        }
        do {
            let first = attempt("Mac")
            _ = try await coordinator.connectWithTLSRepair(first)
            let originalRoute = try #require(await session.currentRoute())
            let refresh = attempt("Mac")
            #expect(first.options == refresh.options)
            _ = try await coordinator.connectWithTLSRepair(refresh)
            #expect(count.value == 1)
            #expect(await session.currentRoute() == originalRoute)

            _ = try await coordinator.connectWithTLSRepair(attempt("Renamed Mac"))
            #expect(count.value == 2)
            let replacementRoute = try #require(await session.currentRoute())
            #expect(replacementRoute != originalRoute)
        } catch {
            await coordinator.stopAndWait()
            throw error
        }
        await coordinator.stopAndWait()
    }

    @Test func `computer control defaults on while preserving explicit choices`() throws {
        let suiteName = "ComputerControlSettingsTests.\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suiteName))
        defer { defaults.removePersistentDomain(forName: suiteName) }

        #expect(isComputerControlEnabled(defaults: defaults))

        defaults.set(false, forKey: computerControlEnabledKey)
        #expect(!isComputerControlEnabled(defaults: defaults))

        defaults.set(true, forKey: computerControlEnabledKey)
        #expect(isComputerControlEnabled(defaults: defaults))
    }

    @Test func `computer control provider defaults to Peekaboo and preserves CUA selection`() throws {
        let suiteName = "ComputerControlProviderSettingsTests.\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suiteName))
        defer { defaults.removePersistentDomain(forName: suiteName) }

        #expect(ComputerControlProvider.current(defaults: defaults, cuaAvailable: true) == .peekaboo)
        defaults.set(ComputerControlProvider.cua.rawValue, forKey: computerControlProviderKey)
        #expect(ComputerControlProvider.current(defaults: defaults, cuaAvailable: true) == .cua)
        #expect(ComputerControlProvider.current(defaults: defaults, cuaAvailable: false) == .peekaboo)
        defaults.set("retired-provider", forKey: computerControlProviderKey)
        #expect(ComputerControlProvider.current(defaults: defaults, cuaAvailable: true) == .peekaboo)
    }

    @Test func `elevation host ignores enabled CUA defaults while normal launches preserve them`() throws {
        let suiteName = "ComputerControlElevationHostTests.\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suiteName))
        defer { defaults.removePersistentDomain(forName: suiteName) }
        let interactivePlan = AppLaunchRuntimePlan(arguments: ["OpenClaw"])
        let elevationPlan = AppLaunchRuntimePlan(arguments: ["OpenClaw", "--elevation-host"])
        defaults.set(true, forKey: computerControlEnabledKey)
        defaults.set(ComputerControlProvider.cua.rawValue, forKey: computerControlProviderKey)

        #expect(isComputerControlEnabled(defaults: defaults))
        #expect(ComputerControlProvider.current(
            defaults: defaults,
            cuaAvailable: true,
            launchPlan: interactivePlan) == .cua)
        #expect(ComputerControlProvider.current(
            defaults: defaults,
            cuaAvailable: true,
            launchPlan: elevationPlan) == .peekaboo)

        defaults.set(false, forKey: computerControlEnabledKey)
        #expect(!isComputerControlEnabled(defaults: defaults, launchPlan: interactivePlan))
        #expect(isComputerControlEnabled(defaults: defaults, launchPlan: elevationPlan))
    }

    @Test func `bundled CUA locator accepts only a regular executable and never follows a symlink`() throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("openclaw-cua-artifact-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: root) }
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let binary = root.appendingPathComponent(CuaDriverArtifact.resourceName)
        try Data("driver".utf8).write(to: binary)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: binary.path)
        #expect(CuaDriverArtifact.executableURL(in: root) == binary)

        try FileManager.default.removeItem(at: binary)
        let target = root.appendingPathComponent("real-driver")
        try Data("driver".utf8).write(to: target)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: target.path)
        try FileManager.default.createSymbolicLink(at: binary, withDestinationURL: target)
        #expect(CuaDriverArtifact.executableURL(in: root) == nil)
    }

    @Test func `CUA worker endpoint uses versioned JSON with escaped paths`() throws {
        let endpoint = CuaDriverWorkerEndpoint(
            socketPath: #"/tmp/openclaw-"quoted"/cua.sock"#,
            binaryPath: #"/Applications/OpenClaw\Test.app/Contents/Resources/cua-driver"#)

        let value = try endpoint.environmentValue()
        let decoded = try #require(
            JSONSerialization.jsonObject(with: Data(value.utf8)) as? [String: Any])

        #expect(decoded.count == 3)
        #expect(decoded["v"] as? Int == 1)
        #expect(decoded["socketPath"] as? String == endpoint.socketPath)
        #expect(decoded["binaryPath"] as? String == endpoint.binaryPath)
    }
}
