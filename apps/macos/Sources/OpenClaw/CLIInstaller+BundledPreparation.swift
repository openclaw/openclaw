import Foundation

extension CLIInstaller {
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
            try await manager.prepareBundledRuntimeAfterUpdate()
            guard let runtime = try BundledRuntime.seeded() else {
                throw GatewayHostingError(message: "The prepared Gateway runtime is unavailable. Retry setup.")
            }
            return runtime.packageRoot.path
        }

        // A seed or terminal shim can belong to a newer app while launchd still runs the legacy package.
        let status = await self.managedStatus(
            expectedVersion: targetVersion, installedCLI: cli, usesBundledRuntime: false)
        let pending = PostAppUpdateReceiptStore.pending(currentVersion: targetVersion)
            ?? PostAppUpdateReceiptStore.pendingSetupRecovery()
        let repair = status.isReady && pending?.gatewayUpdateIncomplete == true
        if status.isReady, !repair { return cli.prefix.last ?? status.location }
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
        let checkCurrent: @MainActor @Sendable () async throws -> Void = {
            let hasRuntimePin = try await GatewayLaunchAgentManager.hasRuntimePin(
                stateDirectory: state, profile: .current)
            let ownsRuntime = cli.prefix.first.map {
                GatewayLaunchAgentManager.isManagedNode($0, stateDirectory: state) ||
                    GatewayLaunchAgentManager.bundledRuntimeReplacementError(
                        appManaged: true, installedRuntimePath: $0, stateDirectory: state) == nil
            } ?? false
            guard ownsRuntime, !cli.hadRuntimePin, !hasRuntimePin,
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
        let outcome = await self.updateManaged(
            targetVersion: required,
            restartGateway: restartGateway,
            repair: repair,
            installedCLI: cli,
            checkCurrent: checkCurrent,
            onDispatch: {
                PostAppUpdateReceiptStore.recordSetupRecovery(
                    fromVersion: found,
                    toVersion: required,
                    runtimeBuildID: Bundle.main.infoDictionary?["OpenClawRuntimeBuildID"] as? String)
            },
            statusHandler: statusHandler)
        if case let .failure(message, details) = outcome {
            throw GatewayHostingError(message: [message, details, "Retry setup to try again."].compactMap(\.self)
                .joined(separator: " "))
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
        currentVersion: String? = GatewayEnvironment.appVersionString(),
        mode: AppState.ConnectionMode = AppStateStore.shared.connectionMode,
        paused: Bool = AppStateStore.shared.isPaused)
    {
        switch activation {
        case .ready: break
        case .deferred:
            guard mode == .local, paused else { return }
        case .failed: return
        }
        PostAppUpdateReceiptStore.completeSetupRecovery(currentVersion: currentVersion)
    }
}
