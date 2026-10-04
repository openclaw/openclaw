import Foundation

/// The core updater owns version changes; this owner switches only a same-version service runtime.
@MainActor
enum ManagedNodeGatewayMigration {
    struct Candidate: Equatable, Sendable {
        let cli: GatewayLaunchAgentManager.InstalledServiceCLI
        let snapshot: LaunchAgentPlistSnapshot?
        let version: String
        let port: Int
        let allowUnconfigured: Bool
        var allowsNamedServiceRetry = false
        var hasVerifiedCoreRepair = false

        func matchesRetainedCLI(_ retained: GatewayLaunchAgentManager.InstalledServiceCLI) -> Bool {
            guard let package = ManagedNodeGatewayMigration.packageRoot(of: retained) else { return false }
            return self.cli.prefix.first == retained.prefix.first &&
                ManagedNodeGatewayMigration.packageRoot(of: self.cli) == package &&
                GatewayLaunchAgentManager.serviceCommandPathError(for: retained) == nil &&
                self.cli.sqliteLibrary == retained.sqliteLibrary && !retained.hadRuntimePin
        }
    }

    private nonisolated static func packageRoot(of cli: GatewayLaunchAgentManager.InstalledServiceCLI) -> URL? {
        guard let entry = cli.prefix.last else { return nil }
        let url = URL(fileURLWithPath: entry).standardizedFileURL
        if url.lastPathComponent == "openclaw.mjs" { return url.deletingLastPathComponent() }
        guard url.deletingLastPathComponent().lastPathComponent == "dist",
              ["entry.js", "entry.mjs", "index.js", "index.mjs"].contains(url.lastPathComponent)
        else { return nil }
        return url.deletingLastPathComponent().deletingLastPathComponent()
    }

    enum Outcome {
        case coreRepairRequired
        case versionUpdated
        case migrated(BundledRuntime)
    }

    struct Failure: LocalizedError {
        let message: String
        var errorDescription: String? {
            self.message
        }
    }

    struct Operations {
        var checkCurrent: () throws -> Void
        var updateVersion: (Candidate, String) async throws -> Void
        var recapture: (_ previous: Candidate, _ afterVersionUpdate: Bool) async throws -> Candidate
        var seed: (Candidate) async throws -> BundledRuntime
        var setServiceHosting: (Candidate) -> Void
        var install: (Candidate, BundledRuntime) async throws -> Void
        var restore: (Candidate) async throws -> Void
        var verifyHealth: () async throws -> Void
    }

    /// launchd can reserve a draining job's label for ExitTimeOut + ten seconds before bootstrap.
    private static let serviceInstallTimeout = GatewayChildSupervisor.shutdownTimeoutSeconds + 10 +
        GatewayLaunchAgentManager.startupMigrationTolerance

    static func shutdownTimeout(candidate: Candidate, targetVersion: String?) -> TimeInterval {
        let runtimeBudget = 2 * self.serviceInstallTimeout +
            2 * GatewayLaunchAgentManager.startupMigrationTolerance + 45
        if candidate.version != targetVersion {
            return CLIInstaller.managedUpdateTimeout + (candidate.snapshot == nil ? runtimeBudget : 45)
        }
        return runtimeBudget
    }

    static func requiresCoreRepair(
        receipt: PostAppUpdateReceipt?,
        hasVerifiedCoreRepair: Bool = false) -> Bool
    {
        receipt?.coreUpdatePending == true && !hasVerifiedCoreRepair
    }

