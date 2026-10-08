import Darwin
import Foundation
import OpenClawNativeState
import Testing
@testable import OpenClaw

@MainActor
struct ManagedNodeGatewayMigrationTests {
    private final class Fixture {
        var calls: [String] = []
        var version = "2026.9.6"
        var updateFails = false
        var healthFails = false
        var seedFails = false
        var serviceExists = true
        var packageDirectory = "node"
        var updatedPackageDirectory: String?
        var hostedCLI: GatewayLaunchAgentManager.InstalledServiceCLI?
        var restoredVersion: String?
        var restoredCLI: GatewayLaunchAgentManager.InstalledServiceCLI?
        let runtime = BundledRuntime(root: URL(fileURLWithPath: "/fixture/runtime/build-one"))

        var candidate: ManagedNodeGatewayMigration.Candidate {
            let command = [
                "/fixture/tools/\(self.packageDirectory)/bin/node",
                "/fixture/tools/\(self.packageDirectory)/lib/node_modules/openclaw/dist/entry.js",
            ]
            let environment = ["CHANNEL_FIXTURE": "synthetic", "OPENCLAW_LAUNCHD_LABEL": "ai.openclaw.gateway"]
            return .init(
                cli: .init(prefix: command, sqliteLibrary: nil, environment: environment),
                snapshot: self.serviceExists ? .init(
                    programArguments: command + ["gateway", "--port", "29871"],
                    environment: environment,
                    stdoutPath: nil,
                    stderrPath: nil,
                    port: 29871,
                    bind: nil,
                    token: nil,
                    password: nil) : nil,
                version: self.version,
                port: 29871,
                allowUnconfigured: false)
        }

        var operations: ManagedNodeGatewayMigration.Operations {
            .init(
                checkCurrent: {},
                updateVersion: { _, version in
                    self.calls.append("update")
                    if self.updateFails { throw ManagedNodeGatewayMigration.Failure(message: "offline") }
                    self.version = version
                    if let updatedPackageDirectory = self.updatedPackageDirectory {
                        self.packageDirectory = updatedPackageDirectory
                    }
                },
                recapture: { _, _ in self.calls.append("capture")
                    return self.candidate
                },
                seed: { _ in self.calls.append("seed")
                    if self.seedFails { throw ManagedNodeGatewayMigration.Failure(message: "invalid payload") }
                    return self.runtime
                },
                setServiceHosting: { self.calls.append("service")
                    self.hostedCLI = $0.cli
                },
                install: { _, _ in self.calls.append("bun") },
                restore: { self.calls.append("node")
                    self.restoredCLI = $0.cli
                    self.restoredVersion = $0.version
                },
                verifyHealth: {
                    self.calls.append("health")
                    if self.healthFails {
                        self.healthFails = false
                        throw ManagedNodeGatewayMigration.Failure(message: "health failed")
                    }
                })
        }
    }

    @Test func `version changes stay in core updater without starting the runtime switch`() async throws {
        let fixture = Fixture()
        fixture.version = "2026.8.1"
        let outcome = try await ManagedNodeGatewayMigration.run(
            candidate: fixture.candidate, targetVersion: "2026.9.6", operations: fixture.operations)
        guard case .versionUpdated = outcome else { Issue.record("Expected version-only update")
            return
        }
        #expect(fixture.calls == ["capture", "update", "capture"])
        #expect(fixture.version == "2026.9.6")
    }

