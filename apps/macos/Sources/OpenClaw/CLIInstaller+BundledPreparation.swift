import Foundation

extension CLIInstaller {
    private struct BundledDoctorResult: Decodable {
        enum Status: String, Decodable {
            case ok, error, advisory
        }

        struct Advisory: Decodable {
            let kind: String
            let reason: String
            let message: String
            let details: [String]
        }

        struct MaintenanceRefusal: Decodable {
            let kind: String
            let reason: String
        }

        struct ConfigWriteRefusal: Decodable {
            let reason: String
            let message: String
            let keys: [String]
        }

        struct FailureFact: Decodable {
            let code: String
            let message: String
        }

        let status: Status
        let failureFacts: [FailureFact]?
        let warnings: [String]?
        let advisory: Advisory?
        let maintenanceRefusal: MaintenanceRefusal?
        let configWriteRefusal: ConfigWriteRefusal?
    }

    static func repairBundledGateway(
        runtime: BundledRuntime,
        environment: [String: String],
        expectedServiceAuthority: GatewayLaunchAgentManager.ServiceAuthority,
        checkCurrent: @escaping @MainActor @Sendable () async throws -> Void,
        statusHandler: @escaping @MainActor @Sendable (String) async -> Void) async throws -> String
    {
        await statusHandler(String(localized: "Repairing the OpenClaw Gateway update…"))
        try await checkCurrent()
        // The app has drained its producer. Doctor owns core and plugin repairs,
        // while native custody continues to own service publication and activation.
        let response = await ShellExecutor.runDetailed(
            command: runtime.cliCommand + ["doctor", "--fix", "--non-interactive"],
            cwd: runtime.packageRoot.path,
            env: environment.merging([
                "OPENCLAW_SERVICE_REPAIR_POLICY": "external",
                "OPENCLAW_UPDATE_IN_PROGRESS": "1",
                "OPENCLAW_UPDATE_POST_CORE_CONVERGENCE": "1",
                "OPENCLAW_UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE": "1",
                "OPENCLAW_UPDATE_PARENT_SUPPORTS_GATEWAY_RESTART": "1",
                "OPENCLAW_UPDATE_PARENT_ALLOWS_GATEWAY_SERVICE_REPAIR": "0",
                "OPENCLAW_UPDATE_PARENT_ALLOWS_GATEWAY_ACTIVATION": "0",
                "OPENCLAW_UPDATE_POST_INSTALL_DOCTOR_RESULT_PATH": "-",
            ]) { _, policy in policy },
            timeout: self.managedUpdateTimeout,
            beforeSpawn: { expectedServiceAuthority.currentError() })
        try await checkCurrent()
        return try self.bundledDoctorDiagnostics(response)
    }

    struct DoctorProcessesUnsettled: LocalizedError {
        let message: String
        var errorDescription: String? {
            self.message
        }
    }

    static func bundledDoctorDiagnostics(_ response: ShellExecutor.ShellResult) throws -> String {
        let details = [response.preflightError, response.stderr, response.stdout, response.errorMessage]
            .compactMap { $0?.nonEmpty }.first ?? "Doctor did not complete. Retry recovery."
        let failure = String(localized: "Gateway recovery failed.") + " " + details.suffix(4000)
        if let preflight = response.preflightError {
            throw GatewayHostingError(message: preflight)
        }
        guard !response.timedOut, response.exitCode != nil,
              let finalLine = response.stdout.split(separator: "\n").last(where: {
                  $0.hasPrefix("OPENCLAW_UPDATE_POST_INSTALL_DOCTOR_RESULT_PATH=")
              }),
              let result = try? JSONDecoder().decode(
                  BundledDoctorResult.self,
                  from: Data(finalLine.dropFirst("OPENCLAW_UPDATE_POST_INSTALL_DOCTOR_RESULT_PATH=".count).utf8))
        else {
            throw DoctorProcessesUnsettled(message: failure +
                " Keep the Gateway stopped; Doctor cleanup is unverified.")
        }
        if let unsettled = result.failureFacts?.first(where: { $0.code == "doctor-processes-unsettled" }) {
            throw DoctorProcessesUnsettled(message: unsettled.message)
        }
        guard (result.status == .ok && response.exitCode == 0) ||
            (result.status == .advisory && response.exitCode == 86 &&
                result.advisory?.kind == "package-post-install-doctor" &&
                result.advisory?.reason == "deferred-configured-plugin-repair"),
            result.maintenanceRefusal == nil, result.configWriteRefusal == nil,
            (result.failureFacts ?? []).isEmpty
        else { throw GatewayHostingError(message: failure) }
        return ((result.warnings ?? []) + [result.advisory?.message].compactMap(\.self) +
            (result.advisory?.details ?? []))
            .joined(separator: "\n")
    }