    static func run(
        candidate: Candidate,
        targetVersion: String,
        pendingSetupRecovery: PostAppUpdateReceipt? = nil,
        operations: Operations) async throws -> Outcome
    {
        try operations.checkCurrent()
        // An updated version is not proof that core finished its schema and repair work.
        // PostUpdate must resume that work with the retained Node CLI before switching runtimes.
        if self.requiresCoreRepair(
            receipt: pendingSetupRecovery,
            hasVerifiedCoreRepair: candidate.hasVerifiedCoreRepair)
        {
            return .coreRepairRequired
        }
        var current = try await operations.recapture(candidate, false)
        try operations.checkCurrent()
        guard current == candidate else {
            throw Failure(message: "The managed Node Gateway changed before migration; retry.")
        }
        if current.version != targetVersion {
            let updating = current
            try await Task { @MainActor in
                try await operations.updateVersion(updating, targetVersion)
            }.value
            try operations.checkCurrent()
            let updated = try await operations.recapture(updating, true)
            guard updated.version == targetVersion else {
                throw Failure(
                    message: "The managed Node Gateway did not reach the app's version; its runtime was not changed.")
            }
            // Installed services keep the version/runtime boundary on separate activations.
            // A paused legacy install has no running service to preserve; Resume completes both steps.
            if candidate.snapshot != nil { return .versionUpdated }
            guard updated.snapshot == nil, updated.port == candidate.port,
                  updated.allowUnconfigured == candidate.allowUnconfigured
            else { throw Failure(message: "Gateway service selection changed during the Node update; retry.") }
            current = updated
        }

        try operations.checkCurrent()
        let rollback = current
        operations.setServiceHosting(rollback)
        do {
            let runtime = try await operations.seed(rollback)
            try operations.checkCurrent()
            let beforeInstall = try await operations.recapture(rollback, false)
            guard beforeInstall == rollback else {
                throw Failure(message: "The managed Node Gateway changed during runtime preparation; retry.")
            }
            try operations.checkCurrent()
            try await Task { @MainActor in
                try await operations.install(rollback, runtime)
            }.value
            try operations.checkCurrent()
            try await operations.verifyHealth()
            try operations.checkCurrent()
            return .migrated(runtime)
        } catch {
            let migrationError = error.localizedDescription
            if migrationError.contains(GatewayLaunchAgentManager.runtimePinSelectionChanged) { throw error }
            // Pause/quit may cancel the original operation. Its drain still owns recovery until
            // the previous same-version Node service is restored and verified.
            let restoration = Task { @MainActor in
                try await operations.restore(rollback)
                try await operations.verifyHealth()
            }
            do {
                try await restoration.value
            } catch {
                throw Failure(
                    message: "Bun migration failed: \(migrationError) " +
                        "Node restoration also failed: \(error.localizedDescription)")
            }
            throw Failure(
                message: "Bun migration failed: \(migrationError) " +
                    "The same-version Node Gateway was restored. Retry to switch to Bun.")
        }
    }

    static func candidate(
        profile: AppProfile = .current,
        onboardingSeen: Bool,
        installPolicy: String?,
        gatewayUpdateChannel: String? = nil,
        retainedCLI: GatewayLaunchAgentManager.InstalledServiceCLI? = nil,
        allowNamedServiceRetry: Bool = false,
        coreRepairVerifiedCLI: GatewayLaunchAgentManager.InstalledServiceCLI? = nil) async throws -> Candidate?
    {
        guard let arguments = GatewayLaunchAgentManager.launchdProgramArguments() else {
            throw Failure(message: "The Gateway service ownership record could not be read; retry after repairing it.")
        }
        let hasService = !arguments.isEmpty
        guard !hasService || !profile.isActive || allowNamedServiceRetry, self.policyAllowsMigration(
            onboardingSeen: onboardingSeen,
            installPolicy: installPolicy,
            gatewayUpdateChannel: gatewayUpdateChannel,
            hasService: hasService,
            allowNamedServiceRetry: allowNamedServiceRetry)
        else { return nil }
        guard var captured = try await self.capture(profile: profile, retainedCLI: retainedCLI) else { return nil }
        if hasService, profile.isActive {
            guard let retainedCLI, captured.matchesRetainedCLI(retainedCLI) else { return nil }
            captured.allowsNamedServiceRetry = true
        }
        if let coreRepairVerifiedCLI {
            guard captured.cli == coreRepairVerifiedCLI,
                  captured.version == GatewayEnvironment.appVersionString()
            else { return nil }
            captured.hasVerifiedCoreRepair = true
        }
        return captured
    }

    private static func policyAllowsMigration(
        onboardingSeen: Bool,
        installPolicy: String?,
        gatewayUpdateChannel: String?,
        hasService: Bool,
        allowNamedServiceRetry: Bool) -> Bool
    {
        onboardingSeen && (installPolicy == "exact" ||
            (installPolicy == nil && (!hasService || allowNamedServiceRetry))) &&
            !["extended-stable", "beta", "dev"].contains(gatewayUpdateChannel ?? "") &&
            !GatewayLaunchAgentManager.isLaunchAgentWriteDisabled() &&
            (hasService || (AppStateStore.shared.connectionMode == .local &&
                    AppDefaults.standard.string(forKey: GatewayHosting.defaultsKey) == GatewayHosting.service.rawValue))
    }