    @Test func `repin after final app check is passed to CLI and never rolled back`() async throws {
        let home = try makeTempDirForTests()
        defer { try? FileManager.default.removeItem(at: home) }
        let databaseURL = home.appendingPathComponent("state/openclaw.sqlite")
        let key = try GatewayLaunchAgentManager.runtimePinKey(
            profile: .current, configPath: home.appendingPathComponent("openclaw.json").path)
        try await TestIsolation.withIsolatedState(launchAgentHomeDirectory: home) {
            let fixture = Fixture()
            let refusal = "Gateway service or runtime pin changed before installation. " +
                "The newer selection was preserved; inspect it before retrying."
            GatewayLaunchAgentManager.setTestingDaemonStatusPayload("""
            {"service":{"runtimeIntent":{"status":"known","revision":"before-repin","definition":"node-service"}}}
            """)
            GatewayLaunchAgentManager.setTestingInterceptDaemonCommands(true, beforeReturning: { args in
                if args.first == "status" {
                    GatewayLaunchAgentManager.setTestingDaemonStatusPayload("""
                    {"ok":false,"error":"\(refusal)"}
                    """)
                } else if args.first == "install" {
                    // The CLI subprocess sees an operator repin after the app's last check.
                    do { try await Self.writePinFixture(databaseURL: databaseURL, key: key) } catch {
                        Issue.record(error)
                    }
                }
            })
            GatewayLaunchAgentManager.clearTestingDaemonCommandCalls()
            defer {
                GatewayLaunchAgentManager.setTestingInterceptDaemonCommands(false)
                GatewayLaunchAgentManager.setTestingDaemonStatusPayload(nil)
            }
            var operations = fixture.operations
            operations.install = { _, runtime in
                let error = await GatewayLaunchAgentManager.runDaemonCommand(
                    ["install", "--force", "--runtime", "bun", "--runtime-path", runtime.bun.path],
                    runtime: runtime, checkCurrent: {
                        #expect(!FileManager.default.fileExists(atPath: databaseURL.path))
                        #expect(GatewayLaunchAgentManager.testingDaemonCommandCallsSnapshot().count == 1)
                    })
                if let error { throw ManagedNodeGatewayMigration.Failure(message: error) }
            }
            do {
                _ = try await ManagedNodeGatewayMigration.run(
                    candidate: fixture.candidate, targetVersion: fixture.version, operations: operations)
                Issue.record("Expected preservation of the operator selection")
            } catch {
                #expect(error.localizedDescription == refusal)
            }
            #expect(fixture.restoredCLI == nil)
            #expect(!fixture.calls.contains("health"))
            #expect(try await GatewayLaunchAgentManager
                .runtimePinRecord(stateDirectory: home, profile: .current) != nil)
            let install = try #require(GatewayLaunchAgentManager.testingDaemonCommandCallsSnapshot().last)
            #expect(Array(install.suffix(2)) == [
                "--expected-runtime-pin", #"{"definition":"node-service","revision":"before-repin"}"#,
            ])
        }
    }

    @Test(arguments: ["2026.8.1", "2026.9.6"])
    func `resuming an absent legacy service finishes version and runtime work in one activation`(
        installedVersion: String) async throws
    {
        let fixture = Fixture()
        fixture.version = installedVersion
        fixture.serviceExists = false
        let outcome = try await ManagedNodeGatewayMigration.run(
            candidate: fixture.candidate, targetVersion: "2026.9.6", operations: fixture.operations)
        guard case .migrated = outcome else {
            Issue.record("Expected Resume to complete the Bun service installation")
            return
        }
        let update = installedVersion == "2026.9.6" ? [] : ["update", "capture"]
        #expect(fixture.calls == ["capture"] + update + ["service", "seed", "capture", "bun", "health"])
    }

    @Test(arguments: ["version", "seed", "health"])
    func `absent service failures never switch early and restore only the verified version`(failure: String) async {
        let fixture = Fixture()
        fixture.version = "2026.8.1"
        fixture.serviceExists = false
        fixture.updateFails = failure == "version"
        fixture.seedFails = failure == "seed"
        fixture.healthFails = failure == "health"
        fixture.updatedPackageDirectory = "node-next"
        await #expect(throws: ManagedNodeGatewayMigration.Failure.self) {
            try await ManagedNodeGatewayMigration.run(
                candidate: fixture.candidate, targetVersion: "2026.9.6", operations: fixture.operations)
        }
        switch failure {
        case "version":
            #expect(fixture.calls == ["capture", "update"])
            #expect(fixture.restoredCLI == nil)
        case "seed":
            #expect(fixture.calls == ["capture", "update", "capture", "service", "seed", "node", "health"])
            #expect(fixture.restoredVersion == "2026.9.6")
            #expect(fixture.restoredCLI == fixture.hostedCLI)
            #expect(fixture.restoredCLI?.prefix.first == "/fixture/tools/node-next/bin/node")
        default:
            #expect(fixture.calls == [
                "capture", "update", "capture", "service", "seed", "capture", "bun", "health", "node", "health",
            ])
            #expect(fixture.restoredVersion == "2026.9.6")
            #expect(fixture.restoredCLI == fixture.hostedCLI)
            #expect(fixture.restoredCLI?.prefix.first == "/fixture/tools/node-next/bin/node")
        }
    }

    @Test(arguments: ["excluded", "replaced"])
    func `queued version migration rechecks its eligible candidate before any update`(_ change: String) async {
        let fixture = Fixture()
        fixture.version = "2026.8.1"
        let admitted = fixture.candidate
        var operations = fixture.operations
        operations.recapture = { _, _ in
            fixture.calls.append("capture")
            if change == "excluded" {
                throw ManagedNodeGatewayMigration.Failure(message: "The operator selected a runtime pin.")
            }
            fixture.version = "2026.8.2"
            return fixture.candidate
        }
        await #expect(throws: ManagedNodeGatewayMigration.Failure.self) {
            try await ManagedNodeGatewayMigration.run(
                candidate: admitted, targetVersion: "2026.9.6", operations: operations)
        }
        #expect(fixture.calls == ["capture"])
        #expect(fixture.version != "2026.9.6")
    }

    @Test func `same version switches to a healthy Bun service and preserves always on hosting`() async throws {
        let fixture = Fixture()
        let outcome = try await ManagedNodeGatewayMigration.run(
            candidate: fixture.candidate, targetVersion: fixture.version, operations: fixture.operations)
        guard case let .migrated(runtime) = outcome else { Issue.record("Expected runtime migration")
            return
        }
        #expect(runtime.root == fixture.runtime.root)
        #expect(fixture.calls == ["capture", "service", "seed", "capture", "bun", "health"])
    }

    @Test(arguments: [true, false])
    func `same version Node migration waits for unfinished core setup repair`(serviceExists: Bool) async throws {
        let suite = "ManagedNodeGatewayMigrationTests.\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let fixture = Fixture()
        fixture.serviceExists = serviceExists
        try PostAppUpdateReceiptStore.recordSetupRecovery(
            fromVersion: "2026.8.1", toVersion: fixture.version, defaults: defaults)
        let receipt = try #require(PostAppUpdateReceiptStore.pendingSetupRecovery(defaults: defaults))
        _ = try await ManagedNodeGatewayMigration.run(
            candidate: fixture.candidate,
            targetVersion: fixture.version,
            pendingSetupRecovery: receipt,
            operations: fixture.operations)
        #expect(fixture.calls.isEmpty)
        #expect(PostAppUpdateReceiptStore.pendingSetupRecovery(defaults: defaults) == receipt)
    }

    @Test func `absent Resume leaves an ordinary incomplete update receipt to core repair`() async throws {
        let fixture = Fixture()
        fixture.serviceExists = false
        let pending = PostAppUpdateReceipt(
            fromVersion: "2026.8.1",
            toVersion: fixture.version,
            recordedAt: .distantPast,
            gatewayUpdateIncomplete: true,
            coreUpdate: .gateway)
        let outcome = try await ManagedNodeGatewayMigration.run(
            candidate: fixture.candidate,
            targetVersion: fixture.version,
            pendingSetupRecovery: pending,
            operations: fixture.operations)
        guard case .coreRepairRequired = outcome else { Issue.record("Expected core repair before Resume")
            return
        }
        #expect(fixture.calls.isEmpty)
    }

    @Test func `verified core repair admits the runtime step while notification work remains pending`() async throws {
        let fixture = Fixture()
        fixture.serviceExists = false
        var candidate = fixture.candidate
        candidate.hasVerifiedCoreRepair = true
        var operations = fixture.operations
        let verified = candidate
        operations.recapture = { _, _ in verified }
        let pending = PostAppUpdateReceipt(
            fromVersion: "2026.8.1",
            toVersion: fixture.version,
            recordedAt: .distantPast,
            gatewayUpdateIncomplete: true,
            notificationAttempts: 1)
        let outcome = try await ManagedNodeGatewayMigration.run(
            candidate: candidate, targetVersion: fixture.version, pendingSetupRecovery: pending, operations: operations)
        guard case .migrated = outcome else { Issue.record("Expected verified repair to proceed to runtime health")
            return
        }
        #expect(fixture.calls == ["service", "seed", "bun", "health"])
    }

    @Test func `failed version update never seeds or replaces the Node service`() async {
        let fixture = Fixture()
        fixture.version = "2026.8.1"
        fixture.updateFails = true
        await #expect(throws: ManagedNodeGatewayMigration.Failure.self) {
            try await ManagedNodeGatewayMigration.run(
                candidate: fixture.candidate, targetVersion: "2026.9.6", operations: fixture.operations)
        }
        #expect(fixture.calls == ["capture", "update"])
        #expect(fixture.version == "2026.8.1")
    }

    @Test func `failed Bun health restores the captured same version Node command and checks health`() async {
        let fixture = Fixture()
        fixture.healthFails = true
        let previous = fixture.candidate
        await #expect(throws: ManagedNodeGatewayMigration.Failure.self) {
            try await ManagedNodeGatewayMigration.run(
                candidate: previous, targetVersion: previous.version, operations: fixture.operations)
        }
        #expect(fixture.calls == ["capture", "service", "seed", "capture", "bun", "health", "node", "health"])
        #expect(fixture.restoredCLI?.prefix == previous.cli.prefix)
        #expect(fixture.restoredCLI?.environment == previous.cli.environment)
        let environment = GatewayLaunchAgentManager.daemonEnvironment(
            runtime: nil,
            installedCLI: fixture.restoredCLI,
            environment: [:],
            profile: AppProfile(environment: ["OPENCLAW_PROFILE": "migration-proof"]),
            searchPaths: ["/usr/bin"])
        #expect(environment["CHANNEL_FIXTURE"] == "synthetic")
        #expect(environment["OPENCLAW_LAUNCHD_LABEL"] == nil)
        #expect(environment["OPENCLAW_PROFILE"] == "migration-proof")
    }

    @Test func `version verification failure prevents the runtime switch`() async {
        let fixture = Fixture()
        fixture.version = "2026.8.1"
        var operations = fixture.operations
        operations.updateVersion = { _, _ in fixture.calls.append("update") }
        await #expect(throws: ManagedNodeGatewayMigration.Failure.self) {
            try await ManagedNodeGatewayMigration.run(
                candidate: fixture.candidate, targetVersion: "2026.9.6", operations: operations)
        }
        #expect(fixture.calls == ["capture", "update", "capture"])
    }

    @Test func `named rollback retry recognizes the retained CLI despite generated Node heap flags`() throws {
        let fixture = Fixture()
        let retained = fixture.candidate.cli
        let node = try #require(retained.prefix.first)
        let entrypoint = try #require(retained.prefix.last)
        var command = retained.prefix
        command.insert("--max-old-space-size=8192", at: 1)
        let restored = GatewayLaunchAgentManager.InstalledServiceCLI(
            prefix: command, sqliteLibrary: retained.sqliteLibrary)
        let candidate = ManagedNodeGatewayMigration.Candidate(
            cli: restored,
            snapshot: fixture.candidate.snapshot,
            version: fixture.version,
            port: 29871,
            allowUnconfigured: false)
        #expect(candidate.matchesRetainedCLI(retained))
        for other in try [
            GatewayLaunchAgentManager.InstalledServiceCLI(
                prefix: ["/operator/node", #require(retained.prefix.last)], sqliteLibrary: nil),
            .init(prefix: [#require(retained.prefix.first), "/operator/openclaw.mjs"], sqliteLibrary: nil),
            .init(prefix: retained.prefix, sqliteLibrary: nil, hadRuntimePin: true),
        ] {
            #expect(!candidate.matchesRetainedCLI(other))
        }
    }

    @Test(arguments: [false, true], [false, true])
    func `stop revokes migration completion while preserving pending runtime work`(
        versionOnly: Bool, invalidOwnership: Bool) async throws
    {
        let home = try makeTempDirForTests()
        defer { try? FileManager.default.removeItem(at: home) }
        let config = home.appendingPathComponent("openclaw.json")
        let port = AppProfile.current.isActive ? AppProfile.current.defaultGatewayPort : 29872
        try Data("{\"gateway\":{\"mode\":\"local\",\"port\":\(port)}}".utf8).write(to: config)
        try await TestIsolation.withIsolatedState(
            launchAgentHomeDirectory: home,
            env: ["OPENCLAW_CONFIG_PATH": config.path, "OPENCLAW_GATEWAY_PORT": nil],
            defaults: [
                onboardingSeenKey: true, cliInstallPolicyKey: "exact", pauseDefaultsKey: false,
                GatewayHosting.defaultsKey: invalidOwnership ? nil : "service",
                GatewayLaunchAgentManager.resumeCommandKey: nil, postAppUpdateReceiptKey: nil,
            ]) {
                GatewayLaunchAgentManager.setTestingInterceptDaemonCommands(true)
                GatewayLaunchAgentManager.setTestingDaemonStatusPayload(#"{"ok":true,"service":{"loaded":false}}"#)
                GatewayLaunchAgentManager.setTestingDisableLaunchAgentMarkerURL(home.appendingPathComponent("disabled"))
                defer {
                    GatewayLaunchAgentManager.setTestingInterceptDaemonCommands(false)
                    GatewayLaunchAgentManager.setTestingDaemonStatusPayload(nil)
                    GatewayLaunchAgentManager.setTestingDisableLaunchAgentMarkerURL(nil)
                }
                if invalidOwnership {
                    let state = AppProfile.current.stateDirectoryURL(homeDirectory: home)
                    let manifest = state.appendingPathComponent("tools/node/lib/node_modules/openclaw/package.json")
                    try FileManager.default.createDirectory(
                        at: manifest.deletingLastPathComponent(), withIntermediateDirectories: true)
                    try Data("invalid fixture JSON".utf8).write(to: manifest)
                }
                PostAppUpdateReceiptStore.record(fromVersion: "2026.8.1", toVersion: "2026.9.6")
                let dispatched = try #require(PostAppUpdateReceiptStore.pending(currentVersion: "2026.9.6"))
                try PostAppUpdateReceiptStore.recordCoreUpdateDispatch(receipt: dispatched, owner: .gateway)
                let pending = try #require(PostAppUpdateReceiptStore.completeCoreRepair(
                    currentVersion: "2026.9.6", owner: .gateway))
                #expect(pending.hasPendingRuntimeMigration)
                let manager = GatewayProcessManager()
                manager.desiredActive = true
                defer { manager.desiredActive = false }
                // These are alternative results from the completed migration's previous lifecycle.
                manager.nodeMigrationCompleted = !versionOnly
                manager.nodeMigrationVersionUpdated = versionOnly
                let generation = manager.gatewayStartGeneration
                manager.stop(preservingActivationIntent: true)
                await manager.waitForPendingLaunchAgentDisable()
                #expect(!manager.nodeMigrationCompleted)
                #expect(!manager.nodeMigrationVersionUpdated)
                #expect(!manager.isCurrentGatewayStart(generation))
                #expect(manager.desiredActive)
                if invalidOwnership, BundledRuntime.isBundledApp {
                    guard case .failed = manager.status else {
                        Issue.record("Malformed ownership must fail before teardown")
                        return
                    }
                }
                #expect(PostAppUpdateReceiptStore.pending(currentVersion: "2026.9.6") == pending)
            }
    }

    @Test(arguments: ["memory", "receipt", "pause"])
    func `automatic service ensure cannot bypass a failed managed version update`(failureSource: String) async throws {
        let directory = try makeTempDirForTests()
        defer { try? FileManager.default.removeItem(at: directory) }
        // A named process keeps its port reservation for its lifetime, beyond this fixture's config.
        let port = AppProfile.current.isActive ? AppProfile.current.defaultGatewayPort : 29872
        let config = directory.appendingPathComponent("openclaw.json")
        try Data("{\"gateway\":{\"mode\":\"local\",\"port\":\(port)}}".utf8).write(to: config)
        try await TestIsolation.withIsolatedState(
            launchAgentHomeDirectory: directory,
            env: ["OPENCLAW_CONFIG_PATH": config.path, "OPENCLAW_GATEWAY_PORT": nil],
            defaults: [GatewayLaunchAgentManager.resumeCommandKey: nil, postAppUpdateReceiptKey: nil])
        {
            GatewayLaunchAgentManager.setTestingInterceptDaemonCommands(true)
            GatewayLaunchAgentManager.setTestingDaemonStatusPayload(#"{"ok":true,"service":{"loaded":false}}"#)
            GatewayLaunchAgentManager.clearTestingDaemonCommandCalls()
            defer {
                GatewayLaunchAgentManager.setTestingInterceptDaemonCommands(false)
                GatewayLaunchAgentManager.setTestingDaemonStatusPayload(nil)
            }
            let manager = GatewayProcessManager()
            manager.retainedServiceCLI = Fixture().candidate.cli
            manager.desiredActive = true
            manager.nodeMigrationFailure = "The Node update needs repair."
            if failureSource != "memory" {
                try PostAppUpdateReceiptStore.recordSetupRecovery(fromVersion: "2026.8.1", toVersion: "2026.9.6")
                if failureSource == "pause" {
                    manager.nodeMigrationAttempted = true
                    manager.stop()
                    await manager.waitForPendingLaunchAgentDisable()
                    #expect(!manager.nodeMigrationAttempted)
                    manager.desiredActive = true
                } else {
                    manager.nodeMigrationFailure = nil
                }
            }
            defer { manager.desiredActive = false }
            GatewayLaunchAgentManager.clearTestingDaemonCommandCalls()
            let result = await manager.enableLaunchAgentIfNeeded(port: port)
            #expect(result.error?.localizedCaseInsensitiveContains("repair") == true)
            #expect(!result.installed)
            #expect(GatewayLaunchAgentManager.testingDaemonCommandCallsSnapshot()
                .allSatisfy { $0.first != "install" })
        }
    }

    @Test(arguments: [false, true])
    func `transformed Bun install keeps original inferred Node authority at final dispatch`(
        operatorReplacesWrapper: Bool) async throws
    {
        let home = try makeTempDirForTests()
        defer { try? FileManager.default.removeItem(at: home) }
        let state = AppProfile.current.stateDirectoryURL(homeDirectory: home)
        let node = state.appendingPathComponent("tools/node/bin/node")
        let package = state.appendingPathComponent("tools/node/lib/node_modules/openclaw")
        let wrapper = state.appendingPathComponent("bin/openclaw")
        for directory in [node.deletingLastPathComponent(), package, wrapper.deletingLastPathComponent()] {
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        }
        try Data().write(to: node)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: node.path)
        try Data().write(to: package.appendingPathComponent("openclaw.mjs"))
        try Data(#"{"name":"openclaw","version":"2026.9.6"}"#.utf8)
            .write(to: package.appendingPathComponent("package.json"))
        let config = state.appendingPathComponent("openclaw.json")
        try Data(#"{"gateway":{"mode":"local"}}"#.utf8).write(to: config)
        try await TestIsolation.withIsolatedState(
            launchAgentHomeDirectory: home,
            env: ["OPENCLAW_CONFIG_PATH": config.path, "OPENCLAW_STATE_DIR": state.path],
            defaults: [cliInstallPolicyKey: "exact", connectionModeKey: "local"])
        {
            GatewayLaunchAgentManager.setTestingDisableLaunchAgentMarkerURL(home.appendingPathComponent("disabled"))
            GatewayLaunchAgentManager.setTestingInterceptDaemonCommands(true)
            GatewayLaunchAgentManager.setTestingDaemonStatusPayload("""
            {"ok":true,"service":{"runtimeIntent":{"status":"known","revision":"absent"}}}
            """)
            GatewayLaunchAgentManager.clearTestingDaemonCommandCalls()
            defer {
                GatewayLaunchAgentManager.setTestingDisableLaunchAgentMarkerURL(nil)
                GatewayLaunchAgentManager.setTestingInterceptDaemonCommands(false)
                GatewayLaunchAgentManager.setTestingDaemonStatusPayload(nil)
            }
            let authority = try #require(try GatewayLaunchAgentManager.legacyManagedNodeCLI(homeDirectory: home))
            #expect(authority.isInferredLegacyInstall)
            let runtime = BundledRuntime(root: state.appendingPathComponent("runtime/verified-build"))
            let result = await GatewayLaunchAgentManager.runDaemonCommand(
                ["install", "--force"],
                runtime: runtime,
                legacyAuthority: authority,
                checkCurrent: {
                    await Task.yield()
                    let text = operatorReplacesWrapper
                        ? "#!/bin/sh\nexec /operator/openclaw \"$@\"\n"
                        : "#!/bin/sh\n# OpenClaw.app managed CLI (bundled runtime)\n"
                    try Data(text.utf8).write(to: wrapper)
                })
            let dispatched = GatewayLaunchAgentManager.testingResolvedDaemonCommandsSnapshot()
                .filter { $0.contains("install") }
            if operatorReplacesWrapper {
                #expect(result != nil)
                #expect(dispatched.isEmpty)
            } else {
                #expect(result == nil)
                #expect(dispatched.count == 1)
                #expect(dispatched.first.map { Array($0.prefix(2)) } == runtime.cliCommand)
            }
        }
    }

    @Test func `revoked migration lifecycle cannot dispatch Bun after custody inspection`() async throws {
        let directory = try makeTempDirForTests()
        defer { try? FileManager.default.removeItem(at: directory) }
        try await TestIsolation.withIsolatedState(launchAgentHomeDirectory: directory) {
            let fixture = Fixture()
            let candidate = fixture.candidate
            let snapshot = try #require(candidate.snapshot)
            let plist = GatewayLaunchAgentManager.plistURL(homeDirectory: directory, profile: .current)
            try FileManager.default.createDirectory(
                at: plist.deletingLastPathComponent(), withIntermediateDirectories: true)
            try PropertyListSerialization.data(
                fromPropertyList: [
                    "ProgramArguments": snapshot.programArguments,
                    "EnvironmentVariables": snapshot.environment,
                ],
                format: .xml,
                options: 0).write(to: plist)
            GatewayLaunchAgentManager.setTestingInterceptDaemonCommands(true)
            GatewayLaunchAgentManager.setTestingDaemonStatusPayload(#"{"ok":true}"#)
            GatewayLaunchAgentManager.clearTestingDaemonCommandCalls()
            defer {
                GatewayLaunchAgentManager.setTestingInterceptDaemonCommands(false)
                GatewayLaunchAgentManager.setTestingDaemonStatusPayload(nil)
            }
            let live = ManagedNodeGatewayMigration.liveOperations(
                checkCurrent: { throw CancellationError() },
                restorationInstaller: {
                    Issue.record("Verifying the original Node service must not resolve an installer")
                    throw CancellationError()
                },
                verifyHealth: {},
                setServiceHosting: { _ in },
                statusHandler: { _ in })
            await #expect(throws: CancellationError.self) {
                try await live.install(candidate, fixture.runtime)
            }
            #expect(GatewayLaunchAgentManager.testingDaemonCommandCallsSnapshot().isEmpty)
            #expect(GatewayLaunchAgentManager.launchdConfigSnapshot() == candidate.snapshot)
            // The admitted drain can verify its unchanged original Node service even after pause/quit.
            try await live.restore(candidate)
            #expect(GatewayLaunchAgentManager.testingDaemonCommandCallsSnapshot().isEmpty)
        }
    }

    @Test func `pause resume metadata retains Node paths without persisting service credentials`() throws {
        let previous = Fixture().candidate.cli
        let data = try GatewayLaunchAgentManager.resumeData(for: previous)
        let restored = try GatewayLaunchAgentManager.retainedServiceIntent(
            from: data, stateDirectory: URL(fileURLWithPath: "/fixture"))
        #expect(restored.prefix == previous.prefix)
        #expect(restored.environment.isEmpty)
        let encoded = try #require(String(bytes: data, encoding: .utf8))
        #expect(!encoded.contains("CHANNEL_FIXTURE"))
        let external = try JSONSerialization.data(withJSONObject: [
            "prefix": ["/operator/node", "/operator/openclaw.mjs"],
        ])
        #expect(throws: GatewayHostingError.self) {
            try GatewayLaunchAgentManager.retainedServiceIntent(
                from: external, stateDirectory: URL(fileURLWithPath: "/fixture"))
        }
    }

    @Test func `saved intent excludes app managed Node without database writes`() async throws {
        let directory = try makeTempDirForTests()
        defer { try? FileManager.default.removeItem(at: directory) }
        let profile = AppProfile(environment: [:])
        let configPath = directory.appendingPathComponent("openclaw.json").path
        let key = try GatewayLaunchAgentManager.runtimePinKey(profile: profile, configPath: configPath)
        #expect(try GatewayLaunchAgentManager.runtimePinKey(
            profile: profile, configPath: "/fixture/.openclaw/openclaw.json") ==
            "daemon-runtime-pin:a1802840aaccdcabb68bb73a9cfb580598364ace9d5232d2d10f2446bdb51e35")
        let databaseURL = directory.appendingPathComponent("state/openclaw.sqlite")
        try Self.writePinFixture(databaseURL: databaseURL, key: key)
        let before = try Data(contentsOf: databaseURL)
        #expect(try await GatewayLaunchAgentManager.hasRuntimePin(stateDirectory: directory, profile: profile))
        let pin = try #require(try await GatewayLaunchAgentManager.runtimePinRecord(
            stateDirectory: directory, profile: profile))
        #expect(pin.updatedAtMilliseconds == 1)
        #expect(pin.value.contains(#""path":"/fixture/tools/node/bin/node""#))
        #expect(try Data(contentsOf: databaseURL) == before)
        #expect(try await !GatewayLaunchAgentManager.hasRuntimePin(
            stateDirectory: directory, profile: AppProfile(environment: ["OPENCLAW_PROFILE": "other"])))
    }

    @Test func `rollback preserves external changes to service bytes or runtime intent`() throws {
        func definition(
            workingDirectory: String,
            environment: String = "export FIXTURE='value'",
            wrapper: String = "exec \"$@\"") throws -> GatewayLaunchAgentManager.ServiceDefinitionDigest
        {
            let plist = try PropertyListSerialization.data(
                fromPropertyList: ["WorkingDirectory": workingDirectory, "ProgramArguments": ["/fixture/bun"]],
                format: .xml,
                options: 0)
            return .init(plist: plist, environment: Data(environment.utf8), wrapper: Data(wrapper.utf8))
        }
        let original = try ManagedNodeGatewayMigration.ServiceCustody(
            definition: definition(workingDirectory: "/fixture/node"), runtimePin: nil)
        let pin = OpenClawNativeStateConfigValue(value: "bundled-pin", updatedAtMilliseconds: 1)
        let installed = try ManagedNodeGatewayMigration.ServiceCustody(
            definition: definition(workingDirectory: "/fixture/bun"), runtimePin: pin)
        let custody = ManagedNodeGatewayMigration.RestorationCustody()
        custody.original = original
        // An installer failure that preserved the original Node service requires only health verification.
        #expect(try custody.action(current: original) == .verifyOriginalNode)
        #expect(throws: ManagedNodeGatewayMigration.Failure.self) { try custody.action(current: installed) }
        custody.installed = installed
        #expect(try custody.action(current: installed) == .restoreNode)
        for changed in try [
            ManagedNodeGatewayMigration.ServiceCustody(
                definition: definition(workingDirectory: "/operator/workspace"), runtimePin: pin),
            .init(definition: definition(workingDirectory: "/fixture/bun", environment: "changed"), runtimePin: pin),
            .init(definition: definition(workingDirectory: "/fixture/bun", wrapper: "changed"), runtimePin: pin),
            .init(definition: installed.definition, runtimePin: .init(value: "operator-pin", updatedAtMilliseconds: 1)),
            .init(definition: installed.definition, runtimePin: .init(value: pin.value, updatedAtMilliseconds: 2)),
            .init(definition: installed.definition, runtimePin: nil),
        ] {
            #expect(throws: ManagedNodeGatewayMigration.Failure.self) { try custody.action(current: changed) }
        }
    }

    @Test func `absent original service permits Node restoration only while absence is unchanged`() throws {
        let original = ManagedNodeGatewayMigration.ServiceCustody(
            definition: .init(plist: nil, environment: Data("retained env".utf8), wrapper: Data("wrapper".utf8)),
            runtimePin: nil)
        let custody = ManagedNodeGatewayMigration.RestorationCustody()
        custody.original = original
        #expect(try custody.action(current: original) == .restoreNode)
        for changed in [
            ManagedNodeGatewayMigration.ServiceCustody(
                definition: .init(plist: Data("external service".utf8), environment: nil, wrapper: nil),
                runtimePin: nil),
            .init(
                definition: .init(plist: nil, environment: Data("changed".utf8), wrapper: Data("wrapper".utf8)),
                runtimePin: nil),
            .init(definition: original.definition, runtimePin: .init(value: "operator", updatedAtMilliseconds: 1)),
        ] {
            #expect(throws: ManagedNodeGatewayMigration.Failure.self) { try custody.action(current: changed) }
        }
    }

    @Test func `installer errors retain custody of a published Bun service before rollback`() async throws {
        let original = ManagedNodeGatewayMigration.ServiceCustody(
            definition: .init(plist: Data("Node".utf8), environment: nil, wrapper: nil), runtimePin: nil)
        let definition = GatewayLaunchAgentManager.ServiceDefinitionDigest(
            plist: Data("Bun".utf8), environment: Data("synthetic".utf8), wrapper: nil)
        let pins: [OpenClawNativeStateConfigValue?] = [nil, .init(value: "bundled-pin", updatedAtMilliseconds: 1)]
        for pin in pins {
            let published = ManagedNodeGatewayMigration.ServiceCustody(definition: definition, runtimePin: pin)
            let custody = ManagedNodeGatewayMigration.RestorationCustody()
            custody.original = original
            await #expect(throws: ManagedNodeGatewayMigration.Failure.self) {
                try await custody.finishInstall(error: "installer timed out after publication") { published }
            }
            #expect(try custody.action(current: published) == .restoreNode)
        }
        let custody = ManagedNodeGatewayMigration.RestorationCustody()
        custody.original = original
        do {
            try await custody.finishInstall(error: "installer failed") {
                throw ManagedNodeGatewayMigration.Failure(message: "capture rejected")
            }
            Issue.record("Expected the installer error")
        } catch {
            #expect(error.localizedDescription == "installer failed")
        }
        #expect(try custody.action(current: original) == .verifyOriginalNode)
        let foreign = ManagedNodeGatewayMigration.ServiceCustody(
            definition: definition, runtimePin: .init(value: "operator-pin", updatedAtMilliseconds: 2))
        #expect(throws: ManagedNodeGatewayMigration.Failure.self) { try custody.action(current: foreign) }
    }

    @Test func `missing pin exception still rejects conflicting recorded intent`() throws {
        let runtime = BundledRuntime(root: URL(fileURLWithPath: "/fixture/runtime/build"))
        #expect(!ManagedNodeGatewayMigration.runtimePinMatchesInstallation(
            nil, runtime: runtime, definition: "expected", allowMissing: false))
        #expect(ManagedNodeGatewayMigration.runtimePinMatchesInstallation(
            nil, runtime: runtime, definition: "expected", allowMissing: true))
        for (path, binding, accepted) in [
            (runtime.bun.path, "expected", true),
            ("/operator/bin/bun", "expected", false),
            (runtime.bun.path, "other-definition", false),
        ] {
            let value = try JSONSerialization.data(withJSONObject: [
                "version": 1,
                "pin": ["runtime": "bun", "path": path],
                "definition": binding,
            ])
            let record = try OpenClawNativeStateConfigValue(
                value: #require(String(bytes: value, encoding: .utf8)), updatedAtMilliseconds: 1)
            #expect(ManagedNodeGatewayMigration.runtimePinMatchesInstallation(
                record, runtime: runtime, definition: "expected", allowMissing: true) == accepted)
        }
    }

    fileprivate static func writePinFixture(databaseURL: URL, key: String) throws {
        let database = try OpenClawNativeStateSQLite(databaseURL: databaseURL)
        try database.execute("""
        PRAGMA user_version = 1;
        CREATE TABLE schema_meta (meta_key TEXT PRIMARY KEY, role TEXT, schema_version INTEGER);
        INSERT INTO schema_meta VALUES ('primary', 'global', 1);
        CREATE TABLE config_machine_state (state_key TEXT PRIMARY KEY, value_json TEXT, updated_at_ms INTEGER);
        """)
        let insert = try database.prepare("INSERT INTO config_machine_state VALUES (?, ?, 1)")
        try insert.bindText(key, at: 1)
        try insert.bindText(
            #"{"version":1,"pin":{"runtime":"node","path":"/fixture/tools/node/bin/node"},"definition":"fixture"}"#,
            at: 2)
        _ = try insert.step()
    }

    @Test func `managed Node ownership excludes external binaries and links`() throws {
        let directory = try makeTempDirForTests()
        defer { try? FileManager.default.removeItem(at: directory) }
        let state = directory.appendingPathComponent("profile")
        let tools = state.appendingPathComponent("tools")
        let external = directory.appendingPathComponent("operator")
        try FileManager.default.createDirectory(at: tools, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(
            at: external.appendingPathComponent("bin"),
            withIntermediateDirectories: true)
        try Data().write(to: external.appendingPathComponent("bin/node"))
        try FileManager.default.createSymbolicLink(
            at: tools.appendingPathComponent("node"),
            withDestinationURL: external)
        #expect(!GatewayLaunchAgentManager.isManagedNode(
            tools.appendingPathComponent("node/bin/node").path,
            stateDirectory: state))
        #expect(GatewayLaunchAgentManager.isManagedNode(
            tools.appendingPathComponent("node-26/bin/node").path,
            stateDirectory: state))
        #expect(!GatewayLaunchAgentManager.isManagedNode(
            external.appendingPathComponent("bin/node").path,
            stateDirectory: state))
    }
}