    static func prepareBundledGateway(
        targetVersion: String? = GatewayEnvironment.appVersionString(),
        restartGateway: Bool = !AppStateStore.shared.isPaused,
        statusHandler: @escaping @MainActor @Sendable (String) async -> Void) async throws -> String
    {
        let manager = GatewayProcessManager.shared
        guard manager.installation == .managed,
              let arguments = GatewayLaunchAgentManager.launchdProgramArguments()
        else { throw GatewayHostingError(message: GatewayProcessManager.Installation.ownershipFailure) }
        let snapshot = GatewayLaunchAgentManager.launchdConfigSnapshot()
        let retained = arguments.isEmpty ? try manager.serviceCLIForResume() : nil
        let cli = arguments.isEmpty ? retained : GatewayLaunchAgentManager.installedServiceCLI()
        guard arguments.isEmpty || cli != nil else {
            throw GatewayHostingError(
                message: "The existing Gateway command could not be verified. Repair its service, then retry setup.")
        }
        let state = AppProfile.current.stateDirectoryURL()
        guard let cli else {
            await statusHandler("Preparing OpenClaw…")
            if try await GatewayLaunchAgentManager.runtimePinRecord(
                stateDirectory: state, profile: .current)?.status == .migrationPending
            { return try await manager.currentBundledRuntime().packageRoot.path }
            return try await BundledRuntime.seed().packageRoot.path
        }
        if GatewayLaunchAgentManager.bundledRuntimeReplacementError(
            appManaged: true, installedRuntimePath: cli.prefix.last, stateDirectory: state) == nil
        {
            await statusHandler("Preparing OpenClaw…")
            guard Self.managedSetupPolicyAllowsUpdate(cli: cli) else {
                throw GatewayHostingError(
                    message: "The Gateway update policy is operator-managed. " +
                        "Update it with its existing CLI, then retry setup.")
            }
            guard manager.installation == .managed,
                  GatewayLaunchAgentManager.launchdConfigSnapshot() == snapshot,
                  GatewayLaunchAgentManager.launchdProgramArguments() == arguments
            else { throw GatewayHostingError(message: "The Gateway service changed during setup; retry.") }
            let activation = try await manager.prepareBundledRuntimeAfterUpdate(source: .request)
            if case let .failed(reason) = activation {
                throw GatewayHostingError(message: reason ?? "The updated Gateway did not become ready.")
            }
            guard let runtime = try BundledRuntime.seeded() else {
                throw GatewayHostingError(message: "The prepared Gateway runtime is unavailable. Retry setup.")
            }
            return runtime.packageRoot.path
        }

        // A seed or terminal shim can belong to a newer app while launchd still runs the legacy package.
        let status = await self.managedStatus(
            expectedVersion: targetVersion, installedCLI: cli, usesBundledRuntime: false)
        let pending = PostAppUpdateReceiptStore.pending(currentVersion: targetVersion)
        let found: String
        let required: String
        switch status {
        case let .ready(_, version):
            found = version
            required = targetVersion ?? version
        case let .incompatible(_, installed, expected):
            found = installed
            required = expected
        case .missing, .unusable:
            throw GatewayHostingError(
                message: "The existing Gateway could not be verified. " +
                    "Repair it with its installed CLI, then retry setup.")
        }
        let versionSatisfied = status.isReady ||
            Self.satisfiesUpdateTarget(installedVersion: found, targetVersion: required)
        let repair = versionSatisfied && (pending?.coreUpdate == .gateway || pending?.coreUpdate == .legacyCanonical)
        if versionSatisfied, !repair { return cli.prefix.last ?? status.location }
        let checkCurrent: @MainActor @Sendable () async throws -> Void = {
            let pin = try await GatewayLaunchAgentManager.runtimePinRecord(
                stateDirectory: state, profile: .current)
            let ownsRuntime = cli.prefix.first.map {
                GatewayLaunchAgentManager.isManagedNode($0, stateDirectory: state) ||
                    GatewayLaunchAgentManager.bundledRuntimeReplacementError(
                        appManaged: true, installedRuntimePath: $0, stateDirectory: state) == nil
            } ?? false
            guard ownsRuntime, pin?.status == .migrationPending || (!cli.hadRuntimePin && pin == nil),
                  Self.managedSetupPolicyAllowsUpdate(cli: cli),
                  repair || CLIInstallPrompter.shouldAutomaticallyRepair(
                      status: status,
                      launchAgentUsesManagedCLI: CLIInstallPrompter.launchAgentUsesManagedCLI(
                          programArguments: cli.prefix + ["gateway"]),
                      gatewayUpdateChannel: OpenClawConfigFile.gatewayUpdateChannel(),
                      installPolicy: CLIInstallPolicy.storedPolicy(),
                      launchAgentWriteDisabled: GatewayLaunchAgentManager.isLaunchAgentWriteDisabled())
            else {
                throw GatewayHostingError(
                    message: "Gateway \(found) does not match app \(required). " +
                        "Its runtime or update policy is operator-managed. " +
                        "Update it with its existing CLI, then retry setup.")
            }
            guard !Task.isCancelled, !manager.isTerminating, manager.installation == .managed,
                  GatewayLaunchAgentManager.launchdConfigSnapshot() == snapshot,
                  GatewayLaunchAgentManager.launchdProgramArguments() == arguments,
                  try !arguments.isEmpty || (manager.serviceCLIForResume() == retained)
            else { throw GatewayHostingError(message: "The Gateway service changed during setup; retry.") }
        }
        try await checkCurrent()
        var dispatchedReceipt: PostAppUpdateReceipt?
        let outcome = await self.updateManaged(
            targetVersion: required,
            restartGateway: restartGateway,
            repair: repair,
            installedCLI: cli,
            checkCurrent: checkCurrent,
            onDispatch: {
                dispatchedReceipt = PostAppUpdateReceiptStore.recordSetupRecovery(
                    fromVersion: found,
                    toVersion: required,
                    runtimeBuildID: Bundle.main.infoDictionary?["OpenClawRuntimeBuildID"] as? String)
            },
            statusHandler: statusHandler)
        if case let .failure(message, details) = outcome {
            throw GatewayHostingError(message: [message, details, "Retry setup to try again."].compactMap(\.self)
                .joined(separator: " "))
        }
        guard case let .success(_, installedVersion) = outcome,
              Self.satisfiesUpdateTarget(installedVersion: installedVersion, targetVersion: required)
        else {
            throw GatewayHostingError(
                message: "The Node update did not verify a compatible Gateway version; retry setup.")
        }
        if let dispatchedReceipt {
            PostAppUpdateReceiptStore.completeCoreRepair(receipt: dispatchedReceipt, owner: .gateway)
        }
        return cli.prefix.last ?? status.location
    }

    private static func managedSetupPolicyAllowsUpdate(cli: GatewayLaunchAgentManager.InstalledServiceCLI) -> Bool {
        CLIInstallPrompter.managedRepairGatesOpen(
            launchAgentUsesManagedCLI: CLIInstallPrompter.launchAgentUsesManagedCLI(
                programArguments: cli.prefix + ["gateway"]),
            gatewayUpdateChannel: OpenClawConfigFile.gatewayUpdateChannel(),
            installPolicy: CLIInstallPolicy.storedPolicy(),
            launchAgentWriteDisabled: GatewayLaunchAgentManager.isLaunchAgentWriteDisabled())
    }

    static func completeBundledSetup(
        after activation: LocalGatewayActivation,
        currentVersion: String? = GatewayEnvironment.appVersionString())
    {
        guard case .ready = activation else { return }
        PostAppUpdateReceiptStore.completeSetupRecovery(currentVersion: currentVersion)
    }
}