    private static func recaptureEligibleCandidate(
        retainedCLI: GatewayLaunchAgentManager.InstalledServiceCLI?,
        allowNamedServiceRetry: Bool,
        coreRepairVerifiedCLI: GatewayLaunchAgentManager.InstalledServiceCLI? = nil) async throws -> Candidate
    {
        guard let candidate = try await self.candidate(
            onboardingSeen: AppStateStore.shared.onboardingSeen,
            installPolicy: CLIInstallPolicy.storedPolicy(),
            gatewayUpdateChannel: OpenClawConfigFile.gatewayUpdateChannel(),
            retainedCLI: retainedCLI,
            allowNamedServiceRetry: allowNamedServiceRetry,
            coreRepairVerifiedCLI: coreRepairVerifiedCLI)
        else { throw Failure(message: "The Gateway is no longer an eligible app-managed Node service.") }
        return candidate
    }

    private static func checkCandidateAtDispatch(
        _ expected: Candidate,
        custody: ServiceCustody,
        resolveLegacyCLI: @MainActor @Sendable () throws -> GatewayLaunchAgentManager.InstalledServiceCLI?,
        checkCurrent: @MainActor @Sendable () throws -> Void) async throws
    {
        try checkCurrent()
        guard !self.requiresCoreRepair(
            receipt: PostAppUpdateReceiptStore.pendingSetupRecovery() ?? PostAppUpdateReceiptStore
                .pending(currentVersion: GatewayEnvironment.appVersionString()),
            hasVerifiedCoreRepair: expected.hasVerifiedCoreRepair)
        else {
            throw Failure(message: "The managed Node Gateway update needs repair before switching runtimes.")
        }
        let current = try await self.recaptureEligibleCandidate(
            retainedCLI: resolveLegacyCLI(),
            allowNamedServiceRetry: expected.allowsNamedServiceRetry,
            coreRepairVerifiedCLI: expected.hasVerifiedCoreRepair ? expected.cli : nil)
        try await self.checkAbsentService(current)
        guard current == expected,
              try await self.captureServiceCustody(requireService: expected.snapshot != nil) == custody
        else { throw Failure(message: "The Node Gateway changed before dispatch; the newer selection was preserved.") }
        try checkCurrent()
        guard !self.requiresCoreRepair(
            receipt: PostAppUpdateReceiptStore.pendingSetupRecovery() ?? PostAppUpdateReceiptStore
                .pending(currentVersion: GatewayEnvironment.appVersionString()),
            hasVerifiedCoreRepair: expected.hasVerifiedCoreRepair),
            self.policyAllowsMigration(
                onboardingSeen: AppStateStore.shared.onboardingSeen,
                installPolicy: CLIInstallPolicy.storedPolicy(),
                gatewayUpdateChannel: OpenClawConfigFile.gatewayUpdateChannel(),
                hasService: expected.snapshot != nil,
                allowNamedServiceRetry: expected.allowsNamedServiceRetry),
            GatewayLaunchAgentManager.launchdConfigSnapshot() == expected.snapshot
        else { throw Failure(message: "The Node Gateway update policy changed before dispatch; retry.") }
    }