/// This suite already runs in the named-profile native-test lane. The real candidate
/// reader uses the process profile; a helper-only admission test would miss its gate.
@MainActor
extension AppStateIsolationTests {
    private struct NodeMigrationFixture: Sendable {
        let cli: GatewayLaunchAgentManager.InstalledServiceCLI
        let plist: URL
        let disableMarker: URL
        let version = "2026.9.6"
        let port = AppProfile.current.defaultGatewayPort

        func writeService(entrypoint: String? = nil) throws {
            let script = try #require(entrypoint ?? self.cli.prefix.last)
            try FileManager.default.createDirectory(
                at: self.plist.deletingLastPathComponent(),
                withIntermediateDirectories: true)
            try PropertyListSerialization.data(
                fromPropertyList: ["ProgramArguments": Array(self.cli.prefix.dropLast()) +
                    [script, "gateway", "--port", String(self.port)]],
                format: .xml,
                options: 0).write(to: self.plist)
        }
    }

    private func withNodeMigrationFixture(
        _ body: (NodeMigrationFixture) async throws -> Void) async throws
    {
        try #require(AppProfile.current.isActive)
        let home = try makeTempDirForTests()
        defer { try? FileManager.default.removeItem(at: home) }
        let state = AppProfile.current.stateDirectoryURL()
        let nodeRoot = state.appendingPathComponent("tools/node-probe-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: nodeRoot) }
        let node = nodeRoot.appendingPathComponent("bin/node")
        let entry = nodeRoot.appendingPathComponent("lib/node_modules/openclaw/dist/entry.js")
        try FileManager.default.createDirectory(at: node.deletingLastPathComponent(), withIntermediateDirectories: true)
        try FileManager.default.createDirectory(
            at: entry.deletingLastPathComponent(),
            withIntermediateDirectories: true)
        // Only --version reaches this script. Daemon mutations are intercepted below.
        try Data("#!/bin/sh\nprintf '%s\\n' '2026.9.6'\n".utf8).write(to: node)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: node.path)
        try Data().write(to: entry)
        // Make the existing listener probe deterministic without opening sockets or inspecting host processes.
        try FileManager.default.createSymbolicLink(
            at: node.deletingLastPathComponent().appendingPathComponent("lsof"),
            withDestinationURL: URL(fileURLWithPath: "/usr/bin/false"))
        let fixture = NodeMigrationFixture(
            cli: .init(prefix: [node.path, entry.path], sqliteLibrary: nil),
            plist: GatewayLaunchAgentManager.plistURL(homeDirectory: home, profile: .current),
            disableMarker: home.appendingPathComponent("disabled"))
        try await TestIsolation.withIsolatedState(
            launchAgentHomeDirectory: home,
            env: ["OPENCLAW_STATE_DIR": state.path, "PATH": node.deletingLastPathComponent().path + ":/usr/bin:/bin"],
            defaults: [postAppUpdateReceiptKey: nil])
        {
            GatewayLaunchAgentManager.setTestingDisableLaunchAgentMarkerURL(fixture.disableMarker)
            GatewayLaunchAgentManager.setTestingInterceptDaemonCommands(true)
            GatewayLaunchAgentManager.setTestingDaemonStatusPayload(#"{"ok":true,"service":{"loaded":false}}"#)
            GatewayLaunchAgentManager.clearTestingDaemonCommandCalls()
            defer {
                GatewayLaunchAgentManager.setTestingDisableLaunchAgentMarkerURL(nil)
                GatewayLaunchAgentManager.setTestingInterceptDaemonCommands(false)
                GatewayLaunchAgentManager.setTestingDaemonStatusPayload(nil)
                GatewayLaunchAgentManager.clearTestingDaemonCommandCalls()
            }
            try await body(fixture)
        }
    }

    @Test func `managed Node Retry cannot adopt Resume intent after Stop during startup drain`() async throws {
        try await self.withNodeMigrationFixture { _ in
            let manager = GatewayProcessManager()
            let state = AppStateStore.shared
            let priorMode = state.connectionMode
            let priorPause = state.isPaused
            state.connectionMode = .local
            state.isPaused = false
            let defaults = AppDefaults.standard
            let keys = [onboardingSeenKey, GatewayLaunchAgentManager.resumeCommandKey]
            let saved = keys.map { ($0, defaults.object(forKey: $0)) }
            defaults.set(false, forKey: onboardingSeenKey)
            defaults.removeObject(forKey: GatewayLaunchAgentManager.resumeCommandKey)
            defer {
                manager._testResetGatewayStartTask()
                state.connectionMode = priorMode
                state.isPaused = priorPause
                for (key, value) in saved {
                    if let value { defaults.set(value, forKey: key) } else { defaults.removeObject(forKey: key) }
                }
            }
            let entered = AsyncTestGate()
            let release = AsyncTestGate()
            defer { release.open() }
            let generation = manager.gatewayStartGeneration
            manager.desiredActive = true
            manager.beginGatewayStartTask(generation: generation) {
                entered.open()
                await release.wait()
            }
            let newerIntent = Task { @MainActor in
                await entered.wait()
                manager.stop()
                await manager.waitForPendingLaunchAgentDisable()
                manager.hostingChangeInProgress = true
                manager.setActive(true, source: .request)
                release.open()
            }
            do {
                try await manager.retryManagedNodeMigration()
                Issue.record("Stale Node Retry adopted the newer Resume intent")
            } catch {
                #expect(error is CancellationError)
            }
            await newerIntent.value
            #expect(manager.gatewayStartGeneration == generation + 1)
            #expect(manager.desiredActive)
            #expect(manager.status == .stopped)
            #expect(!GatewayLaunchAgentManager.testingDaemonCommandCallsSnapshot().contains { $0.first == "install" })
        }
    }

    private nonisolated static func observeNodeProbe(
        descriptor: Int32, ready: AsyncTestGate, closed: AsyncTestGate) -> any DispatchSourceRead
    {
        let source = DispatchSource.makeReadSource(fileDescriptor: descriptor, queue: .global())
        source.setEventHandler {
            var byte: UInt8 = 0
            if read(descriptor, &byte, 1) > 0 { ready.open() }
        }
        source.setCancelHandler {
            _ = close(descriptor)
            closed.open()
        }
        source.activate()
        return source
    }

    @Test func `managed Node Retry preserves Stop while its installed candidate version probe finishes`() async throws {
        try await self.withNodeMigrationFixture { fixture in
            let manager = GatewayProcessManager()
            let state = AppStateStore.shared
            let prior = (state.connectionMode, state.isPaused, state.onboardingSeen)
            let defaults = AppDefaults.standard
            let keys = [
                onboardingSeenKey,
                pauseDefaultsKey,
                cliInstallPolicyKey,
                GatewayHosting.defaultsKey,
                GatewayLaunchAgentManager.resumeCommandKey,
            ]
            let saved = keys.map { ($0, defaults.object(forKey: $0)) }
            state.connectionMode = .local
            state.isPaused = false
            state.onboardingSeen = true
            defaults.set(true, forKey: onboardingSeenKey)
            defaults.set(false, forKey: pauseDefaultsKey)
            defaults.set("exact", forKey: cliInstallPolicyKey)
            defaults.set("service", forKey: GatewayHosting.defaultsKey)
            manager.retainedServiceCLI = fixture.cli
            manager.desiredActive = true
            manager.nodeMigrationFailure = "previous runtime switch failed"
            defer {
                manager._testSetLaunchAgentDisableWaitHook(nil)
                manager._testResetGatewayStartTask()
                state.connectionMode = prior.0
                state.isPaused = prior.1
                state.onboardingSeen = prior.2
                for (key, value) in saved {
                    if let value { defaults.set(value, forKey: key) } else { defaults.removeObject(forKey: key) }
                }
            }
            try fixture.writeService()
            let candidate = try #require(try await ManagedNodeGatewayMigration.candidate(
                onboardingSeen: true, installPolicy: "exact", retainedCLI: fixture.cli, allowNamedServiceRetry: true))
            try #require(candidate.snapshot != nil)
            let node = try URL(fileURLWithPath: #require(fixture.cli.prefix.first))
            let readyFIFO = node.deletingLastPathComponent().appendingPathComponent("version-ready")
            let releaseFIFO = node.deletingLastPathComponent().appendingPathComponent("version-release")
            try #require(mkfifo(readyFIFO.path, 0o600) == 0)
            try #require(mkfifo(releaseFIFO.path, 0o600) == 0)
            let readyFD = open(readyFIFO.path, O_RDWR | O_NONBLOCK)
            try #require(readyFD >= 0)
            let releaseFD = open(releaseFIFO.path, O_RDWR | O_NONBLOCK)
            guard releaseFD >= 0 else {
                _ = close(readyFD)
                throw POSIXError(.EIO)
            }
            let probeReady = AsyncTestGate()
            let readerClosed = AsyncTestGate()
            let source = Self.observeNodeProbe(descriptor: readyFD, ready: probeReady, closed: readerClosed)
            let uninstallEntered = AsyncTestGate()
            let releaseUninstall = AsyncTestGate()
            let decisionReached = AsyncTestGate()
            func releaseVersion() {
                _ = "go\n".withCString { write(releaseFD, $0, 3) }
            }
            defer {
                releaseVersion()
                releaseUninstall.open()
                source.cancel()
                _ = close(releaseFD)
            }
            let originalNode = try Data(contentsOf: node)
            try Data("""
            #!/bin/sh
            printf r > "${0%/*}/version-ready"
            IFS= read -r ignored < "${0%/*}/version-release"
            printf '%s\\n' '2026.9.6'

            """.utf8).write(to: node)
            GatewayLaunchAgentManager.clearTestingDaemonCommandCalls()
            GatewayLaunchAgentManager.setTestingInterceptDaemonCommands(true) { arguments in
                guard arguments.first == "uninstall" else { return }
                uninstallEntered.open()
                await releaseUninstall.wait()
            }
            let retry = Task { @MainActor in
                defer { probeReady.open()
                    decisionReached.open()
                }
                try await manager.retryManagedNodeMigration()
            }
            await probeReady.wait()
            manager.stop()
            let stoppedGeneration = manager.gatewayStartGeneration
            let drain = Task { @MainActor in
                await manager.waitForPendingLaunchAgentDisable()
                uninstallEntered.open()
            }
            await uninstallEntered.wait()
            #expect(GatewayLaunchAgentManager.testingDaemonCommandCallsSnapshot().contains { $0.first == "uninstall" })
            #expect(manager.status == .stopped)
            manager._testSetLaunchAgentDisableWaitHook { decisionReached.open() }
            releaseVersion()
            await decisionReached.wait()
            #expect(!manager.desiredActive)
            #expect(!manager.nodeMigrationAttempted)
            #expect(manager.gatewayStartGeneration == stoppedGeneration)
            #expect(manager.status == .stopped)
            manager._testSetLaunchAgentDisableWaitHook(nil)
            releaseUninstall.open()
            await drain.value
            await #expect(throws: CancellationError.self) { try await retry.value }
            #expect(!GatewayLaunchAgentManager.testingDaemonCommandCallsSnapshot().contains { $0.first == "install" })
            try originalNode.write(to: node)
            GatewayLaunchAgentManager.setTestingInterceptDaemonCommands(true)
            manager.setActive(true, source: .request)
            #expect(manager.gatewayStartTask != nil)
            let resumed = manager.gatewayStartTask
            manager._testResetGatewayStartTask()
            await resumed?.value
            source.cancel()
            await readerClosed.wait()
        }
    }

