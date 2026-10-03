import Foundation
import Testing
@testable import OpenClaw

@MainActor
struct BundledGatewayPreparationTests {
    fileprivate struct Fixture {
        let root: URL
        let state: URL
        let nodeRoot: URL
        let cli: GatewayLaunchAgentManager.InstalledServiceCLI
        let plist: URL

        init(
            home: URL,
            inferredLegacy: Bool = false,
            stateDirectory: URL? = nil,
            nodeService: Bool = false) throws
        {
            let state = stateDirectory ?? (inferredLegacy ? AppProfile.current.stateDirectoryURL(homeDirectory: home) :
                AppProfile.current.stateDirectoryURL())
            self.state = state
            let id = UUID().uuidString
            self.root = state.appendingPathComponent("onboarding-\(id)")
            self.nodeRoot = state.appendingPathComponent("tools/node-\(id)")
            let node = self.nodeRoot.appendingPathComponent("bin/node")
            let entry = inferredLegacy
                ? self.nodeRoot.appendingPathComponent("lib/node_modules/openclaw/openclaw.mjs")
                : self.root.appendingPathComponent("openclaw.mjs")
            self.cli = .init(prefix: [node.path, entry.path], sqliteLibrary: nil)
            self.plist = nodeService
                ? home.appendingPathComponent("Library/LaunchAgents/\(nodeLaunchdLabel).plist")
                : GatewayLaunchAgentManager.plistURL(homeDirectory: home, profile: .current)
            for directory in [
                self.root, node.deletingLastPathComponent(), self.plist.deletingLastPathComponent(),
                entry.deletingLastPathComponent(),
            ] {
                try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            }
            if inferredLegacy {
                try Data().write(to: entry)
                try Data(#"{"name":"openclaw","version":"2026.8.1"}"#.utf8)
                    .write(to: entry.deletingLastPathComponent().appendingPathComponent("package.json"))
                try FileManager.default.createSymbolicLink(
                    at: state.appendingPathComponent("tools/node"), withDestinationURL: self.nodeRoot)
            }
            try "2026.8.1\n".write(to: self.root.appendingPathComponent("version"), atomically: true, encoding: .utf8)
            try """
            #!/bin/sh
            if [ "$#" -eq 1 ] && [ "$1" = --version ]; then
              printf '%s\n' 'v24.16.0'
              exit 0
            fi
            for argument in "$@"; do
              if [ "$argument" = --version ]; then
                read -r version < "$OPENCLAW_PREPARATION_FIXTURE_ROOT/version"
                printf 'OpenClaw %s\n' "$version"
                exit 0
              fi
            done
            printf '%s\n' "$*" >> "$OPENCLAW_PREPARATION_FIXTURE_ROOT/updates"
            if [ -f "$OPENCLAW_PREPARATION_FIXTURE_ROOT/advance" ]; then
              printf '%s\n' '2026.9.1' > "$OPENCLAW_PREPARATION_FIXTURE_ROOT/version"
            fi
            if [ -f "$OPENCLAW_PREPARATION_FIXTURE_ROOT/fail" ]; then
              printf '%s\n' '{"status":"error","reason":"fixture offline"}'
              exit 1
            fi
            printf '%s\n' '2026.9.1' > "$OPENCLAW_PREPARATION_FIXTURE_ROOT/version"
            printf '%s\n' '{"status":"ok","before":{"version":"2026.8.1"},"after":{"version":"2026.9.1"}}'
            """.write(to: node, atomically: true, encoding: .utf8)
            try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: node.path)
            try PropertyListSerialization.data(
                fromPropertyList: [
                    "ProgramArguments": self.cli.prefix + (nodeService ? ["node", "run"] :
                        ["gateway", "--port", "29873"]),
                    "EnvironmentVariables": ["OPENCLAW_PREPARATION_FIXTURE_ROOT": self.root.path],
                ],
                format: .xml,
                options: 0).write(to: self.plist)
        }

        func remove() {
            try? FileManager.default.removeItem(at: self.root)
            try? FileManager.default.removeItem(at: self.nodeRoot)
        }
    }

