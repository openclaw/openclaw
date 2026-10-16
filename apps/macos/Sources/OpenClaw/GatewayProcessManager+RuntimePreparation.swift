import Foundation

extension GatewayProcessManager {
    func repairAppHostedRuntimeBeforeStart(
        runtime: BundledRuntime,
        pin: GatewayLaunchAgentManager.RuntimeIntent?,
        generation: UInt64,
        environment: [String: String]) async throws
    {
        guard pin?.status != .migrationPending,
              let buildID = try runtime.manifest().buildId,
              self.repairedAppHostedRuntimeBuildID != buildID
        else { return }
        let previous = try? BundledRuntime.seeded()
        let pending = PostAppUpdateReceiptStore.pending(
            currentVersion: GatewayEnvironment.appVersionString(), currentRuntimeBuildID: buildID)
        let changedBuild = previous.map { $0.root.lastPathComponent != buildID } ?? false
        let unseenBuild = PostAppUpdateReceiptStore.hasUnseenRuntimeBuild(
            buildID, onboardingSeen: AppStateStore.shared.onboardingSeen)
        guard changedBuild || unseenBuild || pending?.coreUpdate == .gateway || pending?.gatewayUpdateIncomplete == true
        else { return }
        let port = GatewayEnvironment.gatewayPort()
        let hosting = self.gatewayHosting
        let allowUnconfigured = self.hostsLocalGatewayWithRemotePrimary
        let custody = try await ManagedNodeGatewayMigration.captureServiceCustody(requireService: false)
        guard custody.runtimePin == pin, custody.definition.plist == nil else {
            throw GatewayHostingError(message: GatewayLaunchAgentManager.runtimePinSelectionChanged)
        }
        // The new bundle must repair fetched-plugin peers before its first Gateway loads them.
        // Durable seeding remains background work after health; Doctor can run in place.
        let output = try await CLIInstaller.repairBundledGateway(
            runtime: runtime,
            environment: environment,
            expectedServiceAuthority: custody.serviceAuthority(),
            checkCurrent: {
                let current = try await ManagedNodeGatewayMigration.captureServiceCustody(requireService: false)
                guard self.isCurrentGatewayStart(generation), !Task.isCancelled, !AppStateStore.shared.isPaused
                else { throw CancellationError() }
                guard current == custody, self.installation == .managed, self.gatewayHosting == hosting,
                      GatewayEnvironment.gatewayPort() == port,
                      self.hostsLocalGatewayWithRemotePrimary == allowUnconfigured
                else {
                    throw GatewayHostingError(message: GatewayLaunchAgentManager.runtimePinSelectionChanged)
                }
            },
            statusHandler: { self.appendLog("[gateway] \($0)\n") })
        if !output.isEmpty { self.appendLog("[gateway] recovery diagnostics: \(output.suffix(4000))\n") }
        self.repairedAppHostedRuntimeBuildID = buildID
    }

    func preparePersistentRuntimeAfterHealth() {
        guard !self.isTerminating, !self.runtimePreparationAttempted, self.runtimePreparationTask == nil
        else { return }
        self.runtimePreparationAttempted = true
        self.runtimePreparationTask = Task(priority: .background) { [weak self] in
            guard let self else { return }
            defer { self.runtimePreparationTask = nil }
            do {
                let pin = try await GatewayLaunchAgentManager.runtimePinRecord(
                    stateDirectory: AppProfile.current.stateDirectoryURL(), profile: .current)
                guard pin?.status != .migrationPending else {
                    self.appendLog("[gateway] runtime preparation deferred until pin migration completes\n")
                    return
                }
                if (try? BundledRuntime.readySeed()) == nil {
                    self.appendLog("[gateway] preparing the persistent runtime in the background\n")
                    _ = try await BundledRuntime.seed()
                    try Task.checkCancellation()
                    self.appendLog("[gateway] persistent runtime is seeded and warmed\n")
                }
                try await BundledRuntime.garbageCollectAfterHealthy()
            } catch is CancellationError {
                // An incomplete warm is retried on the next launch, without changing CLI/service pins.
            } catch {
                let warning = "Background runtime preparation failed: \(error.localizedDescription). " +
                    "The current Gateway is still running; preparation will retry next launch."
                self.appendLog("[gateway] warning: \(warning)\n")
                self.logger.warning("\(warning, privacy: .public)")
            }
        }
    }
}