    private static func capture(
        profile: AppProfile,
        retainedCLI: GatewayLaunchAgentManager.InstalledServiceCLI?) async throws -> Candidate?
    {
        guard let arguments = GatewayLaunchAgentManager.launchdProgramArguments() else {
            throw Failure(message: "The Gateway service ownership record could not be read.")
        }
        if arguments.isEmpty {
            return try await self.captureAbsentService(profile: profile, retainedCLI: retainedCLI)
        }
        guard let snapshot = GatewayLaunchAgentManager.launchdConfigSnapshot() else {
            throw Failure(message: "The Gateway service changed during inspection; retry.")
        }
        let state = profile.stateDirectoryURL()
        let artifacts = GatewayLaunchAgentManager.generatedEnvironmentArtifacts(
            directory: state.appendingPathComponent("service-env"), profile: profile)
        guard CLIInstallPrompter.launchAgentUsesManagedCLI(programArguments: snapshot.programArguments),
              let cli = GatewayLaunchAgentManager.installedServiceCLI(),
              let executable = cli.prefix.first,
              GatewayLaunchAgentManager.isManagedNode(executable, stateDirectory: state)
        else { return nil }
        guard let entrypoint = cli.prefix.last,
              GatewayLaunchAgentManager.isWithinState(entrypoint, stateDirectory: state),
              snapshot.environment["OPENCLAW_STATE_DIR"].map({
                  URL(fileURLWithPath: $0).standardizedFileURL == state.standardizedFileURL
              }) ?? true,
              snapshot.environment["OPENCLAW_CONFIG_PATH"].map({
                  URL(fileURLWithPath: $0).standardizedFileURL == state.appendingPathComponent("openclaw.json")
                      .standardizedFileURL
              }) ?? true
        else { return nil }
        if snapshot.programArguments.first == "/bin/sh" || snapshot.programArguments.first == artifacts.wrapper.path {
            guard FileManager.default.isReadableFile(atPath: artifacts.environment.path),
                  FileManager.default.isReadableFile(atPath: artifacts.wrapper.path)
            else {
                throw Failure(
                    message: "The managed Node service environment could not be read; repair it before migration.")
            }
        }
        guard let port = snapshot.port ?? snapshot.environment["OPENCLAW_GATEWAY_PORT"].flatMap(Int.init),
              (1...65535).contains(port)
        else { throw Failure(message: "The managed Node service port could not be inspected.") }
        guard try await !GatewayLaunchAgentManager.hasRuntimePin(stateDirectory: state, profile: profile)
        else { return nil }
        let version = try await self.installedVersion(cli: cli, profile: profile)
        guard GatewayLaunchAgentManager.launchdConfigSnapshot() == snapshot,
              GatewayLaunchAgentManager.serviceUpdateAuthorityError(for: cli) == nil,
              try await !GatewayLaunchAgentManager.hasRuntimePin(stateDirectory: state, profile: profile)
        else {
            throw Failure(message: "The managed Node service changed during inspection; retry.")
        }
        return Candidate(
            cli: cli,
            snapshot: snapshot,
            version: version,
            port: port,
            allowUnconfigured: snapshot.programArguments.contains("--allow-unconfigured"))
    }

    private static func captureAbsentService(
        profile: AppProfile,
        retainedCLI: GatewayLaunchAgentManager.InstalledServiceCLI?) async throws -> Candidate?
    {
        guard let intent = try retainedCLI ?? GatewayLaunchAgentManager.legacyManagedNodeCLI(profile: profile) else {
            return nil
        }
        let cli = try GatewayLaunchAgentManager.resumedServiceCLI(
            intent,
            stateDirectory: profile.stateDirectoryURL(),
            profile: profile)
        guard !cli.hadRuntimePin, let executable = cli.prefix.first,
              GatewayLaunchAgentManager.isManagedNode(executable, stateDirectory: profile.stateDirectoryURL())
        else { return nil }
        let state = profile.stateDirectoryURL()
        guard try await !GatewayLaunchAgentManager.hasRuntimePin(stateDirectory: state, profile: profile) else {
            throw Failure(message: "Gateway runtime intent changed while its service was absent; it was preserved.")
        }
        let port = GatewayEnvironment.gatewayPort()
        guard await PortGuardian.shared.describe(port: port) == nil else { return nil }
        guard try await GatewayLaunchAgentManager.serviceIsConfirmedAbsent(installedCLI: cli) else {
            throw Failure(message: "The Gateway service is still loaded; its existing owner was preserved.")
        }
        let custody = try await self.captureServiceCustody(profile: profile, requireService: false)
        guard custody.definition.plist == nil, custody.runtimePin == nil else {
            throw Failure(message: "Gateway service ownership changed during Resume; it was preserved.")
        }
        let version = try await self.installedVersion(cli: cli, profile: profile)
        guard try await self.captureServiceCustody(profile: profile, requireService: false) == custody,
              GatewayLaunchAgentManager.serviceUpdateAuthorityError(for: cli) == nil
        else { throw Failure(message: "The retained Node installation changed during inspection; retry.") }
        return Candidate(cli: cli, snapshot: nil, version: version, port: port, allowUnconfigured: false)
    }

    private static func checkAbsentService(_ candidate: Candidate) async throws {
        guard candidate.snapshot == nil else { return }
        guard await PortGuardian.shared.describe(port: candidate.port) == nil,
              try await GatewayLaunchAgentManager.serviceIsConfirmedAbsent(installedCLI: candidate.cli)
        else {
            throw Failure(
                message: "A Gateway is already running or its service is loaded; the existing owner was preserved.")
        }
    }

