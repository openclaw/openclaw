import Foundation

extension GatewayProcessManager {
    enum Installation {
        case managed, external, unreadable

        static let ownershipFailure =
            "Could not read the Gateway service ownership record. Check the Gateway LaunchAgent and retry."
    }

    func installation(for port: Int, whenMissing: Installation) -> Installation {
        if GatewayLaunchAgentManager.isLaunchAgentWriteDisabled() { return .external }
        guard let arguments = GatewayLaunchAgentManager.launchdProgramArguments() else { return .unreadable }
        if !arguments.isEmpty {
            return CLIInstallPrompter.launchAgentUsesManagedCLI(programArguments: arguments) ? .managed : .external
        }
        if let gatewayOwnership, gatewayOwnership.port == port { return gatewayOwnership.installation }
        if BundledRuntime.isBundledApp {
            do {
                let home = LaunchAgentPlist.homeDirectoryURL
                if try GatewayLaunchAgentManager.legacyNodeInstallIsExternal(homeDirectory: home) { return .external }
                if ![nil, "exact"].contains(CLIInstallPolicy.storedPolicy()),
                   try GatewayLaunchAgentManager.hasLegacyManagedNodeInstall(homeDirectory: home) { return .external }
            } catch { return .unreadable }
        }
        return whenMissing
    }

    struct LaunchAgentEnableRequest: Sendable {
        let port: Int
        let allowUnconfigured: Bool
        let generation: UInt64
        let runtimeForUpdate: BundledRuntime?
        var invocationIDs: [UInt64]

        func hasSameConfiguration(as other: LaunchAgentEnableRequest) -> Bool {
            self.port == other.port &&
                self.allowUnconfigured == other.allowUnconfigured &&
                self.generation == other.generation &&
                self.runtimeForUpdate?.root == other.runtimeForUpdate?.root
        }
    }

    enum LaunchAgentEnableResult: Sendable {
        case skipped
        case installedService
        case failed(String)
        case deferred(String)

        var error: String? {
            if case let .failed(message) = self {
                message
            } else { nil }
        }

        var installed: Bool {
            if case .installedService = self {
                true
            } else {
                false
            }
        }

        var inspectionFailure: String? {
            if case let .deferred(message) = self {
                message
            } else { nil }
        }
    }

    /// Older app releases removed the plist on pause without retaining a command.
    /// Only file evidence is consulted here: paused startup must not wake the CLI.
    func initializeGatewayHosting() throws {
        guard self.canInferLegacyServiceHosting,
              AppDefaults.standard.object(forKey: GatewayHosting.defaultsKey) == nil,
              let arguments = GatewayLaunchAgentManager.launchdProgramArguments() else { return }
        let managed: Bool
        if arguments.isEmpty {
            managed = try GatewayLaunchAgentManager.hasLegacyManagedNodeInstall(
                homeDirectory: LaunchAgentPlist.homeDirectoryURL)
        } else {
            let state = AppProfile.current.stateDirectoryURL(homeDirectory: LaunchAgentPlist.homeDirectoryURL)
            let artifacts = GatewayLaunchAgentManager.generatedEnvironmentArtifacts(
                directory: state.appendingPathComponent("service-env"), profile: .current)
            let command = GatewayLaunchAgentManager.installedGatewayCommand(
                programArguments: arguments,
                environmentFile: artifacts.environment,
                environmentWrapper: artifacts.wrapper)
            managed = CLIInstallPrompter.launchAgentUsesManagedCLI(
                programArguments: arguments, homeDirectory: LaunchAgentPlist.homeDirectoryURL) &&
                command?.first.map { GatewayLaunchAgentManager.isManagedNode($0, stateDirectory: state) } == true
        }
        if managed {
            AppDefaults.standard.set(GatewayHosting.service.rawValue, forKey: GatewayHosting.defaultsKey)
        }
    }

    func shouldDeferLegacyServiceWhilePaused() throws -> Bool {
        guard AppDefaults.standard.bool(forKey: pauseDefaultsKey) else { return false }
        return try self.hasUnrecordedLegacyManagedService()
    }

    private var canInferLegacyServiceHosting: Bool {
        BundledRuntime.isBundledApp && self.retainedServiceCLI == nil &&
            AppDefaults.standard.object(forKey: GatewayLaunchAgentManager.resumeCommandKey) == nil &&
            AppDefaults.standard.string(forKey: GatewayHosting.defaultsKey) != GatewayHosting.app.rawValue &&
            AppDefaults.standard.bool(forKey: onboardingSeenKey) &&
            CommandResolver.connectionSettings().mode == .local &&
            !GatewayLaunchAgentManager.isLaunchAgentWriteDisabled() &&
            [nil, "exact"].contains(CLIInstallPolicy.storedPolicy())
    }

