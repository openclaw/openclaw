import Foundation
import Security
import Testing
@testable import OpenClaw

@MainActor
struct AppStateIsolationTests {
    @Test
    func `automatic recovery preserves a named profile port ownership failure`() async throws {
        try #require(AppProfile.current.isActive)
        let configPath = TestIsolation.tempConfigPath()
        let marker = URL(fileURLWithPath: configPath + ".disable-launchagent")
        try Data(#"{"gateway":{"mode":"local"}}"#.utf8).write(to: URL(fileURLWithPath: configPath))
        try Data().write(to: marker)
        defer {
            try? FileManager.default.removeItem(atPath: configPath)
            try? FileManager.default.removeItem(at: marker)
        }
        await TestIsolation.withIsolatedState(
            env: ["OPENCLAW_CONFIG_PATH": configPath, "OPENCLAW_GATEWAY_PORT": nil],
            defaults: [connectionModeKey: "local"])
        {
            let state = AppStateStore.shared
            let previousMode = state.connectionMode
            state.connectionMode = .local
            let manager = GatewayProcessManager()
            let connection = GatewayConnection(testEndpointProvider: { throw CancellationError() })
            manager.setTestingConnection(connection)
            manager.setTestingSkipControlChannelRefresh(true)
            GatewayLaunchAgentManager.setTestingDisableLaunchAgentMarkerURL(marker)
            GatewayLaunchAgentManager.setTestingInterceptDaemonCommands(true)
            GatewayLaunchAgentManager.setTestingDaemonStatusPayload(#"{"ok":true,"service":{"loaded":false}}"#)
            GatewayLaunchAgentManager.clearTestingDaemonCommandCalls()
            defer {
                manager.setTestingDesiredActive(false)
                state.connectionMode = previousMode
                GatewayLaunchAgentManager.setTestingDisableLaunchAgentMarkerURL(nil)
                GatewayLaunchAgentManager.setTestingInterceptDaemonCommands(false)
                GatewayLaunchAgentManager.setTestingDaemonStatusPayload(nil)
                GatewayLaunchAgentManager.clearTestingDaemonCommandCalls()
            }

            let port = GatewayEnvironment.gatewayPort()
            await PortGuardian.shared.setTestingDescriptor(
                .init(pid: 4242, command: "external-gateway", executablePath: "/tmp/external-gateway"),
                forPort: port)
            #expect(await manager._testAttachExistingGatewayIfAvailable(port: port))
            let failure = manager.lastFailureReason ?? ""
            #expect(failure.contains("already owned by another process"))
            let endpointState = await GatewayEndpointStore.shared.currentState()
            let revision = GatewayEndpointStore.shared.routeRevision
            #expect(endpointState == .unavailable(mode: .local, reason: failure, routeRevision: revision))
            let failureLog = manager.log
            let daemonCalls = GatewayLaunchAgentManager.testingDaemonCommandCallsSnapshot()

            for _ in 0..<3 {
                manager.setActive(true, source: .recovery)
                #expect(manager.status == .failed(failure))
                await manager.waitForStartupAttempt()
                #expect(manager.log == failureLog)
                #expect(await GatewayEndpointStore.shared.currentState() == endpointState)
                #expect(GatewayEndpointStore.shared.routeRevision == revision)
                #expect(GatewayLaunchAgentManager.testingDaemonCommandCallsSnapshot() == daemonCalls)
            }

            // An explicit retry still starts a fresh ownership check; it cannot adopt the rejected listener.
            manager.setActive(true)
            #expect(manager.status == .starting)
            await manager.waitForStartupAttempt()
            #expect(manager.status == .failed(failure))
            #expect(manager.log != failureLog)
            #expect(!GatewayLaunchAgentManager.testingDaemonCommandCallsSnapshot().contains { $0.first == "install" })

            manager.setTestingDesiredActive(false)
            await connection.shutdown()
            await PortGuardian.shared.setTestingDescriptor(nil, forPort: port)
            await GatewayEndpointStore.shared.setLocalUnavailableReason(nil)
        }
    }

    @Test
    func `named profile hosting repair requires restart before activation`() async throws {
        try #require(AppProfile.current.isActive)
        let configPath = TestIsolation.tempConfigPath()
        defer { try? FileManager.default.removeItem(atPath: configPath) }
        try await TestIsolation.withIsolatedState(
            env: ["OPENCLAW_CONFIG_PATH": configPath, "OPENCLAW_GATEWAY_PORT": nil],
            defaults: ["gatewayPort": nil, hostsLocalGatewayWithRemotePrimaryKey: false])
        {
            let reservedPort = GatewayEnvironment.gatewayPort()
            #expect(OpenClawConfigFile.saveDict(["gateway": [
                "mode": "remote", "port": reservedPort,
                "remote": [
                    "transport": "ssh",
                    "sshTarget": "operator@gateway.example",
                    "url": "ws://127.0.0.1:\(reservedPort)",
                    "remotePort": 18789,
                ],
            ]]))
            let state = AppState(preview: true)
            state._testEnableGatewayConfigSync()
            for _ in 0..<2 {
                do {
                    try state.setHostsLocalGatewayWithRemotePrimary(true)
                    Issue.record("A reserved port change must require a restart")
                } catch PrimaryGatewayControlError.localHostingRequiresRestart {}
                #expect(!state.hostsLocalGatewayWithRemotePrimary)
                #expect(state.localGatewayHostingNotice == nil)
            }
            let root = OpenClawConfigFile.loadDict()
            #expect(OpenClawConfigFile.gatewayPort(root: root) != reservedPort)
            #expect(RemotePortTunnel.localPort(root: root) == reservedPort)
        }
    }

    @Test
    func `preview constructor uses launch namespace and owned config`() async throws {
        // Fail before touching defaults when the bundle was launched without its resource owner.
        let profile = try #require(AppProfile.current.name)
        try #require(profile.hasPrefix("test-"))
        let suiteName = try #require(AppProfile.current.defaultsSuiteName)
        let fm = FileManager()
        let home = try #require(OpenClawEnv.path("HOME"))
        // Check the platform's actual default before any fixture or catalog writes.
        // A profile name alone cannot keep Security away from an operator's Keychain.
        var defaultKeychain: SecKeychain?
        try #require(SecKeychainCopyDefault(&defaultKeychain) == errSecSuccess)
        let keychain = try #require(defaultKeychain)
        var pathBytes = [CChar](repeating: 0, count: 4096)
        var pathLength = UInt32(pathBytes.count)
        try #require(SecKeychainGetPath(keychain, &pathLength, &pathBytes) == errSecSuccess)
        let keychainPath = try #require(String(
            bytes: pathBytes.prefix(Int(pathLength)).map { UInt8(bitPattern: $0) },
            encoding: .utf8))
        let keychainURL = URL(fileURLWithPath: keychainPath).resolvingSymlinksInPath()
        try #require(keychainURL.deletingLastPathComponent().path ==
            URL(fileURLWithPath: home).appendingPathComponent("Library/Keychains").resolvingSymlinksInPath().path)
        let fixture = fm.temporaryDirectory.appendingPathComponent("app-state-\(UUID().uuidString)")
        try fm.createDirectory(at: fixture, withIntermediateDirectories: true)
        defer { try? fm.removeItem(at: fixture) }
        let configURL = fixture.appendingPathComponent("openclaw.json")
        let seededKeys = [
            iconAnimationsEnabledKey,
            showDockIconKey,
            talkPhaseSoundsEnabledKey,
            talkShiftToStopEnabledKey,
            heartbeatsEnabledKey,
            iconOverrideKey,
        ]
        var defaults = Dictionary(uniqueKeysWithValues: seededKeys.map { ($0, nil as Any?) })
        defaults[swabbleEnabledKey] = false
        defaults[talkEnabledKey] = false
        defaults[talkRealtimeRelayEnabledKey] = true

        let launchState = try await TestIsolation.withEnvValues([:]) {
            let home = try #require(OpenClawEnv.path("HOME"))
            #expect(OpenClawEnv.path("CFFIXED_USER_HOME") == home)
            let root = URL(fileURLWithPath: home).deletingLastPathComponent()
            #expect(fm.homeDirectoryForCurrentUser.resolvingSymlinksInPath().path ==
                URL(fileURLWithPath: home).resolvingSymlinksInPath().path)
            // Foundation uses Darwin's per-user temp directory independently of TMPDIR.
            // Fixtures there remain test-owned on the disposable worker.
            let tmp = try #require(OpenClawEnv.path("TMPDIR"))
            #expect(URL(fileURLWithPath: tmp).resolvingSymlinksInPath().path ==
                root.appendingPathComponent("tmp").resolvingSymlinksInPath().path)
            #expect(OpenClawPaths.stateDirURL == root.appendingPathComponent("state", isDirectory: true))
            #expect(OpenClawPaths.configURL == OpenClawPaths.stateDirURL.appendingPathComponent("openclaw.json"))
            return OpenClawPaths.stateDirURL
        }

        let fixtureState = try await TestIsolation.withIsolatedState(
            env: ["OPENCLAW_CONFIG_PATH": configURL.path],
            defaults: defaults)
        {
            let preferences = try #require(UserDefaults(suiteName: suiteName))
            // Other tests may already have constructed AppState. Remove only these keys
            // under the cooperative lock instead of assuming this test runs first.
            for key in seededKeys {
                #expect(preferences.object(forKey: key) == nil)
            }
            #expect(!fm.fileExists(atPath: configURL.path))
            let absent = AppState(preview: true)
            #expect(absent.iconAnimationsEnabled)
            #expect(absent.showDockIcon)
            #expect(absent.talkPhaseSoundsEnabled)
            #expect(absent.talkShiftToStopEnabled)
            #expect(absent.heartbeatsEnabled)
            #expect(absent.iconOverride == .system)
            #expect(absent.talkRealtimeRelayEnabled)
            for key in seededKeys.dropLast() {
                #expect(preferences.object(forKey: key) as? Bool == true)
            }
            #expect(preferences.string(forKey: iconOverrideKey) == IconOverrideSelection.system.rawValue)
            #expect(!fm.fileExists(atPath: configURL.path))

            let stateDirectory = OpenClawPaths.stateDirURL
            #expect(stateDirectory != launchState)
            #expect(stateDirectory.path.hasPrefix(fm.temporaryDirectory.path))
            #expect(OpenClawConfigFile.saveDict([
                "gateway": [
                    "mode": "remote",
                    "remote": [
                        "transport": "direct",
                        "url": "wss://fixture.example.invalid:9443",
                    ],
                ],
            ]))
            preferences.set(false, forKey: showDockIconKey)
            let configured = AppState(preview: true)
            #expect(!configured.showDockIcon)
            #expect(configured.connectionMode == .remote)
            #expect(configured.remoteTransport == .direct)
            #expect(configured.remoteUrl == "wss://fixture.example.invalid:9443")
            #expect(AppProfile.current.name == profile)

            // Catalog reads commit legacy migration through SecItemAdd on a fresh Keychain.
            let catalog = try await MacGatewayProfileStore().catalogProfiles()
            #expect(catalog.count == 1)
            let migrated = try #require(catalog.first)
            #expect(migrated.profile.url.absoluteString == "wss://fixture.example.invalid:9443/")
            #expect(!migrated.canPromote)
            // A fresh store must read the committed registry, not the first actor's cache.
            #expect(try await MacGatewayProfileStore().catalogProfiles() == catalog)

            // Preview still reads config; malformed input must keep its snapshot and audit in owned paths.
            try Data("{ invalid fixture".utf8).write(to: configURL)
            _ = AppState(preview: true)
            let auditURL = stateDirectory.appendingPathComponent("logs/config-audit.jsonl")
            let audit = try String(contentsOf: auditURL, encoding: .utf8)
            #expect(audit.contains("config.write"))
            #expect(audit.contains("config.observe"))
            #expect(try fm.contentsOfDirectory(atPath: fixture.path).contains {
                $0.hasPrefix("openclaw.json.clobbered.")
            })
            return stateDirectory
        }
        #expect(!fm.fileExists(atPath: fixtureState.path))
        await TestIsolation.withEnvValues([:]) {
            #expect(OpenClawPaths.stateDirURL == launchState)
            #expect(fm.fileExists(atPath: launchState.path))
        }
    }

    @Test
    func `config fixture cleans audit after throwing body`() async throws {
        enum FixtureError: Error {
            case expected
        }
        let fm = FileManager()
        let configPath = TestIsolation.tempConfigPath()
        defer { try? fm.removeItem(atPath: configPath) }
        var fixtureState: URL?
        do {
            try await TestIsolation.withEnvValues(["OPENCLAW_CONFIG_PATH": configPath]) {
                fixtureState = OpenClawPaths.stateDirURL
                #expect(OpenClawConfigFile.saveDict(["gateway": ["mode": "local"]]))
                await Task.yield()
                #expect(fm.fileExists(atPath: OpenClawPaths.stateDirURL
                        .appendingPathComponent("logs/config-audit.jsonl").path))
                throw FixtureError.expected
            }
        } catch FixtureError.expected {}
        let removed = try #require(fixtureState)
        #expect(!fm.fileExists(atPath: removed.path))
    }
}