    @Test(arguments: ["gateway-to-remote", "node-to-local", "gateway-stays-local", "node-stays-remote"], [false, true])
    func `core updates follow current mode without restarting the foreign service`(
        _ scenario: String, fresh: Bool) async throws
    {
        let home = try makeTempDirForTests()
        defer { try? FileManager.default.removeItem(at: home) }
        let config = home.appendingPathComponent("openclaw.json")
        try Data(#"{"gateway":{"mode":"local"}}"#.utf8).write(to: config)
        try await TestIsolation.withIsolatedState(
            launchAgentHomeDirectory: home,
            env: ["OPENCLAW_CONFIG_PATH": config.path],
            defaults: [cliInstallPolicyKey: "exact", postAppUpdateReceiptKey: nil])
        {
            let local = try Fixture(home: home)
            let node = try Fixture(home: home, nodeService: true)
            defer { local.remove()
                node.remove()
            }
            let nodeOwner = scenario.hasPrefix("node-")
            let selectedMode: AppState.ConnectionMode = scenario.hasSuffix("remote") ? .remote : .local
            let owner: PostAppUpdateCoreUpdate = nodeOwner ? .node : .gateway
            let repairMode: AppState.ConnectionMode = nodeOwner ? .remote : .local
            let fixture = nodeOwner ? node : local
            let cli = try #require(GatewayLaunchAgentManager.captureServiceCLI(
                plist: fixture.plist,
                environmentFile: home.appendingPathComponent("repair.env"),
                environmentWrapper: home.appendingPathComponent("repair-wrapper.sh"),
                subcommand: nodeOwner ? "node" : "gateway"))
            let target = "2026.9.1"
            let notice = PostAppUpdateReceipt(
                fromVersion: "2026.8.1", toVersion: target, recordedAt: .distantPast)
            if !fresh {
                try Data().write(to: fixture.root.appendingPathComponent("advance"))
                try Data().write(to: fixture.root.appendingPathComponent("fail"))
                let failed = await CLIInstaller.updateManaged(
                    targetVersion: target, restartGateway: false, installedCLI: cli,
                    onDispatch: {
                        try PostAppUpdateReceiptStore.recordCoreUpdateDispatch(receipt: notice, owner: owner)
                    },
                    statusHandler: { _ in })
                guard case .failure = failed else { Issue.record("Expected interrupted core update")
                    return
                }
                try FileManager.default.removeItem(at: fixture.root.appendingPathComponent("fail"))
            }
            let pending: PostAppUpdateReceipt = if fresh {
                notice
            } else {
                try #require(PostAppUpdateReceiptStore.pending(currentVersion: target))
            }
            #expect(!PostUpdateController.shouldRepairNodeMigration(
                receipt: pending, migrationNeedsCoreRepair: false, migrationFailed: false))
            let resolution = await PostUpdateController.resolveGatewayAction(
                context: .init(
                    connectionMode: repairMode, bundledApp: true, usesSeededGateway: false,
                    hasService: true, installedCLI: cli, ownsManagedRuntime: true),
                receipt: pending)
            {
                await CLIInstaller.managedStatus(expectedVersion: target, installedCLI: cli, usesBundledRuntime: false)
            }
            #expect(resolution.action == (fresh ? .update : .repair))
            let restart = resolution.shouldRestartGateway(connectionMode: selectedMode, paused: false)
            #expect(restart == (scenario == "gateway-stays-local"))
            let repaired = await CLIInstaller.updateManaged(
                targetVersion: target, restartGateway: restart,
                repair: resolution.action == .repair, installedCLI: resolution.installedCLI,
                onDispatch: { try PostAppUpdateReceiptStore.recordCoreUpdateDispatch(receipt: pending, owner: owner) },
                statusHandler: { _ in })
            #expect(repaired == .success(fromVersion: "2026.8.1", toVersion: target))
            let completed = try #require(PostAppUpdateReceiptStore.completeCoreRepair(
                currentVersion: target, owner: owner))
            let reroute = resolution.shouldResolveCurrentMode(after: pending.coreUpdate, currentMode: selectedMode)
            #expect(reroute == (scenario != "gateway-stays-local"))
            let commands = try String(contentsOf: fixture.root.appendingPathComponent("updates"), encoding: .utf8)
                .split(separator: "\n")
            #expect(commands.last?.contains("--no-restart") == (scenario != "gateway-stays-local"))
            guard reroute else {
                #expect(PostUpdateController.shouldRepairNodeMigration(
                    receipt: pending, migrationNeedsCoreRepair: true, migrationFailed: false) == !fresh)
                return
            }
            let selectedFixture = selectedMode == .local ? local : node
            let selectedCLI = try #require(GatewayLaunchAgentManager.captureServiceCLI(
                plist: selectedFixture.plist,
                environmentFile: home.appendingPathComponent("selected.env"),
                environmentWrapper: home.appendingPathComponent("selected-wrapper.sh"),
                subcommand: selectedMode == .local ? "gateway" : "node"))
            let next = await PostUpdateController.resolveGatewayAction(
                context: .init(
                    connectionMode: selectedMode, bundledApp: true, usesSeededGateway: false,
                    hasService: true, installedCLI: selectedCLI, ownsManagedRuntime: true),
                receipt: completed)
            {
                await CLIInstaller.managedStatus(
                    expectedVersion: target, installedCLI: selectedCLI, usesBundledRuntime: false)
            }
            #expect(next.connectionMode == selectedMode)
            #expect(next.action == (selectedMode == repairMode ? .verify : .update))
            #expect(next.installedCLI?.prefix == selectedCLI.prefix)
        }
    }

    @Test(arguments: ["success", "failure", "foreign", "legacy"])
    func `remote core recovery retains its dispatched owner across runtime retries`(_ scenario: String) async throws {
        let home = try makeTempDirForTests()
        defer { try? FileManager.default.removeItem(at: home) }
        let config = home.appendingPathComponent("openclaw.json")
        try Data(#"{"gateway":{"mode":"local"}}"#.utf8).write(to: config)
        try await TestIsolation.withIsolatedState(
            launchAgentHomeDirectory: home,
            env: ["OPENCLAW_CONFIG_PATH": config.path],
            defaults: [cliInstallPolicyKey: "exact", postAppUpdateReceiptKey: nil])
        {
            let local = try Fixture(home: home)
            let node = try Fixture(home: home, nodeService: true)
            defer { local.remove()
                node.remove()
            }
            let target = "2026.9.1"
            try "\(target)\n".write(
                to: local.root.appendingPathComponent("version"), atomically: true, encoding: .utf8)
            let cli = try #require(GatewayLaunchAgentManager.captureServiceCLI(
                plist: node.plist,
                environmentFile: home.appendingPathComponent("node.env"),
                environmentWrapper: home.appendingPathComponent("node-env-wrapper.sh"),
                subcommand: "node"))
            #expect(cli.serviceAuthority?.isLocalGateway == false)
            if scenario == "legacy" {
                let published: [String: Any] = [
                    "fromVersion": "2026.8.1", "toVersion": target, "recordedAt": 0,
                    "gatewayUpdateIncomplete": true,
                ]
                try AppDefaults.standard.set(
                    JSONSerialization.data(withJSONObject: published), forKey: postAppUpdateReceiptKey)
            } else {
                PostAppUpdateReceiptStore.record(fromVersion: "2026.8.1", toVersion: target)
                if scenario != "success" {
                    try Data().write(to: node.root.appendingPathComponent("advance"))
                    try Data().write(to: node.root.appendingPathComponent("fail"))
                }
                let receipt = try #require(PostAppUpdateReceiptStore.pending(currentVersion: target))
                let outcome = await CLIInstaller.updateManaged(
                    targetVersion: target, restartGateway: false, installedCLI: cli,
                    onDispatch: {
                        try PostAppUpdateReceiptStore.recordCoreUpdateDispatch(receipt: receipt, owner: .node)
                    },
                    statusHandler: { _ in })
                if scenario == "success" {
                    #expect(outcome == .success(fromVersion: "2026.8.1", toVersion: target))
                    PostAppUpdateReceiptStore.completeCoreRepair(currentVersion: target, owner: .node)
                } else {
                    guard case .failure = outcome else { Issue.record("Expected core failure after version advance")
                        return
                    }
                }
            }
            let reloaded = try #require(PostAppUpdateReceiptStore.pendingForLaunch(
                currentVersion: target, onboardingSeen: true))
            if scenario == "foreign" {
                #expect(PostAppUpdateReceiptStore.completeCoreRepair(
                    currentVersion: target, owner: .gateway)?.coreUpdate == .node)
                let stale = PostAppUpdateReceipt(
                    fromVersion: "2026.8.1", toVersion: target, recordedAt: .distantPast)
                #expect(throws: GatewayHostingError.self) {
                    try PostAppUpdateReceiptStore.recordCoreUpdateDispatch(receipt: stale, owner: .gateway)
                }
                #expect(PostAppUpdateReceiptStore.setGatewayUpdateIncomplete(
                    true, receipt: stale).coreUpdate == .node)
                #expect(PostAppUpdateReceiptStore.recordNotificationFailure(receipt: stale).coreUpdate == .node)
                let notification = PostAppUpdateReceiptStore.setNotificationInFlight(true, receipt: stale)
                #expect(notification == nil)
                #expect(PostAppUpdateReceiptStore.pending(currentVersion: target)?.coreUpdate == .node)
                #expect(PostAppUpdateReceiptStore.pending(currentVersion: target)?.notificationAttempts == 1)
                #expect(!PostUpdateController.shouldRepairNodeMigration(
                    receipt: reloaded, migrationNeedsCoreRepair: true, migrationFailed: false))
                do {
                    _ = try await CLIInstaller.prepareBundledGateway(
                        targetVersion: target, restartGateway: false, statusHandler: { _ in })
                    Issue.record("Local repair must not replace pending node core work")
                } catch {}
                #expect(PostAppUpdateReceiptStore.pending(currentVersion: target)?.coreUpdatePending == true)
                #expect(!FileManager.default.fileExists(atPath: local.root.appendingPathComponent("updates").path))
                return
            }
            var probed = false
            let resolution = await PostUpdateController.resolveGatewayAction(
                context: .init(
                    connectionMode: .remote, bundledApp: true, usesSeededGateway: false,
                    hasService: true, installedCLI: cli, ownsManagedRuntime: true),
                receipt: reloaded)
            {
                probed = true
                if scenario == "legacy" {
                    return .ready(location: CLIInstaller.managedExecutableLocation(), version: target)
                }
                return await CLIInstaller.managedStatus(
                    expectedVersion: target, installedCLI: cli, usesBundledRuntime: false)
            }
            let expected: PostUpdateGatewayAction = scenario == "legacy" ? .ownershipFailure :
                (scenario == "success" ? .verify : .repair)
            #expect(resolution.action == expected)
            if scenario == "legacy" {
                #expect(!probed)
                #expect(resolution.installedCLI == nil)
            } else {
                #expect(resolution.installedCLI?.prefix == cli.prefix)
            }
            #expect(PostAppUpdateReceiptStore.pending(currentVersion: target) == reloaded)
        }
    }

    @Test(arguments: ["core-failure", "core-success", "equal-version", "runtime-failure"])
    func `registered migration receipt keeps unfinished core work ahead of Bun`(_ scenario: String) async throws {
        let home = try makeTempDirForTests()
        defer { try? FileManager.default.removeItem(at: home) }
        let stateDirectory = AppProfile.current.stateDirectoryURL()
        let config = home.appendingPathComponent("openclaw.json")
        try Data(#"{"gateway":{"mode":"local"}}"#.utf8).write(to: config)
        try await TestIsolation.withIsolatedState(
            launchAgentHomeDirectory: home,
            env: ["OPENCLAW_CONFIG_PATH": config.path, "OPENCLAW_STATE_DIR": stateDirectory.path],
            defaults: [
                cliInstallPolicyKey: "exact",
                postAppUpdateReceiptKey: nil,
                lastLaunchedAppVersionKey: nil,
                "openclaw.lastLaunchedRuntimeBuildID": nil,
            ]) {
                let state = AppStateStore.shared
                let previousOnboarding = state.onboardingSeen
                let previousMode = state.connectionMode
                state.onboardingSeen = true
                state.connectionMode = .local
                defer {
                    state.onboardingSeen = previousOnboarding
                    state.connectionMode = previousMode
                }
                let fixture = try Fixture(home: home)
                defer { fixture.remove() }
                let target = "2026.9.1"
                let versionUpdate = scenario.hasPrefix("core-")
                if !versionUpdate {
                    try "\(target)\n".write(
                        to: fixture.root.appendingPathComponent("version"),
                        atomically: true,
                        encoding: .utf8)
                }
                if scenario == "core-failure" {
                    try Data().write(to: fixture.root.appendingPathComponent("advance"))
                    try Data().write(to: fixture.root.appendingPathComponent("fail"))
                }
                PostAppUpdateReceiptStore.record(fromVersion: "2026.8.1", toVersion: target)
                let cli = try #require(GatewayLaunchAgentManager.installedServiceCLI())
                let candidate = try #require(try await ManagedNodeGatewayMigration.candidate(
                    onboardingSeen: true, installPolicy: "exact", retainedCLI: cli, allowNamedServiceRetry: true))
                let originalService = GatewayLaunchAgentManager.launchdConfigSnapshot()
                var runtimeActions: [String] = []
                var failHealth = scenario == "runtime-failure"
                var operations = ManagedNodeGatewayMigration.liveOperations(
                    checkCurrent: {}, resolveLegacyCLI: { cli }, allowNamedServiceRetry: true,
                    verifyHealth: {
                        runtimeActions.append("health")
                        if failHealth {
                            failHealth = false
                            throw GatewayHostingError(message: "fixture Bun health failure")
                        }
                    },
                    setServiceHosting: { _ in runtimeActions.append("service") },
                    statusHandler: { _ in })
                operations.seed = { _ in
                    runtimeActions.append("seed")
                    return BundledRuntime(root: home.appendingPathComponent("unlaunched-runtime"))
                }
                operations.install = { _, _ in runtimeActions.append("bun") }
                operations.restore = { previous in
                    #expect(previous.version == target)
                    runtimeActions.append("node")
                }
                do {
                    let result = try await ManagedNodeGatewayMigration.run(
                        candidate: candidate, targetVersion: target,
                        pendingSetupRecovery: PostAppUpdateReceiptStore.pending(currentVersion: target),
                        operations: operations)
                    if scenario == "core-success" {
                        guard case .versionUpdated = result else { Issue.record("Registered update must stop on Node")
                            return
                        }
                        #expect(runtimeActions.isEmpty)
                    } else {
                        #expect(scenario == "equal-version")
                        guard case .migrated = result
                        else { Issue.record("Equal-version migration must remain eligible")
                            return
                        }
                    }
                } catch {
                    #expect(["core-failure", "runtime-failure"].contains(scenario))
                    let receipt = try #require(PostAppUpdateReceiptStore.pending(currentVersion: target))
                    PostAppUpdateReceiptStore.recordMigrationFailure(receipt: receipt)
                }
                #expect(try String(contentsOf: fixture.root.appendingPathComponent("version"), encoding: .utf8) ==
                    "\(target)\n")
                #expect(GatewayLaunchAgentManager.launchdConfigSnapshot() == originalService)
                let updates = (try? String(
                    contentsOf: fixture.root.appendingPathComponent("updates"),
                    encoding: .utf8))?
                    .split(separator: "\n") ?? []
                #expect(updates.count == (versionUpdate ? 1 : 0))
                if scenario == "core-failure" { #expect(runtimeActions.isEmpty) }
                if scenario == "runtime-failure" { #expect(runtimeActions.suffix(2) == ["node", "health"]) }
                if scenario == "equal-version" { return }

                let reloaded = try #require(PostAppUpdateReceiptStore.pendingForLaunch(
                    currentVersion: target, onboardingSeen: true))
                #expect(!reloaded.setupRecovery)
                #expect(reloaded.coreUpdatePending == (scenario == "core-failure"))
                for deferredRepair in [false, true] {
                    let repairingMigration = PostUpdateController.shouldRepairNodeMigration(
                        receipt: reloaded, migrationNeedsCoreRepair: deferredRepair,
                        migrationFailed: !deferredRepair)
                    #expect(repairingMigration == (scenario == "core-failure"))
                    let context = try PostUpdateController.captureRuntimeContext(
                        connectionMode: .remote, bundledApp: true, usesSeededGateway: false,
                        repairingNodeMigration: repairingMigration)
                    let resolution = await PostUpdateController.resolveGatewayAction(
                        context: context, receipt: reloaded)
                    {
                        await CLIInstaller.managedStatus(
                            expectedVersion: target, installedCLI: context.installedCLI, usesBundledRuntime: false)
                    }
                    #expect(resolution.connectionMode == (repairingMigration ? .local : .remote))
                    if repairingMigration {
                        #expect(resolution.installedCLI?.prefix == cli.prefix)
                        #expect(resolution.action == .repair)
                    } else {
                        // No Mac node service exists in this fixture; completed local core work returns to it.
                        #expect(resolution.installedCLI == nil)
                        #expect(resolution.action == .none)
                    }
                }
                #expect(PostUpdateController.coreRepairAction(
                    receipt: reloaded, migrationNeedsCoreRepair: false,
                    migrationFailed: false, explicitRetry: true) == (scenario == "core-failure" ? .repair : .none))
                #expect(reloaded.hasPendingRuntimeMigration == (scenario != "core-failure"))
                if !reloaded.coreUpdatePending {
                    let context = try PostUpdateController.captureRuntimeContext(
                        connectionMode: .local, bundledApp: false, usesSeededGateway: false)
                    let resolution = await PostUpdateController.resolveGatewayAction(
                        context: context, receipt: reloaded)
                    {
                        await CLIInstaller.managedStatus(
                            expectedVersion: target, installedCLI: context.installedCLI, usesBundledRuntime: false)
                    }
                    #expect(resolution.needsManagedVerification)
                    #expect(![.repair, .update, .install].contains(resolution.action))
                    #expect(resolution.installedCLI?.prefix == cli.prefix)
                }
                runtimeActions.removeAll()
                let retryCandidate = try #require(try await ManagedNodeGatewayMigration.candidate(
                    onboardingSeen: true, installPolicy: "exact", retainedCLI: cli, allowNamedServiceRetry: true))
                let retry = try await ManagedNodeGatewayMigration.run(
                    candidate: retryCandidate, targetVersion: target,
                    pendingSetupRecovery: reloaded, operations: operations)
                if scenario == "core-failure" {
                    guard case .coreRepairRequired = retry else { Issue.record("Bun overtook unfinished core work")
                        return
                    }
                    #expect(runtimeActions.isEmpty)
                } else {
                    guard case .migrated = retry else { Issue.record("Runtime-only work must not repeat core update")
                        return
                    }
                    #expect(runtimeActions == ["service", "seed", "bun", "health"])
                }
            }
    }

    @Test(arguments: ["unchanged", "wrapper", "alias", "attach-only", "late-wrapper"], [false, true])
    func `managed updater and repair require current inferred authority before dispatch`(
        change: String,
        repair: Bool) async throws
    {
        let home = try makeTempDirForTests()
        defer { try? FileManager.default.removeItem(at: home) }
        let config = home.appendingPathComponent("openclaw.json")
        try Data(#"{"gateway":{"mode":"local"}}"#.utf8).write(to: config)
        try await TestIsolation.withIsolatedState(
            launchAgentHomeDirectory: home,
            env: ["OPENCLAW_CONFIG_PATH": config.path],
            defaults: [cliInstallPolicyKey: "exact", connectionModeKey: "local", postAppUpdateReceiptKey: nil])
        {
            let fixture = try Fixture(home: home, inferredLegacy: true)
            defer { fixture.remove() }
            try FileManager.default.removeItem(at: fixture.plist)
            var cli = try #require(try GatewayLaunchAgentManager.legacyManagedNodeCLI(homeDirectory: home))
            cli.environment["OPENCLAW_PREPARATION_FIXTURE_ROOT"] = fixture.root.path
            let marker = home.appendingPathComponent("disable-launchagent")
            GatewayLaunchAgentManager.setTestingDisableLaunchAgentMarkerURL(marker)
            defer { GatewayLaunchAgentManager.setTestingDisableLaunchAgentMarkerURL(nil) }
            let wrapper = fixture.state.appendingPathComponent("bin/openclaw")
            try FileManager.default.createDirectory(
                at: wrapper.deletingLastPathComponent(),
                withIntermediateDirectories: true)
            let writeOperatorWrapper: @MainActor @Sendable () throws -> Void = {
                try Data("#!/bin/sh\nexec /operator/openclaw \"$@\"\n".utf8).write(to: wrapper)
            }
            var dispatched = false
            let result = await CLIInstaller.updateManaged(
                targetVersion: "2026.9.1",
                restartGateway: false,
                repair: repair,
                installedCLI: cli,
                checkCurrent: {
                    await Task.yield()
                    switch change {
                    case "wrapper": try writeOperatorWrapper()
                    case "alias":
                        let replacement = fixture.state.appendingPathComponent("tools/node-replacement")
                        try FileManager.default.copyItem(at: fixture.nodeRoot, to: replacement)
                        let alias = fixture.state.appendingPathComponent("tools/node")
                        try FileManager.default.removeItem(at: alias)
                        try FileManager.default.createSymbolicLink(at: alias, withDestinationURL: replacement)
                    case "attach-only": try Data().write(to: marker)
                    default: break
                    }
                },
                onDispatch: {
                    dispatched = true
                    if change == "late-wrapper" {
                        do { try writeOperatorWrapper() } catch { Issue.record(error) }
                    }
                },
                statusHandler: { _ in })
            if change == "unchanged" {
                #expect(result == .success(fromVersion: "2026.8.1", toVersion: "2026.9.1"))
                let command = try String(contentsOf: fixture.root.appendingPathComponent("updates"), encoding: .utf8)
                #expect(command.contains(repair ? "update repair" : "update --tag 2026.9.1"))
                #expect(command.contains("--no-restart"))
            } else {
                guard case .failure = result else { Issue.record("Revoked authority must not launch the updater")
                    return
                }
                #expect(!FileManager.default.fileExists(atPath: fixture.root.appendingPathComponent("updates").path))
                #expect(try String(contentsOf: fixture.root.appendingPathComponent("version"), encoding: .utf8) ==
                    "2026.8.1\n")
            }
            #expect(dispatched == (change == "unchanged" || change == "late-wrapper"))
        }
    }

    @Test(arguments: [
        "unchanged", "attach-only", "before-entry-service", "service", "environment", "runtime-alias",
        "script-alias", "late-service", "terminal-wrapper", "remote-marker", "remote-service",
        "initial-beta", "policy", "channel-beta", "channel-dev", "channel-extended-stable", "late-policy",
    ], [false, true])
    func `captured service updater preserves current custody through final dispatch`(
        change: String,
        repair: Bool) async throws
    {
        let home = try makeTempDirForTests()
        defer { try? FileManager.default.removeItem(at: home) }
        let state = home.appendingPathComponent("state")
        let config = home.appendingPathComponent("openclaw.json")
        try Data((change == "initial-beta" ? #"{"update":{"channel":"beta"}}"# : "{}").utf8).write(to: config)
        try await TestIsolation.withIsolatedState(
            launchAgentHomeDirectory: home,
            env: ["OPENCLAW_STATE_DIR": state.path, "OPENCLAW_CONFIG_PATH": config.path],
            defaults: [cliInstallPolicyKey: "exact", connectionModeKey: "local", postAppUpdateReceiptKey: nil])
        {
            let fixture = try Fixture(home: home, stateDirectory: state)
            defer { fixture.remove() }
            let remote = change.hasPrefix("remote-")
            let label = remote ? nodeLaunchdLabel : AppProfile.current.gatewayLaunchAgentLabel
            let plist = remote
                ? home.appendingPathComponent("Library/LaunchAgents/\(label).plist") : fixture.plist
            let envDirectory = state.appendingPathComponent("service-env")
            try FileManager.default.createDirectory(at: envDirectory, withIntermediateDirectories: true)
            let environment = envDirectory.appendingPathComponent("\(label).env")
            let wrapper = envDirectory.appendingPathComponent("\(label)-env-wrapper.sh")
            try "export OPENCLAW_PREPARATION_FIXTURE_ROOT='\(fixture.root.path)'\n"
                .write(to: environment, atomically: true, encoding: .utf8)
            try Data("#!/bin/sh\n".utf8).write(to: wrapper)
            let alias = fixture.root.appendingPathComponent("runtime-alias")
            try FileManager.default.createSymbolicLink(at: alias, withDestinationURL: fixture.nodeRoot)
            let package = fixture.root.appendingPathComponent("package")
            try FileManager.default.createDirectory(
                at: package.appendingPathComponent("dist"),
                withIntermediateDirectories: true)
            try Data().write(to: package.appendingPathComponent("dist/index.js"))
            let packageAlias = fixture.root.appendingPathComponent("package-alias")
            try FileManager.default.createSymbolicLink(at: packageAlias, withDestinationURL: package)
            let runtimeName = change == "terminal-wrapper" ? "bun" : "node"
            if runtimeName == "bun" {
                try FileManager.default.copyItem(
                    at: fixture.nodeRoot.appendingPathComponent("bin/node"),
                    to: fixture.nodeRoot.appendingPathComponent("bin/bun"))
            }
            let prefix = [
                alias.appendingPathComponent("bin/\(runtimeName)").path,
                "--max-old-space-size=512",
                packageAlias.appendingPathComponent("dist/index.js").path,
            ]
            try PropertyListSerialization.data(fromPropertyList: [
                "ProgramArguments": ["/bin/sh", wrapper.path, environment.path] + prefix +
                    [remote ? "node" : "gateway"],
            ], format: .xml, options: 0).write(to: plist)
            let captured = try #require(remote
                ? NodeServiceManager.installedServiceCLI(profile: AppProfile(environment: [:]))
                : GatewayLaunchAgentManager.installedServiceCLI())
            #expect(!captured.isInferredLegacyInstall)
            let cli: GatewayLaunchAgentManager.InstalledServiceCLI
            if remote {
                cli = captured
            } else {
                let data = try GatewayLaunchAgentManager.resumeData(for: captured)
                try FileManager.default.removeItem(at: plist)
                cli = try GatewayLaunchAgentManager.resumeCLI(from: data, stateDirectory: state)
            }
            let marker = home.appendingPathComponent("disable-launchagent")
            GatewayLaunchAgentManager.setTestingDisableLaunchAgentMarkerURL(marker)
            defer { GatewayLaunchAgentManager.setTestingDisableLaunchAgentMarkerURL(nil) }
            let replaceService: @Sendable () throws -> Void = {
                try Data("operator replacement".utf8).write(to: plist)
            }
            if change == "before-entry-service" { try replaceService() }
            var dispatched = false
            let outcome = await CLIInstaller.updateManaged(
                targetVersion: "2026.9.1", restartGateway: false, repair: repair, installedCLI: cli,
                checkCurrent: {
                    await Task.yield()
                    switch change {
                    case "attach-only", "remote-marker": try Data().write(to: marker)
                    case "service", "remote-service": try replaceService()
                    case "environment": try Data("export CHANGED='yes'\n".utf8).write(to: environment)
                    case "runtime-alias":
                        let replacement = fixture.root.appendingPathComponent("replacement-runtime")
                        try FileManager.default.copyItem(at: fixture.nodeRoot, to: replacement)
                        try FileManager.default.removeItem(at: alias)
                        try FileManager.default.createSymbolicLink(at: alias, withDestinationURL: replacement)
                    case "script-alias":
                        let replacement = fixture.root.appendingPathComponent("replacement-package")
                        try FileManager.default.copyItem(at: package, to: replacement)
                        try FileManager.default.removeItem(at: packageAlias)
                        try FileManager.default.createSymbolicLink(at: packageAlias, withDestinationURL: replacement)
                    case "terminal-wrapper":
                        let terminal = state.appendingPathComponent("bin/openclaw")
                        try FileManager.default.createDirectory(
                            at: terminal.deletingLastPathComponent(),
                            withIntermediateDirectories: true)
                        try Data("#!/bin/sh\nexec /operator/openclaw \"$@\"\n".utf8).write(to: terminal)
                    default: break
                    }
                },
                onDispatch: {
                    dispatched = true
                    if change == "late-policy" { AppDefaults.standard.set("dev", forKey: cliInstallPolicyKey) }
                    if change == "late-service" {
                        do { try replaceService() } catch { Issue.record(error) }
                    }
                }, statusHandler: { _ in
                    if change == "policy" { AppDefaults.standard.set("beta", forKey: cliInstallPolicyKey) }
                    if change.hasPrefix("channel-") {
                        let channel = String(change.dropFirst("channel-".count))
                        do {
                            try JSONSerialization.data(withJSONObject: ["update": ["channel": channel]])
                                .write(to: config)
                        } catch { Issue.record(error) }
                    }
                })
            let allowed = ["unchanged", "terminal-wrapper", "remote-marker", "initial-beta"].contains(change)
            if allowed {
                #expect(outcome == .success(fromVersion: "2026.8.1", toVersion: "2026.9.1"))
                let command = try String(contentsOf: fixture.root.appendingPathComponent("updates"), encoding: .utf8)
                #expect(command.contains("--max-old-space-size=512"))
                #expect(command
                    .contains(package.appendingPathComponent("dist/index.js").resolvingSymlinksInPath().path))
                #expect(!command.contains("package-alias"))
            } else {
                guard case .failure = outcome else { Issue.record("Stale captured custody reached the updater")
                    return
                }
                #expect(!FileManager.default.fileExists(atPath: fixture.root.appendingPathComponent("updates").path))
            }
            #expect(dispatched == (allowed || ["late-service", "late-policy"].contains(change)))
        }
    }

    @Test(arguments: ["install", "uninstall", "restart", "status"], ["unchanged", "service", "attach-only"])
    func `gateway daemon mutations recheck service custody after command resolution`(
        verb: String, change: String) async throws
    {
        let home = try makeTempDirForTests()
        defer { try? FileManager.default.removeItem(at: home) }
        try await TestIsolation.withIsolatedState(launchAgentHomeDirectory: home) {
            let fixture = try Fixture(home: home)
            defer { fixture.remove() }
            let marker = home.appendingPathComponent("disable-launchagent")
            GatewayLaunchAgentManager.setTestingDisableLaunchAgentMarkerURL(marker)
            GatewayLaunchAgentManager.clearTestingDaemonCommandCalls()
            GatewayLaunchAgentManager.setTestingInterceptDaemonCommands(true, resolveCLI: { _, _ in
                await Task.yield()
                do {
                    if change == "service" { try Data("operator replacement".utf8).write(to: fixture.plist) }
                    if change == "attach-only" { try Data().write(to: marker) }
                } catch { Issue.record(error) }
                return .executable(fixture.cli.prefix)
            })
            defer {
                GatewayLaunchAgentManager.setTestingInterceptDaemonCommands(false)
                GatewayLaunchAgentManager.setTestingDisableLaunchAgentMarkerURL(nil)
                GatewayLaunchAgentManager.clearTestingDaemonCommandCalls()
            }
            let error = await GatewayLaunchAgentManager.runDaemonCommand([verb])
            let allowed = verb == "status" || change == "unchanged"
            #expect((error == nil) == allowed)
            #expect(GatewayLaunchAgentManager.testingDaemonCommandCallsSnapshot() == (allowed ? [[verb]] : []))
        }
    }

    @Test(arguments: ["install", "uninstall", "restart"], ["unchanged", "service", "environment", "wrapper"])
    func `daemon dispatch preserves the originally selected service authority`(
        verb: String, replacement: String) async throws
    {
        let home = try makeTempDirForTests()
        defer { try? FileManager.default.removeItem(at: home) }
        let state = home.appendingPathComponent("state")
        try await TestIsolation.withIsolatedState(
            launchAgentHomeDirectory: home, env: ["OPENCLAW_STATE_DIR": state.path])
        {
            let fixture = try Fixture(home: home, stateDirectory: state)
            defer { fixture.remove() }
            let artifacts = GatewayLaunchAgentManager.generatedEnvironmentArtifacts(
                directory: state.appendingPathComponent("service-env"), profile: .current)
            try FileManager.default.createDirectory(
                at: artifacts.environment.deletingLastPathComponent(),
                withIntermediateDirectories: true)
            try Data("export FIXTURE='original'\n".utf8).write(to: artifacts.environment)
            try Data("#!/bin/sh\n".utf8).write(to: artifacts.wrapper)
            let cli = try #require(GatewayLaunchAgentManager.installedServiceCLI())
            let original = try #require(cli.serviceAuthority)
            switch replacement {
            case "service": try Data("operator replacement".utf8).write(to: fixture.plist)
            case "environment": try Data("export FIXTURE='replacement'\n".utf8).write(to: artifacts.environment)
            case "wrapper": try Data("#!/bin/sh\nexit 1\n".utf8).write(to: artifacts.wrapper)
            default: break
            }
            let effect = fixture.root.appendingPathComponent("daemon-effect")
            GatewayLaunchAgentManager.clearTestingDaemonCommandCalls()
            GatewayLaunchAgentManager.setTestingInterceptDaemonCommands(true, beforeReturning: { _ in
                do { try Data().write(to: effect) } catch { Issue.record(error) }
            })
            defer {
                GatewayLaunchAgentManager.setTestingInterceptDaemonCommands(false)
                GatewayLaunchAgentManager.clearTestingDaemonCommandCalls()
            }
            let error = await GatewayLaunchAgentManager.runDaemonCommand(
                [verb], installedCLI: cli, expectedServiceAuthority: original)
            #expect((error == nil) == (replacement == "unchanged"))
            #expect(FileManager.default.fileExists(atPath: effect.path) == (replacement == "unchanged"))
        }
    }

    @Test func `saved concrete runtime identity is not recaptured through a replacement alias`() async throws {
        let home = try makeTempDirForTests()
        defer { try? FileManager.default.removeItem(at: home) }
        try await TestIsolation.withIsolatedState(launchAgentHomeDirectory: home) {
            let fixture = try Fixture(home: home)
            defer { fixture.remove() }
            let captured = try #require(GatewayLaunchAgentManager.installedServiceCLI())
            let saved = try GatewayLaunchAgentManager.resumeData(for: captured)
            try FileManager.default.removeItem(at: fixture.plist)
            let replacement = fixture.root.appendingPathComponent("replacement-runtime")
            try FileManager.default.moveItem(at: fixture.nodeRoot, to: replacement)
            try FileManager.default.createSymbolicLink(at: fixture.nodeRoot, withDestinationURL: replacement)
            #expect(throws: GatewayHostingError.self) {
                try GatewayLaunchAgentManager.resumeCLI(from: saved, stateDirectory: fixture.state)
            }
            #expect(!FileManager.default.fileExists(atPath: fixture.root.appendingPathComponent("updates").path))
        }
    }

    @Test(arguments: ["initial", "seeded-retry", "paused-retry", "partial-ready"])
    func `bundled setup updates the actual legacy service and retries through its updater`(
        scenario: String) async throws
    {
        let home = try makeTempDirForTests()
        defer { try? FileManager.default.removeItem(at: home) }
        try await TestIsolation.withIsolatedState(launchAgentHomeDirectory: home, defaults: [
            cliInstallPolicyKey: "exact", GatewayLaunchAgentManager.resumeCommandKey: nil, postAppUpdateReceiptKey: nil,
            lastLaunchedAppVersionKey: nil, "openclaw.lastLaunchedRuntimeBuildID": nil,
        ]) {
            let fixture = try Fixture(home: home)
            defer { fixture.remove() }
            let manager = GatewayProcessManager.shared
            let previousRetained = manager.retainedServiceCLI
            defer { manager.retainedServiceCLI = previousRetained }
            manager.retainedServiceCLI = nil
            if scenario == "paused-retry" {
                var retained = fixture.cli
                retained.environment["OPENCLAW_PREPARATION_FIXTURE_ROOT"] = fixture.root.path
                manager.retainedServiceCLI = retained
                try FileManager.default.removeItem(at: fixture.plist)
            }
            let current = AppProfile.current.stateDirectoryURL().appendingPathComponent("runtime/current")
            let runtimeDirectory = current.deletingLastPathComponent()
            let runtimeDirectoryExisted = FileManager.default.fileExists(atPath: runtimeDirectory.path)
            if scenario != "initial" {
                try FileManager.default.createDirectory(
                    at: current.deletingLastPathComponent(), withIntermediateDirectories: true)
                try FileManager.default.createSymbolicLink(atPath: current.path, withDestinationPath: "existing-build")
            }
            defer {
                if scenario != "initial" { try? FileManager.default.removeItem(at: current) }
                if !runtimeDirectoryExisted,
                   (try? FileManager.default.contentsOfDirectory(atPath: runtimeDirectory.path).isEmpty) == true
                {
                    try? FileManager.default.removeItem(at: runtimeDirectory)
                }
            }
            let original = GatewayLaunchAgentManager.launchdConfigSnapshot()
            let failure = fixture.root.appendingPathComponent("fail")
            if scenario == "partial-ready" { try Data().write(to: fixture.root.appendingPathComponent("advance")) }
            try Data().write(to: failure)
            do {
                _ = try await CLIInstaller.prepareBundledGateway(
                    targetVersion: "2026.9.1", restartGateway: scenario != "paused-retry", statusHandler: { _ in })
                Issue.record("Failed updater must leave setup retryable")
            } catch {
                #expect(error.localizedDescription.contains("fixture offline"))
            }
            #expect(GatewayLaunchAgentManager.launchdConfigSnapshot() == original)
            #expect(try String(contentsOf: fixture.root.appendingPathComponent("version"), encoding: .utf8) ==
                (scenario == "partial-ready" ? "2026.9.1\n" : "2026.8.1\n"))
            #expect(PostAppUpdateReceiptStore.pendingForLaunch(
                currentVersion: "2026.9.1", currentRuntimeBuildID: "next-build", onboardingSeen: false) == nil)
            #expect(PostAppUpdateReceiptStore.pendingSetupRecovery()?.gatewayUpdateIncomplete == true)
            try FileManager.default.removeItem(at: failure)
            let location = try await CLIInstaller.prepareBundledGateway(
                targetVersion: "2026.9.1", restartGateway: scenario != "paused-retry", statusHandler: { _ in })
            #expect(location == fixture.cli.prefix.last)
            #expect(GatewayLaunchAgentManager.launchdConfigSnapshot() == original)
            let updates = try String(contentsOf: fixture.root.appendingPathComponent("updates"), encoding: .utf8)
                .split(separator: "\n")
            #expect(updates.count == 2)
            let entrypoint = try #require(fixture.cli.prefix.last)
            for (index, command) in updates.enumerated() {
                #expect(command.contains(scenario == "partial-ready" && index == 1
                        ? "update repair" : "update --tag 2026.9.1"))
                #expect(command.contains(entrypoint))
                #expect(command.contains("--no-restart") == (scenario == "paused-retry"))
            }
            CLIInstaller.completeBundledSetup(
                after: .failed(reason: "not healthy"), currentVersion: "2026.9.1")
            #expect(PostAppUpdateReceiptStore.pendingForLaunch(
                currentVersion: "2026.9.1", currentRuntimeBuildID: "next-build", onboardingSeen: false) == nil)
            let pendingRuntime = try #require(PostAppUpdateReceiptStore.pendingForLaunch(
                currentVersion: "2026.9.1", onboardingSeen: true))
            #expect(pendingRuntime.setupRecovery)
            #expect(pendingRuntime.hasPendingRuntimeMigration)
            #expect(!pendingRuntime.coreUpdatePending)
            #expect(!pendingRuntime.gatewayUpdateIncomplete)
            let context = try PostUpdateController.captureRuntimeContext(
                connectionMode: .local, bundledApp: true, usesSeededGateway: false)
            let resolution = await PostUpdateController.resolveGatewayAction(
                context: context, receipt: pendingRuntime)
            {
                await CLIInstaller.managedStatus(
                    expectedVersion: "2026.9.1", installedCLI: context.installedCLI, usesBundledRuntime: false)
            }
            #expect(resolution.needsManagedVerification)
            #expect(![.repair, .update, .install].contains(resolution.action))
            #expect(resolution.installedCLI?.prefix == fixture.cli.prefix)
            CLIInstaller.completeBundledSetup(
                after: scenario == "paused-retry" ? .deferred : .ready,
                currentVersion: "2026.9.1")
            #expect(PostAppUpdateReceiptStore.pendingSetupRecovery() == nil)
            if scenario == "paused-retry" {
                let relaunched = try #require(PostAppUpdateReceiptStore.pendingForLaunch(
                    currentVersion: "2026.9.1", currentRuntimeBuildID: pendingRuntime.runtimeBuildID,
                    onboardingSeen: true))
                #expect(relaunched == pendingRuntime)
                #expect(PostUpdateController.notificationContinuation(
                    receipt: relaunched, runtimeVerification: .deferred, migrationOnlyLaunchCheck: false) ==
                    .waitForRuntime)
                CLIInstaller.completeBundledSetup(
                    after: .ready, currentVersion: "2026.9.1")
            }
            #expect(PostAppUpdateReceiptStore.pending(currentVersion: "2026.9.1") == nil)
        }
    }

    @Test(arguments: ["service", "policy", "termination", "retained-pin"])
    func `bundled setup rechecks ownership after its progress callback`(_ change: String) async throws {
        let home = try makeTempDirForTests()
        defer { try? FileManager.default.removeItem(at: home) }
        try await TestIsolation.withIsolatedState(launchAgentHomeDirectory: home, defaults: [
            cliInstallPolicyKey: "exact", GatewayLaunchAgentManager.resumeCommandKey: nil, postAppUpdateReceiptKey: nil,
        ]) {
            let fixture = try Fixture(home: home)
            defer { fixture.remove() }
            let manager = GatewayProcessManager.shared
            let previousRetained = manager.retainedServiceCLI
            let previousTerminating = manager.isTerminating
            defer {
                manager.retainedServiceCLI = previousRetained
                manager.isTerminating = previousTerminating
            }
            manager.isTerminating = false
            manager.retainedServiceCLI = nil
            if change == "retained-pin" {
                var retained = fixture.cli
                retained.environment["OPENCLAW_PREPARATION_FIXTURE_ROOT"] = fixture.root.path
                manager.retainedServiceCLI = retained
                try FileManager.default.removeItem(at: fixture.plist)
            }
            let changed = fixture.root.appendingPathComponent("callback-changed")
            await #expect(throws: GatewayHostingError.self) {
                try await CLIInstaller.prepareBundledGateway(
                    targetVersion: "2026.9.1",
                    restartGateway: false,
                    statusHandler: { _ in
                        guard !FileManager.default.fileExists(atPath: changed.path) else { return }
                        do {
                            try Data().write(to: changed)
                            switch change {
                            case "service":
                                try Data("operator replacement".utf8).write(to: fixture.plist)
                            case "termination":
                                manager.isTerminating = true
                            case "retained-pin":
                                manager.retainedServiceCLI?.hadRuntimePin = true
                            default:
                                AppDefaults.standard.set("beta", forKey: cliInstallPolicyKey)
                            }
                        } catch { Issue.record(error) }
                    })
            }
            #expect(FileManager.default.fileExists(atPath: changed.path))
            #expect(AppDefaults.standard.object(forKey: postAppUpdateReceiptKey) == nil)
            #expect(!FileManager.default.fileExists(atPath: fixture.root.appendingPathComponent("updates").path))
            #expect(try String(contentsOf: fixture.root.appendingPathComponent("version"), encoding: .utf8) ==
                "2026.8.1\n")
        }
    }

    @Test(arguments: ["beta", "pinned"])
    func `bundled setup reports excluded incompatible services without replacing them`(_ policy: String) async throws {
        let home = try makeTempDirForTests()
        defer { try? FileManager.default.removeItem(at: home) }
        try await TestIsolation.withIsolatedState(launchAgentHomeDirectory: home, defaults: [
            cliInstallPolicyKey: policy == "beta" ? "beta" : "exact",
            GatewayLaunchAgentManager.resumeCommandKey: nil, postAppUpdateReceiptKey: nil,
        ]) {
            let fixture = try Fixture(home: home)
            defer { fixture.remove() }
            let manager = GatewayProcessManager.shared
            let previousRetained = manager.retainedServiceCLI
            defer { manager.retainedServiceCLI = previousRetained }
            var retained = fixture.cli
            retained.environment["OPENCLAW_PREPARATION_FIXTURE_ROOT"] = fixture.root.path
            retained.hadRuntimePin = policy == "pinned"
            manager.retainedServiceCLI = retained
            try FileManager.default.removeItem(at: fixture.plist)
            do {
                _ = try await CLIInstaller.prepareBundledGateway(
                    targetVersion: "2026.9.1", restartGateway: false, statusHandler: { _ in })
                Issue.record("Operator-owned update intent must remain actionable")
            } catch {
                #expect(error.localizedDescription.contains("operator-managed"))
            }
            #expect(!FileManager.default.fileExists(atPath: fixture.root.appendingPathComponent("updates").path))
            #expect(manager.retainedServiceCLI?.prefix == retained.prefix)
        }
    }

    @Test(arguments: ["beta", "extended-stable"], [false, true])
    func `bundled setup preserves policies on installed and retained seeded services`(
        policy: String,
        retained: Bool) async throws
    {
        let home = try makeTempDirForTests()
        defer { try? FileManager.default.removeItem(at: home) }
        let config = home.appendingPathComponent("openclaw.json")
        try Data((policy == "extended-stable" ? "{\"update\":{\"channel\":\"extended-stable\"}}" : "{}").utf8)
            .write(to: config)
        try await TestIsolation.withIsolatedState(
            launchAgentHomeDirectory: home,
            env: ["OPENCLAW_CONFIG_PATH": config.path, "OPENCLAW_STATE_DIR": home.appendingPathComponent("state").path],
            defaults: [
                cliInstallPolicyKey: policy == "beta" ? "beta" : "exact",
                GatewayLaunchAgentManager.resumeCommandKey: nil,
                postAppUpdateReceiptKey: nil,
            ]) {
                let manager = GatewayProcessManager.shared
                let previous = manager.retainedServiceCLI
                defer { manager.retainedServiceCLI = previous }
                let runtime = BundledRuntime(root: AppProfile.current.stateDirectoryURL()
                    .appendingPathComponent("runtime/old"))
                let cli = GatewayLaunchAgentManager.InstalledServiceCLI(prefix: runtime.cliCommand, sqliteLibrary: nil)
                manager.retainedServiceCLI = retained ? cli : nil
                if !retained {
                    let plist = GatewayLaunchAgentManager.plistURL(homeDirectory: home, profile: .current)
                    try FileManager.default.createDirectory(
                        at: plist.deletingLastPathComponent(), withIntermediateDirectories: true)
                    try PropertyListSerialization.data(
                        fromPropertyList: ["ProgramArguments": cli.prefix + ["gateway"]],
                        format: .xml,
                        options: 0).write(to: plist)
                }
                do {
                    _ = try await CLIInstaller.prepareBundledGateway(statusHandler: { _ in })
                    Issue.record("Setup must preserve the service update policy")
                } catch {
                    #expect(error.localizedDescription.contains("update policy is operator-managed"))
                }
                #expect(AppDefaults.standard.object(forKey: postAppUpdateReceiptKey) == nil)
            }
    }

    @Test(arguments: [false, true])
    func `post update repairs an absent legacy service without restarting Node`(paused: Bool) async throws {
        let home = try makeTempDirForTests()
        defer { try? FileManager.default.removeItem(at: home) }
        try await TestIsolation.withIsolatedState(launchAgentHomeDirectory: home, defaults: [
            cliInstallPolicyKey: "exact", GatewayLaunchAgentManager.resumeCommandKey: nil, postAppUpdateReceiptKey: nil,
        ]) {
            let fixture = try Fixture(home: home)
            defer { fixture.remove() }
            let manager = GatewayProcessManager.shared
            let previous = manager.retainedServiceCLI
            defer { manager.retainedServiceCLI = previous }
            var cli = fixture.cli
            cli.environment["OPENCLAW_PREPARATION_FIXTURE_ROOT"] = fixture.root.path
            manager.retainedServiceCLI = cli
            try FileManager.default.removeItem(at: fixture.plist)
            let failure = fixture.root.appendingPathComponent("fail")
            try Data().write(to: failure)
            try Data().write(to: fixture.root.appendingPathComponent("advance"))
            await #expect(throws: GatewayHostingError.self) {
                try await CLIInstaller.prepareBundledGateway(
                    targetVersion: "2026.9.1", restartGateway: false, statusHandler: { _ in })
            }
            let pending = try #require(PostAppUpdateReceiptStore.pendingSetupRecovery())
            #expect(!PostUpdateController.allowsNodeMigration(paused: true, canActivate: false, receipt: pending))
            #expect(!PostUpdateController.allowsNodeMigration(paused: false, canActivate: true, receipt: pending))
            let context = try PostUpdateController.captureRuntimeContext(
                connectionMode: .local, bundledApp: true, usesSeededGateway: false)
            #expect(!context.hasService)
            #expect(context.ownsManagedRuntime)
            #expect(context.installedCLI?.prefix == cli.prefix)
            let resolution = await PostUpdateController.resolveGatewayAction(
                context: context, receipt: pending)
            {
                await CLIInstaller.managedStatus(
                    expectedVersion: "2026.9.1", installedCLI: context.installedCLI, usesBundledRuntime: false)
            }
            try #require(resolution.action == .repair)
            #expect(!resolution.serviceInstalled)
            let restartGateway = resolution.shouldRestartGateway(connectionMode: .local, paused: paused)
            #expect(!restartGateway)
            let failedRepair = await CLIInstaller.updateManaged(
                targetVersion: "2026.9.1",
                restartGateway: restartGateway,
                repair: true,
                installedCLI: resolution.installedCLI,
                statusHandler: { _ in })
            guard case .failure = failedRepair else {
                Issue.record("Failed core repair must remain retryable")
                return
            }
            #expect(PostAppUpdateReceiptStore.pendingSetupRecovery() == pending)
            #expect(!PostUpdateController.allowsNodeMigration(
                paused: false, canActivate: true, receipt: PostAppUpdateReceiptStore.pendingSetupRecovery()))
            try FileManager.default.removeItem(at: failure)
            let location = try await CLIInstaller.prepareBundledGateway(
                targetVersion: "2026.9.1",
                restartGateway: restartGateway,
                statusHandler: { _ in })
            #expect(location == cli.prefix.last)
            #expect(PostAppUpdateReceiptStore.pending(currentVersion: "2026.9.1")?.coreUpdatePending == false)
            #expect(!FileManager.default.fileExists(atPath: fixture.plist.path))
            let updates = try String(contentsOf: fixture.root.appendingPathComponent("updates"), encoding: .utf8)
                .split(separator: "\n")
            #expect(updates.count == 3)
            #expect(updates.allSatisfy { $0.contains("--no-restart") })
            #expect(updates.dropFirst().allSatisfy { $0.contains("update repair") })
            CLIInstaller.completeBundledSetup(
                after: .deferred, currentVersion: "2026.9.1")
            let pausedReceipt = try #require(PostAppUpdateReceiptStore.pending(currentVersion: "2026.9.1"))
            #expect(pausedReceipt.hasPendingRuntimeMigration)
            #expect(PostAppUpdateReceiptStore.pendingSetupRecovery() == nil)
            #expect(!PostUpdateController.allowsNodeMigration(
                paused: true, canActivate: false, receipt: pausedReceipt))
            CLIInstaller.completeBundledSetup(
                after: .ready, currentVersion: "2026.9.1")
            #expect(PostAppUpdateReceiptStore.pending(currentVersion: "2026.9.1") == nil)
            #expect(manager.retainedServiceCLI?.prefix == cli.prefix)
        }
    }

    @Test(arguments: [false, true], [false, true])
    func `bundled setup joins the seeded service update owner before returning its package`(
        retained: Bool,
        updateFails: Bool) async throws
    {
        let home = try makeTempDirForTests()
        defer { try? FileManager.default.removeItem(at: home) }
        try await TestIsolation.withIsolatedState(launchAgentHomeDirectory: home, defaults: [
            cliInstallPolicyKey: "exact", GatewayLaunchAgentManager.resumeCommandKey: nil, postAppUpdateReceiptKey: nil,
        ]) {
            let state = AppProfile.current.stateDirectoryURL()
            let runtime = BundledRuntime(root: state.appendingPathComponent("runtime/preparation-\(UUID().uuidString)"))
            let current = state.appendingPathComponent("runtime/current")
            let runtimeDirectory = current.deletingLastPathComponent()
            let runtimeDirectoryExisted = FileManager.default.fileExists(atPath: runtimeDirectory.path)
            defer {
                try? FileManager.default.removeItem(at: runtime.root)
                if !updateFails { try? FileManager.default.removeItem(at: current) }
                if !runtimeDirectoryExisted,
                   (try? FileManager.default.contentsOfDirectory(atPath: runtimeDirectory.path).isEmpty) == true
                {
                    try? FileManager.default.removeItem(at: runtimeDirectory)
                }
            }
            let manager = GatewayProcessManager.shared
            let previousTask = manager.bundledUpdateTask
            let previousRetained = manager.retainedServiceCLI
            let previousTerminating = manager.isTerminating
            defer {
                manager.bundledUpdateTask = previousTask
                manager.retainedServiceCLI = previousRetained
                manager.isTerminating = previousTerminating
            }
            manager.isTerminating = false
            let old = BundledRuntime(root: state.appendingPathComponent("runtime/previous-build"))
            var cli = GatewayLaunchAgentManager.InstalledServiceCLI(
                prefix: [updateFails ? "/operator/bin/bun" : old.bun.path, old.cliCommand[1]],
                sqliteLibrary: old.sqliteLibrary.path)
            cli.hadRuntimePin = true
            manager.retainedServiceCLI = retained ? cli : nil
            if !retained {
                let plist = GatewayLaunchAgentManager.plistURL(homeDirectory: home, profile: .current)
                try FileManager.default.createDirectory(
                    at: plist.deletingLastPathComponent(), withIntermediateDirectories: true)
                try PropertyListSerialization.data(
                    fromPropertyList: ["ProgramArguments": cli.prefix + ["gateway"]],
                    format: .xml,
                    options: 0).write(to: plist)
            }
            let ownerWarning = "Gateway service uses an operator-pinned runtime; update it yourself"
            manager.bundledUpdateTask = Task { @MainActor in
                if updateFails { throw GatewayHostingError(message: ownerWarning) }
                try self.publishRuntime(runtime, current: current)
                return .init(activation: .ready, generation: manager.gatewayStartGeneration, source: .request)
            }
            do {
                let location = try await CLIInstaller.prepareBundledGateway(statusHandler: { _ in })
                #expect(!updateFails)
                #expect(location == runtime.packageRoot.path)
            } catch {
                #expect(updateFails)
                #expect(error.localizedDescription == ownerWarning)
            }
        }
    }

    private func publishRuntime(_ runtime: BundledRuntime, current: URL) throws {
        for directory in [runtime.bun.deletingLastPathComponent(), runtime.packageRoot.appendingPathComponent("dist")] {
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        }
        try Data("#!/bin/sh\nexit 0\n".utf8).write(to: runtime.bun)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: runtime.bun.path)
        try Data().write(to: runtime.sqliteLibrary)
        try Data().write(to: runtime.packageRoot.appendingPathComponent("openclaw.mjs"))
        try JSONSerialization.data(withJSONObject: [
            "version": "2026.9.1", "commit": "fixture", "builtAt": "fixture", "buildId": runtime.root.lastPathComponent,
        ]).write(to: runtime.packageRoot.appendingPathComponent("dist/build-info.json"))
        try FileManager.default.createSymbolicLink(
            atPath: current.path,
            withDestinationPath: runtime.root.lastPathComponent)
    }
}