    private func hasUnrecordedLegacyManagedService() throws -> Bool {
        guard self.canInferLegacyServiceHosting,
              GatewayLaunchAgentManager.launchdProgramArguments()?.isEmpty == true else { return false }
        return try GatewayLaunchAgentManager.hasLegacyManagedNodeInstall(
            homeDirectory: LaunchAgentPlist.homeDirectoryURL)
    }

    func serviceCLIForResume() throws -> GatewayLaunchAgentManager.InstalledServiceCLI? {
        if let retainedServiceCLI {
            return try GatewayLaunchAgentManager.resumedServiceCLI(retainedServiceCLI)
        }
        guard let stored = AppDefaults.standard.object(forKey: GatewayLaunchAgentManager.resumeCommandKey) else {
            guard !AppDefaults.standard.bool(forKey: pauseDefaultsKey),
                  try self.hasUnrecordedLegacyManagedService() else { return nil }
            return try GatewayLaunchAgentManager.legacyManagedNodeCLI(homeDirectory: LaunchAgentPlist.homeDirectoryURL)
        }
        guard let data = stored as? Data else {
            throw GatewayHostingError(message: "The retained Gateway command could not be read.")
        }
        return try GatewayLaunchAgentManager.resumeCLI(
            from: data, stateDirectory: AppProfile.current.stateDirectoryURL())
    }

    func loadRetainedServiceForResume() throws {
        guard self.retainedServiceCLI == nil else { return }
        try self.initializeGatewayHosting()
        // An installed service has its own current command; a saved pause record does not supersede it.
        guard GatewayLaunchAgentManager.launchdProgramArguments()?.isEmpty == true else { return }
        if let cli = try self.serviceCLIForResume() { self.retainedServiceCLI = cli }
    }

    func retainManagedServiceForResume() async throws -> GatewayLaunchAgentManager.ServiceAuthority {
        let custody = try GatewayLaunchAgentManager.gatewayServiceAuthority()
        // A missing plist is a known state; a present record that cannot be captured must survive Pause.
        if custody.definition.plist == nil {
            if let error = custody.currentError() { throw GatewayHostingError(message: error) }
            return custody
        }
        guard self.installation == .managed,
              let snapshot = GatewayLaunchAgentManager.launchdConfigSnapshot(),
              var cli = GatewayLaunchAgentManager.installedServiceCLI()
        else {
            throw GatewayHostingError(
                message: "The Gateway service command could not be retained. " +
                    "The service was preserved; repair its LaunchAgent before pausing.")
        }
        let state = AppProfile.current.stateDirectoryURL()
        let pin = try await GatewayLaunchAgentManager.runtimePinRecord(stateDirectory: state, profile: .current)
        guard try await GatewayLaunchAgentManager.runtimePinRecord(stateDirectory: state, profile: .current) == pin,
              GatewayLaunchAgentManager.launchdConfigSnapshot() == snapshot,
              custody.currentError() == nil
        else { throw GatewayHostingError(message: "The Gateway service changed before pausing; retry.") }
        cli.hadRuntimePin = pin != nil
        _ = try GatewayLaunchAgentManager.retainedServiceIntent(
            from: GatewayLaunchAgentManager.resumeData(for: cli), stateDirectory: state)
        self.retainedServiceCLI = cli
        return custody
    }

    struct PausedServiceUpdate {
        let cli: GatewayLaunchAgentManager.InstalledServiceCLI?
        let record: Data?
    }

    func preparePausedServiceUpdate() throws -> PausedServiceUpdate? {
        guard self.gatewayHosting == .service else { return nil }
        try self.loadRetainedServiceForResume()
        guard GatewayLaunchAgentManager.launchdProgramArguments()?.isEmpty == true else {
            throw GatewayHostingError(
                message: "The Gateway service did not finish pausing. Pause it before retrying the update.")
        }
        return PausedServiceUpdate(
            cli: self.retainedServiceCLI,
            record: AppDefaults.standard.data(forKey: GatewayLaunchAgentManager.resumeCommandKey))
    }

    func completePausedServiceUpdate(
        _ update: PausedServiceUpdate?,
        runtime: BundledRuntime,
        checkCurrent: () throws -> Void) async throws
    {
        guard let update else { return }
        let pin = try await GatewayLaunchAgentManager.runtimePinRecord(
            stateDirectory: AppProfile.current.stateDirectoryURL(), profile: .current)
        try checkCurrent()
        guard GatewayLaunchAgentManager.launchdProgramArguments()?.isEmpty == true, pin == nil,
              AppDefaults.standard.data(forKey: GatewayLaunchAgentManager.resumeCommandKey) == update.record
        else {
            throw GatewayHostingError(message: "Gateway service or runtime selection changed while updating; retry.")
        }
        guard let cli = update.cli else { return }
        self.retainedServiceCLI = try GatewayLaunchAgentManager.updatedBundledResumeCLI(
            cli, runtime: runtime, stateDirectory: AppProfile.current.stateDirectoryURL())
    }
}
