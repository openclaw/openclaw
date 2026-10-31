import Foundation

/// An in-place app update leaves the previous build's app-managed Gateway service running.
/// That Gateway owns shared state, so this build's CLI can neither migrate client credentials
/// nor install its service while it runs, and cannot install the service before credentials are
/// migrated. Startup therefore stops the stale service, prepares credentials, then installs this
/// build's runtime. `PostUpdateController` still verifies and retries the result.
@MainActor
struct StaleGatewayServiceReplacement {
    let stop: () async -> String?
    let restore: () async -> Void
    let install: () async -> String?

    /// Returns the install failure, if any. Credentials are ready then, so startup continues.
    func run(prepareCredentials: () async throws -> Void) async throws -> String? {
        if let error = await self.stop() { throw GatewayHostingError(message: error) }
        do {
            try await prepareCredentials()
        } catch {
            // Only unmigrated state can return to the previous build; after migration its CLI refuses.
            await self.restore()
            throw error
        }
        return await self.install()
    }

    /// Replacing the service moves the Gateway to this build's version, so it follows the same
    /// update policy as setup and post-update repair: extended-stable and channel install
    /// policies keep the operator's Gateway.
    nonisolated static func admits(
        connectionMode: AppState.ConnectionMode,
        isPaused: Bool,
        launchAgentUsesManagedCLI: Bool,
        gatewayUpdateChannel: String?,
        installPolicy: String?,
        launchAgentWriteDisabled: Bool) -> Bool
    {
        connectionMode == .local && !isPaused && CLIInstallPrompter.managedRepairGatesOpen(
            launchAgentUsesManagedCLI: launchAgentUsesManagedCLI,
            gatewayUpdateChannel: gatewayUpdateChannel,
            installPolicy: installPolicy,
            launchAgentWriteDisabled: launchAgentWriteDisabled)
    }

    static func detect(bundle: Bundle = .main, profile: AppProfile = .current) async -> Self? {
        let app = AppStateStore.shared
        let runtimes = profile.stateDirectoryURL().appendingPathComponent("runtime", isDirectory: true)
        guard let buildID = bundle.infoDictionary?["OpenClawRuntimeBuildID"] as? String,
              let previous = GatewayLaunchAgentManager.installedServiceCLI()
        else { return nil }
        let appManaged = CLIInstallPrompter.launchAgentUsesManagedCLI(programArguments: previous.prefix + ["gateway"])
        guard Self.admits(
                  connectionMode: app.connectionMode,
                  isPaused: app.isPaused,
                  launchAgentUsesManagedCLI: appManaged,
                  gatewayUpdateChannel: OpenClawConfigFile.gatewayUpdateChannel(),
                  installPolicy: CLIInstallPolicy.storedPolicy(),
                  launchAgentWriteDisabled: GatewayLaunchAgentManager.isLaunchAgentWriteDisabled()),
              GatewayLaunchAgentManager.bundledRuntimeReplacementError(
                  appManaged: appManaged,
                  installedRuntimePath: previous.prefix.first,
                  stateDirectory: profile.stateDirectoryURL()) == nil,
              // Ordinary launches stop here; only a stale service seeds this build early.
              !previous.matchesBundledRuntime(BundledRuntime(root: runtimes.appendingPathComponent(buildID))),
              let runtime = try? await BundledRuntime.seed(bundle: bundle, profile: profile)
        else { return nil }
        return Self.replacing(previous, with: runtime)
    }

    /// Every lifecycle call keeps the service custody captured at detection, so a service the
    /// operator reassigns while this build seeds or migrates is refused before dispatch.
    static func replacing(
        _ previous: GatewayLaunchAgentManager.InstalledServiceCLI, with runtime: BundledRuntime) -> Self?
    {
        guard let authority = previous.serviceAuthority else { return nil }
        let checkCurrent: @MainActor @Sendable () async throws -> Void = {
            if let error = GatewayLaunchAgentManager.serviceUpdateAuthorityError(for: previous) {
                throw GatewayHostingError(message: error)
            }
        }
        return Self(
            stop: {
                // The app owns this service; --force only answers the CLI's non-interactive guard.
                await GatewayLaunchAgentManager.runDaemonCommand(
                    ["stop", "--force"],
                    runtime: runtime,
                    expectedServiceAuthority: authority,
                    checkCurrent: checkCurrent)
            },
            restore: {
                _ = await GatewayLaunchAgentManager.runDaemonCommand(
                    ["start"], installedCLI: previous, expectedServiceAuthority: authority, checkCurrent: checkCurrent)
            },
            install: {
                await GatewayLaunchAgentManager.reinstallBundledRuntime(
                    runtime: runtime,
                    port: GatewayEnvironment.gatewayPort(),
                    environment: try? GatewayProcessManager.shared.appHostedEnvironment(
                        runtime: runtime, capturedServiceEnvironment: previous.environment),
                    expectedServiceAuthority: authority,
                    checkCurrent: checkCurrent)
            })
    }
}