    static func refreshedLegacyCLI(
        after previous: GatewayLaunchAgentManager.InstalledServiceCLI,
        currentRetained: GatewayLaunchAgentManager.InstalledServiceCLI?) throws -> GatewayLaunchAgentManager
        .InstalledServiceCLI
    {
        guard currentRetained == nil || (currentRetained?.prefix == previous.prefix &&
            currentRetained?.sourcePrefix == previous.sourcePrefix &&
            currentRetained?.hadRuntimePin == previous.hadRuntimePin &&
            currentRetained?.isInferredLegacyInstall == previous.isInferredLegacyInstall)
        else {
            throw Failure(message: "The retained Gateway selection changed during its update; retry.")
        }
        guard GatewayLaunchAgentManager.launchdProgramArguments()?.isEmpty == true,
              let refreshed = try GatewayLaunchAgentManager.legacyManagedNodeCLI()
        else {
            throw Failure(message: "The updated Node installation could not be rediscovered; repair it first.")
        }
        return refreshed
    }

    private static func installedVersion(
        cli: GatewayLaunchAgentManager.InstalledServiceCLI,
        profile: AppProfile) async throws -> String
    {
        let environment = GatewayLaunchAgentManager.daemonEnvironment(
            runtime: nil,
            installedCLI: cli,
            environment: ProcessInfo.processInfo.environment,
            profile: profile,
            searchPaths: CommandResolver.preferredPaths())
        let response = await ShellExecutor.runDetailed(
            command: cli.prefix + ["--version"], cwd: nil, env: environment, timeout: 15)
        guard response.success,
              let version = GatewayEnvironment.normalizeGatewayVersionOutput(response.stdout),
              Semver.parse(version) != nil
        else { throw Failure(message: "The installed Node Gateway version could not be verified.") }
        return version
    }

    private static func checkRestorationWriteAuthority() throws {
        guard !GatewayLaunchAgentManager.isLaunchAgentWriteDisabled() else {
            throw Failure(message: "Gateway service writes were disabled during migration. " +
                "Attach-only mode was preserved; Node was not reinstalled.")
        }
    }