    @Test(arguments: ["same-entry", "service-index", "different-package"])
    func `explicit named rollback Retry reaches real candidate admission`(_ layout: String) async throws {
        try await self.withNodeMigrationFixture { fixture in
            let retainedEntry = try #require(fixture.cli.prefix.last)
            let package = URL(fileURLWithPath: retainedEntry).deletingLastPathComponent().deletingLastPathComponent()
            let entrypoint: String = switch layout {
            case "service-index": package.appendingPathComponent("dist/index.js").path
            case "different-package":
                package.deletingLastPathComponent()
                    .appendingPathComponent("other-openclaw/dist/index.js").path
            default: retainedEntry
            }
            try fixture.writeService(entrypoint: entrypoint)
            #expect(try await ManagedNodeGatewayMigration.candidate(
                onboardingSeen: true, installPolicy: "exact", retainedCLI: fixture.cli) == nil)
            let candidate = try await ManagedNodeGatewayMigration.candidate(
                onboardingSeen: true,
                installPolicy: "exact",
                retainedCLI: fixture.cli,
                allowNamedServiceRetry: true)
            if layout == "different-package" {
                #expect(candidate == nil)
            } else {
                let admitted = try #require(candidate)
                #expect(admitted.allowsNamedServiceRetry)
                #expect(admitted.version == fixture.version)
                #expect(admitted.cli.prefix.first == fixture.cli.prefix.first)
                #expect(admitted.cli.prefix.last == entrypoint)
            }
            #expect(GatewayLaunchAgentManager.testingDaemonCommandCallsSnapshot().isEmpty)
        }
    }

    @Test func `operator repin before Node rollback dispatch is preserved, not overwritten`() async throws {
        try await self.withNodeMigrationFixture { fixture in
            let state = AppProfile.current.stateDirectoryURL()
            let databaseURL = state.appendingPathComponent("state/openclaw.sqlite")
            try #require(!FileManager.default.fileExists(atPath: databaseURL.path))
            defer {
                for path in [databaseURL.path, databaseURL.path + "-wal", databaseURL.path + "-shm"] {
                    try? FileManager.default.removeItem(atPath: path)
                }
            }
            let key = try GatewayLaunchAgentManager.runtimePinKey(
                profile: .current, configPath: state.appendingPathComponent("openclaw.json").path)
            let installer = BundledRuntime(root: fixture.disableMarker.deletingLastPathComponent()
                .appendingPathComponent("runtime/current-build"))
            let refusal = GatewayLaunchAgentManager.runtimePinSelectionChanged
            GatewayLaunchAgentManager.setTestingDaemonStatusPayload("""
            {"ok":true,"service":{"loaded":false,
            "runtimeIntent":{"status":"known","revision":"before-rollback"}}}
            """)
            GatewayLaunchAgentManager.setTestingInterceptDaemonCommands(true) { args in
                if args.first == "status", !args.contains("--deep"),
                   GatewayLaunchAgentManager.testingDaemonCommandCallsSnapshot()
                       .contains(where: { $0.contains("--deep") })
                {
                    // The intercept reserves this final absence response before the hook. Only
                    // the bundled observation arms the following install's stale-expectation refusal.
                    GatewayLaunchAgentManager.setTestingDaemonStatusPayload("""
                    {"ok":false,"error":"\(refusal)"}
                    """)
                } else if args.first == "install" {
                    do {
                        try await ManagedNodeGatewayMigrationTests.writePinFixture(databaseURL: databaseURL, key: key)
                        if !args.contains("--expected-runtime-pin") {
                            let database = try OpenClawNativeStateSQLite(databaseURL: databaseURL)
                            try database.execute("DELETE FROM config_machine_state")
                        }
                    } catch { Issue.record(error) }
                }
            }
            let node = try #require(fixture.cli.prefix.first)
            let entrypoint = try #require(fixture.cli.prefix.last)
            let candidate = ManagedNodeGatewayMigration.Candidate(
                cli: fixture.cli, snapshot: nil, version: fixture.version, port: fixture.port, allowUnconfigured: false)
            var healthChecks = 0
            var operations = ManagedNodeGatewayMigration.liveOperations(
                checkCurrent: {},
                resolveLegacyCLI: { throw ManagedNodeGatewayMigration.Failure(message: "pre-seed probe failed") },
                restorationInstaller: { installer },
                verifyHealth: { healthChecks += 1 },
                setServiceHosting: { _ in },
                statusHandler: { _ in })
            operations.recapture = { previous, _ in previous }
            do {
                _ = try await ManagedNodeGatewayMigration.run(
                    candidate: candidate, targetVersion: fixture.version, operations: operations)
                Issue.record("Expected the Node rollback custody refusal")
            } catch {
                #expect(error.localizedDescription.contains("Node restoration also failed: " + refusal))
            }
            #expect(healthChecks == 0)
            #expect(try await GatewayLaunchAgentManager
                .runtimePinRecord(stateDirectory: state, profile: .current) != nil)
            let calls = GatewayLaunchAgentManager.testingDaemonCommandCallsSnapshot()
            let installs = calls.filter { $0.first == "install" }
            #expect(installs.count == 1)
            let install = try #require(installs.first)
            #expect(install == [
                "install", "--force", "--port", String(fixture.port), "--runtime", "node",
                "--restore-service-cli",
                #"{"entrypoint":"\#(entrypoint)","executable":"\#(node)","sqliteLibrary":null}"#,
                "--expected-runtime-pin", #"{"definition":null,"revision":"before-rollback"}"#,
            ])
            #expect(calls.last == install)
            let commands = GatewayLaunchAgentManager.testingResolvedDaemonCommandsSnapshot()
            #expect(commands.count == 4)
            #expect(commands.map { Array($0.prefix(2)) } == [
                fixture.cli.prefix, installer.cliCommand, fixture.cli.prefix, installer.cliCommand,
            ])
        }
    }

    @Test(arguments: ["unchanged", "definition", "attach-only", "missing-installer"])
    func `pre-seed probe failure restores absent Node only while its original custody remains`(
        ownershipChange: String) async throws
    {
        try await self.withNodeMigrationFixture { fixture in
            let node = try #require(fixture.cli.prefix.first)
            let entrypoint = try #require(fixture.cli.prefix.last)
            let candidate = ManagedNodeGatewayMigration.Candidate(
                cli: fixture.cli, snapshot: nil, version: fixture.version, port: fixture.port, allowUnconfigured: false)
            let installer = BundledRuntime(root: fixture.disableMarker.deletingLastPathComponent()
                .appendingPathComponent("runtime/current-build"))
            GatewayLaunchAgentManager.setTestingDaemonStatusPayload("""
            {"ok":true,"service":{"loaded":false,"runtimeIntent":{"status":"known","revision":"absent"}}}
            """)
            var installerResolutions = 0
            var healthChecks = 0
            var operations = ManagedNodeGatewayMigration.liveOperations(
                checkCurrent: {},
                resolveLegacyCLI: {
                    if ownershipChange == "definition" { try fixture.writeService() }
                    if ownershipChange == "attach-only" { try Data().write(to: fixture.disableMarker) }
                    throw ManagedNodeGatewayMigration.Failure(message: "retained selection probe failed")
                },
                restorationInstaller: { installerResolutions += 1
                    if ownershipChange == "missing-installer" {
                        throw ManagedNodeGatewayMigration.Failure(message: "Reinstall OpenClaw.app.")
                    }
                    return installer
                },
                verifyHealth: { healthChecks += 1 },
                setServiceHosting: { _ in },
                statusHandler: { _ in })
            // The candidate was already verified after core update; fail the real pre-seed revalidation.
            operations.recapture = { previous, _ in previous }
            do {
                _ = try await ManagedNodeGatewayMigration.run(
                    candidate: candidate, targetVersion: fixture.version, operations: operations)
                Issue.record("Expected the pre-seed migration failure")
            } catch {
                #expect(error.localizedDescription.contains("retained selection probe failed"))
                if ownershipChange == "missing-installer" {
                    #expect(error.localizedDescription
                        .contains("Node restoration also failed: Reinstall OpenClaw.app."))
                }
            }
            let installs = GatewayLaunchAgentManager.testingDaemonCommandCallsSnapshot()
                .filter { $0.first == "install" }
            #expect(installs == (ownershipChange != "unchanged" ? [] : [
                [
                    "install",
                    "--force",
                    "--port",
                    String(fixture.port),
                    "--runtime",
                    "node",
                    "--restore-service-cli",
                    #"{"entrypoint":"\#(entrypoint)","executable":"\#(node)","sqliteLibrary":null}"#,
                    "--expected-runtime-pin",
                    #"{"definition":null,"revision":"absent"}"#,
                ],
            ]))
            #expect(installerResolutions == (["unchanged", "missing-installer"].contains(ownershipChange) ? 1 : 0))
            let commands = GatewayLaunchAgentManager.testingResolvedDaemonCommandsSnapshot()
                .filter { $0.contains("--deep") || $0.contains("install") }
            #expect(commands.count == (ownershipChange == "unchanged" ? 2 : 0))
            #expect(commands.allSatisfy { Array($0.prefix(2)) == installer.cliCommand })
            #expect(healthChecks == (ownershipChange == "unchanged" ? 1 : 0))
        }
    }
}