extension AppStateIsolationTests {
    @Test(arguments: [
        "unchanged", "nil-policy", "absent-wrapper", "late-wrapper", "late-alias",
        "remote-no-service", "external-service", "beta-policy", "extended-stable", "operator-wrapper",
    ])
    func `canonical receipt repair preserves wrapper authority through actual dispatch`(
        _ scenario: String) async throws
    {
        try #require(AppProfile.current.isActive)
        let home = try makeTempDirForTests()
        defer { try? FileManager.default.removeItem(at: home) }
        let config = home.appendingPathComponent("openclaw.json")
        let mode: AppState.ConnectionMode = ["remote-no-service", "beta-policy", "extended-stable", "operator-wrapper"]
            .contains(scenario) ? .remote : .local
        var configuration: [String: Any] = ["gateway": ["mode": mode == .remote ? "remote" : "local"]]
        if scenario == "extended-stable" { configuration["update"] = ["channel": "extended-stable"] }
        try JSONSerialization.data(withJSONObject: configuration).write(to: config)
        try await TestIsolation.withIsolatedState(
            launchAgentHomeDirectory: home,
            env: ["OPENCLAW_CONFIG_PATH": config.path],
            defaults: [
                cliInstallPolicyKey: scenario == "nil-policy" ? nil : (scenario == "beta-policy" ? "beta" : "exact"),
                connectionModeKey: mode == .remote ? "remote" : "local",
                postAppUpdateReceiptKey: nil,
                cliValidatedExecutableKey: nil,
                cliValidatedVersionKey: nil,
            ]) {
                let state = AppProfile.current.stateDirectoryURL()
                let wrapper = state.appendingPathComponent("bin/openclaw")
                let alias = state.appendingPathComponent("tools/node")
                try #require(!FileManager.default.fileExists(atPath: wrapper.path))
                try #require(!FileManager.default.fileExists(atPath: alias.path))
                let fixture = try BundledGatewayPreparationTests.Fixture(
                    home: home, inferredLegacy: true, stateDirectory: state)
                let replacement = state.appendingPathComponent("tools/node-replacement-\(UUID().uuidString)")
                defer {
                    try? FileManager.default.removeItem(at: wrapper)
                    try? FileManager.default.removeItem(at: alias)
                    try? FileManager.default.removeItem(at: replacement)
                    fixture.remove()
                }
                let entry = fixture.nodeRoot.appendingPathComponent("lib/node_modules/openclaw/dist/entry.js")
                try FileManager.default.createDirectory(
                    at: entry.deletingLastPathComponent(),
                    withIntermediateDirectories: true)
                try Data().write(to: entry)
                if scenario != "absent-wrapper" {
                    try FileManager.default.createDirectory(
                        at: wrapper.deletingLastPathComponent(), withIntermediateDirectories: true)
                    try """
                    #!/usr/bin/env bash
                    set -euo pipefail
                    exec "\(alias.path)/bin/node" "\(entry.path)" "$@"

                    """.write(to: wrapper, atomically: true, encoding: .utf8)
                    try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: wrapper.path)
                }
                if scenario == "operator-wrapper" {
                    try Data("#!/bin/sh\nexec /operator/openclaw \"$@\"\n".utf8).write(to: wrapper)
                }
                if scenario == "external-service" {
                    try PropertyListSerialization.data(
                        fromPropertyList: ["ProgramArguments": [
                            "/operator/node",
                            "/operator/openclaw/dist/entry.js",
                            "gateway",
                        ]],
                        format: .xml, options: 0).write(to: fixture.plist)
                }
                let serviceBefore = try Data(contentsOf: fixture.plist)
                try "2026.9.1\n".write(
                    to: fixture.root.appendingPathComponent("version"), atomically: true, encoding: .utf8)
                let previousFixture = ProcessInfo.processInfo.environment["OPENCLAW_PREPARATION_FIXTURE_ROOT"]
                setenv("OPENCLAW_PREPARATION_FIXTURE_ROOT", fixture.root.path, 1)
                defer {
                    if let previousFixture {
                        setenv("OPENCLAW_PREPARATION_FIXTURE_ROOT", previousFixture, 1)
                    } else {
                        unsetenv("OPENCLAW_PREPARATION_FIXTURE_ROOT")
                    }
                }
                let published: [String: Any] = [
                    "fromVersion": "2026.8.1", "toVersion": "2026.9.1", "recordedAt": 0,
                    "gatewayUpdateIncomplete": true,
                ]
                try AppDefaults.standard.set(
                    JSONSerialization.data(withJSONObject: published), forKey: postAppUpdateReceiptKey)
                let receipt = try #require(PostAppUpdateReceiptStore.pending(currentVersion: "2026.9.1"))
                #expect(receipt.coreUpdate == .legacyCanonical)
                let context = try PostUpdateController.captureRuntimeContext(
                    connectionMode: mode, bundledApp: true, usesSeededGateway: false)
                if mode == .remote { #expect(!context.hasService) }
                var probed = false
                let resolution = await PostUpdateController.resolveGatewayAction(context: context, receipt: receipt) {
                    probed = true
                    return await CLIInstaller.managedStatus(expectedVersion: "2026.9.1", usesBundledRuntime: false)
                }
                let invalid = ["beta-policy", "extended-stable", "operator-wrapper"].contains(scenario)
                if invalid {
                    #expect(resolution.action == .ownershipFailure)
                    #expect(!probed)
                    #expect(PostAppUpdateReceiptStore.pending(currentVersion: "2026.9.1") == receipt)
                    #expect(!FileManager.default
                        .fileExists(atPath: fixture.root.appendingPathComponent("updates").path))
                    return
                }
                #expect(resolution.action == .repair)
                #expect(probed)
                #expect(resolution.installedCLI == nil)
                #expect(!resolution.prepareLocalCompanion)
                let restart = resolution.shouldRestartGateway(connectionMode: mode, paused: false)
                #expect(!restart)
                guard resolution.action == .repair else { return }
                var dispatched = false
                let outcome = await CLIInstaller.updateManaged(
                    targetVersion: "2026.9.1", restartGateway: restart, repair: true,
                    installedCLI: resolution.installedCLI,
                    onDispatch: {
                        dispatched = true
                        try PostAppUpdateReceiptStore.recordCoreUpdateDispatch(
                            receipt: receipt,
                            owner: .legacyCanonical)
                        if scenario == "late-wrapper" {
                            try Data("#!/bin/sh\nexec /operator/openclaw \"$@\"\n".utf8).write(to: wrapper)
                        } else if scenario == "late-alias" {
                            try FileManager.default.copyItem(at: fixture.nodeRoot, to: replacement)
                            try FileManager.default.removeItem(at: alias)
                            try FileManager.default.createSymbolicLink(at: alias, withDestinationURL: replacement)
                        }
                    }, statusHandler: { _ in })
                #expect(dispatched)
                #expect(try Data(contentsOf: fixture.plist) == serviceBefore)
                if scenario.hasPrefix("late-") {
                    guard case .failure = outcome
                    else { Issue.record("Replaced canonical authority must block the spawn")
                        return
                    }
                    #expect(!FileManager.default
                        .fileExists(atPath: fixture.root.appendingPathComponent("updates").path))
                    #expect(PostAppUpdateReceiptStore.pending(currentVersion: "2026.9.1")?
                        .coreUpdate == .legacyCanonical)
                } else {
                    #expect(outcome == .success(fromVersion: "2026.8.1", toVersion: "2026.9.1"))
                    let command = try String(
                        contentsOf: fixture.root.appendingPathComponent("updates"),
                        encoding: .utf8)
                    #expect(command.contains("update repair"))
                    #expect(command.contains("--no-restart"))
                    let completed = try #require(PostAppUpdateReceiptStore.completeCoreRepair(
                        currentVersion: "2026.9.1", owner: .legacyCanonical))
                    #expect(completed.coreUpdate == .complete)
                    #expect(!completed.hasPendingRuntimeMigration)
                    if ["remote-no-service", "external-service"].contains(scenario) {
                        let successorContext = try PostUpdateController.captureRuntimeContext(
                            connectionMode: mode, bundledApp: true, usesSeededGateway: false)
                        let successor = await PostUpdateController.resolveGatewayAction(
                            context: successorContext, receipt: completed)
                        {
                            Issue.record("An absent or external selected service must not require a managed CLI probe")
                            return .missing(location: "fixture")
                        }
                        #expect(successor.action == .none)
                        #expect(!successor.prepareLocalCompanion)
                        #expect(!successor.needsManagedVerification)
                        #expect(try Data(contentsOf: fixture.plist) == serviceBefore)
                    }
                }
            }
    }
}