    static func liveOperations(
        checkCurrent: @escaping @MainActor @Sendable () throws -> Void,
        resolveLegacyCLI: @escaping @MainActor @Sendable () throws -> GatewayLaunchAgentManager.InstalledServiceCLI? = {
            nil
        },
        restorationInstaller: @escaping @MainActor () throws -> BundledRuntime = {
            try BundledRuntime.resolve(bundle: .main)
        },
        verifyHealth: @escaping () async throws -> Void,
        setServiceHosting: @escaping (Candidate) -> Void,
        statusHandler: @escaping @MainActor @Sendable (String) async -> Void) -> Operations
    {
        let custody = RestorationCustody()
        return Operations(
            checkCurrent: checkCurrent,
            updateVersion: { candidate, version in
                let original = try await self.captureServiceCustody(requireService: candidate.snapshot != nil)
                try checkCurrent()
                let outcome = await CLIInstaller.updateManaged(
                    targetVersion: version,
                    restartGateway: candidate.snapshot != nil,
                    installedCLI: candidate.cli,
                    checkCurrent: {
                        try await self.checkCandidateAtDispatch(
                            candidate,
                            custody: original,
                            resolveLegacyCLI: resolveLegacyCLI,
                            checkCurrent: checkCurrent)
                    },
                    onDispatch: {
                        if candidate.snapshot == nil {
                            try PostAppUpdateReceiptStore.recordSetupRecovery(
                                fromVersion: candidate.version, toVersion: version)
                        } else {
                            let receipt = PostAppUpdateReceiptStore.pending(currentVersion: version) ??
                                PostAppUpdateReceipt(
                                    fromVersion: candidate.version, toVersion: version, recordedAt: Date())
                            try PostAppUpdateReceiptStore.recordCoreUpdateDispatch(receipt: receipt, owner: .gateway)
                        }
                    },
                    statusHandler: statusHandler)
                if case let .failure(message, details) = outcome {
                    throw Failure(message: [message, details].compactMap(\.self).joined(separator: " "))
                }
                if case let .success(_, installedVersion) = outcome {
                    guard installedVersion == version else {
                        throw Failure(
                            message: "The Node update did not verify the app's exact version; retry recovery.")
                    }
                    guard let completed = PostAppUpdateReceiptStore.completeCoreRepair(
                        currentVersion: version, owner: .gateway), !completed.coreUpdatePending
                    else {
                        throw Failure(message: "Another managed runtime update still needs repair.")
                    }
                }
            },
            recapture: { previous, afterVersionUpdate in
                var retained = try resolveLegacyCLI()
                if afterVersionUpdate, previous.snapshot == nil {
                    // Core may republish the managed wrapper/package layout during its update.
                    retained = try self.refreshedLegacyCLI(after: previous.cli, currentRetained: retained)
                }
                return try await self.recaptureEligibleCandidate(
                    retainedCLI: retained,
                    allowNamedServiceRetry: previous.allowsNamedServiceRetry,
                    coreRepairVerifiedCLI: previous.hasVerifiedCoreRepair ? previous.cli : nil)
            },
            seed: { candidate in
                let original = try await self.captureServiceCustody(requireService: candidate.snapshot != nil)
                guard original.runtimePin == nil,
                      (original.definition.plist != nil) == (candidate.snapshot != nil),
                      GatewayLaunchAgentManager.launchdConfigSnapshot() == candidate.snapshot
                else {
                    throw Failure(message: "Gateway ownership changed before seeding; it was preserved.")
                }
                custody.original = original
                try await self.checkCandidateAtDispatch(
                    candidate, custody: original, resolveLegacyCLI: resolveLegacyCLI, checkCurrent: checkCurrent)
                return try await BundledRuntime.seed()
            },
            setServiceHosting: setServiceHosting,
            install: { candidate, runtime in
                let inspected = try await self.captureServiceCustody(requireService: candidate.snapshot != nil)
                let original = custody.original ?? inspected
                guard inspected == original, original.runtimePin == nil,
                      GatewayLaunchAgentManager.launchdConfigSnapshot() == candidate.snapshot
                else { throw Failure(message: "The Node Gateway changed before installation; it was preserved.") }
                custody.original = original
                try checkCurrent()
                let expectedAuthority = try original.serviceAuthority()
                let installError = await GatewayLaunchAgentManager.runDaemonCommand(
                    GatewayLaunchAgentManager.installArguments(
                        port: candidate.port,
                        allowUnconfigured: candidate.allowUnconfigured,
                        runtime: runtime,
                        launchAgentExists: candidate.snapshot != nil,
                        replaceRuntime: true),
                    timeout: self.serviceInstallTimeout,
                    runtime: runtime,
                    installedCLI: candidate.snapshot == nil ? .init(
                        prefix: runtime.cliCommand,
                        sqliteLibrary: runtime.sqliteLibrary.path,
                        environment: candidate.cli.environment) : nil,
                    legacyAuthority: candidate.cli,
                    expectedServiceAuthority: expectedAuthority,
                    checkCurrent: {
                        try await self.checkCandidateAtDispatch(
                            candidate,
                            custody: original,
                            resolveLegacyCLI: resolveLegacyCLI,
                            checkCurrent: checkCurrent)
                    })
                try await custody.finishInstall(error: installError) {
                    try await self.installedServiceCustody(
                        runtime: runtime,
                        port: candidate.port,
                        allowUnconfigured: candidate.allowUnconfigured,
                        allowMissingRuntimePin: installError != nil)
                }
            },
            restore: { candidate in
                let current = try await self.captureServiceCustody(requireService: false)
                if try custody.action(current: current) == .verifyOriginalNode { return }
                try self.checkRestorationWriteAuthority()
                guard try await self.installedVersion(cli: candidate.cli, profile: .current) == candidate.version else {
                    throw Failure(message: "The retained Node Gateway version changed during migration. " +
                        "The current service was preserved; inspect it before retrying.")
                }
                let verified = try await self.captureServiceCustody(requireService: false)
                if try custody.action(current: verified) == .verifyOriginalNode { return }
                if verified.definition.plist == nil { try await self.checkAbsentService(candidate) }
                // --runtime node clears the newly selected Bun pin without pinning the restored Node.
                var arguments = ["install", "--force", "--port", String(candidate.port), "--runtime", "node"]
                if candidate.allowUnconfigured { arguments.append("--allow-unconfigured") }
                let expectedAuthority = try verified.serviceAuthority()
                if let error = try await GatewayLaunchAgentManager
                    .runDaemonCommand(
                        arguments,
                        timeout: self.serviceInstallTimeout,
                        runtime: restorationInstaller(),
                        restoring: candidate.cli,
                        expectedServiceAuthority: expectedAuthority,
                        checkCurrent: {
                            if verified.definition.plist == nil { try await self.checkAbsentService(candidate) }
                            guard try await self.installedVersion(cli: candidate.cli, profile: .current) == candidate
                                .version,
                                try await self.captureServiceCustody(requireService: false) == verified
                            else {
                                throw Failure(message: "The Node recovery target changed before dispatch; " +
                                    "the newer selection was preserved.")
                            }
                            try self.checkRestorationWriteAuthority()
                        })
                {
                    throw Failure(message: error)
                }
            },
            verifyHealth: verifyHealth)
    }
}
