import Foundation

extension GatewayProcessManager {
    struct BundledRuntimeUpdateResult {
        let activation: CLIInstaller.LocalGatewayActivation
        let generation: UInt64
        let source: ActivationSource
    }

    func clearCompletedServiceResumeCommand(pid: Int32?, generation: UInt64) async {
        guard self.isCurrentGatewayStart(generation),
              self.retainedServiceCLI != nil, self.installation == .managed,
              let pid,
              pid != self.childSupervisor.processIdentifier,
              let snapshot = GatewayLaunchAgentManager.launchdConfigSnapshot()
        else { return }
        let state = AppProfile.current.stateDirectoryURL()
        let artifacts = GatewayLaunchAgentManager.generatedEnvironmentArtifacts(
            directory: state.appendingPathComponent("service-env"), profile: .current)
        guard let cli = GatewayLaunchAgentManager.installedServiceCLI(
            snapshot: snapshot, environmentFile: artifacts.environment, environmentWrapper: artifacts.wrapper),
            GatewayLaunchAgentManager.bundledRuntimeReplacementError(
                appManaged: true, installedRuntimePath: cli.prefix.first, stateDirectory: state) == nil
        else { return }
        guard await GatewayLaunchAgentManager.runningGatewayPID() == pid,
              self.isCurrentGatewayStart(generation),
              GatewayLaunchAgentManager.launchdConfigSnapshot() == snapshot
        else { return }
        self.retainedServiceCLI = nil
    }

    func attemptManagedNodeMigration(generation: UInt64) async {
        guard BundledRuntime.isBundledApp, !self.nodeMigrationAttempted,
              self.isCurrentGatewayStart(generation)
        else { return }
        self.nodeMigrationAttempted = true
        self.nodeMigrationNeedsCoreRepair = false
        do {
            guard let candidate = try await ManagedNodeGatewayMigration.candidate(
                onboardingSeen: AppStateStore.shared.onboardingSeen,
                installPolicy: CLIInstallPolicy.storedPolicy(),
                gatewayUpdateChannel: OpenClawConfigFile.gatewayUpdateChannel(),
                retainedCLI: self.nodeMigrationRetainedCLI())
            else { return }
            guard self.isCurrentGatewayStart(generation) else { return }
            self.retainedServiceCLI = candidate.cli
            let result = await self.enableLaunchAgentIfNeeded(
                port: candidate.port, generation: generation, nodeMigration: candidate)
            if self.isCurrentGatewayStart(generation), let error = result.error,
               self.nodeMigrationFailure != error
            {
                self.recordNodeMigrationFailure(error)
            }
        } catch {
            if self.isCurrentGatewayStart(generation) {
                self.recordNodeMigrationFailure(error.localizedDescription)
            }
        }
        if self.isCurrentGatewayStart(generation), self.nodeMigrationFailure != nil || self.nodeMigrationCompleted {
            Task { @MainActor [weak self] in
                guard let self else { return }
                await self.waitForStartupAttempt()
                guard self.isCurrentGatewayStart(generation),
                      self.nodeMigrationFailure != nil || (self.nodeMigrationCompleted &&
                          PostAppUpdateReceiptStore
                          .pending(currentVersion: GatewayEnvironment.appVersionString()) != nil)
                else { return }
                PostUpdateController.shared.startIfNeeded()
            }
        }
    }

    private func recordNodeMigrationFailure(_ message: String) {
        self.nodeMigrationFailure = message
        guard let version = GatewayEnvironment.appVersionString() else { return }
        let receipt = PostAppUpdateReceiptStore.pendingSetupRecovery() ??
            PostAppUpdateReceiptStore.pending(currentVersion: version) ??
            PostAppUpdateReceipt(fromVersion: version, toVersion: version, recordedAt: Date())
        // Publish pending runtime work before startup drain waiters can resume notifications.
        PostAppUpdateReceiptStore.recordMigrationFailure(receipt: receipt)
    }

    func performManagedNodeMigration(
        _ candidate: ManagedNodeGatewayMigration.Candidate,
        generation: UInt64) async -> LaunchAgentEnableResult
    {
        self.nodeMigrationNeedsCoreRepair = false
        do {
            guard let targetVersion = GatewayEnvironment.appVersionString() else {
                throw GatewayHostingError(message: "The bundled Gateway version could not be read.")
            }
            let operations = ManagedNodeGatewayMigration.liveOperations(
                checkCurrent: {
                    guard self.isCurrentGatewayStart(generation) else { throw CancellationError() }
                },
                resolveLegacyCLI: { try self.retainedServiceIntent() },
                verifyHealth: {
                    await (self.connection).shutdown()
                    let pid = await GatewayLaunchAgentManager.reusableLoadedGatewayPID(
                        port: candidate.port, allowUnconfigured: candidate.allowUnconfigured)
                    let context = self.gatewayReadinessContext(
                        purpose: .launchd,
                        port: candidate.port,
                        generation: generation,
                        readinessPID: pid,
                        launchAgentInstalled: true,
                        migrationDrain: true)
                    let terminal = await self.observeGatewayReadiness(
                        context: context,
                        deadlinePolicy: .fixed(timeout: GatewayLaunchAgentManager.startupMigrationTolerance),
                        clock: self.readinessClock)
                    guard case let .ready(instance, _, _) = terminal,
                          let pid, instance?.pid == pid
                    else { throw GatewayHostingError(message: "The migrated Gateway did not become healthy.") }
                },
                setServiceHosting: { current in
                    self.retainedServiceCLI = current.cli
                    self.storeHosting(.service)
                },
                statusHandler: { self.appendLog("[gateway] \($0)\n") })
            let outcome = try await ManagedNodeGatewayMigration.run(
                candidate: candidate,
                targetVersion: targetVersion,
                pendingSetupRecovery: PostAppUpdateReceiptStore.pendingSetupRecovery() ??
                    PostAppUpdateReceiptStore.pending(currentVersion: targetVersion),
                operations: operations)
            guard self.isCurrentGatewayStart(generation) else { throw CancellationError() }
            switch outcome {
            case .coreRepairRequired:
                self.nodeMigrationNeedsCoreRepair = true
                if candidate.snapshot == nil {
                    let failure = "The managed Node update needs repair before resuming the Gateway. " +
                        "Use Retry in the update window."
                    if self.isCurrentGatewayStart(generation) { self.recordNodeMigrationFailure(failure) }
                    return .failed(failure)
                }
            case .versionUpdated:
                self.nodeMigrationVersionUpdated = true
            case .migrated:
                self.nodeMigrationVersionUpdated = false
                self.nodeMigrationCompleted = true
                self.retainedServiceCLI = nil
                do { try await BundledRuntime.garbageCollectAfterHealthy() } catch {
                    self.appendLog("[gateway] old runtime cleanup deferred: \(error.localizedDescription)\n")
                }
            }
            return .installedService
        } catch {
            if self.isCurrentGatewayStart(generation) {
                self.recordNodeMigrationFailure(error.localizedDescription)
                if error.localizedDescription.contains(GatewayLaunchAgentManager.runtimePinSelectionChanged) {
                    self.desiredActive = false
                    self.fail(error.localizedDescription)
                }
            }
            return .failed(error.localizedDescription)
        }
    }

    func refreshLegacyNodeCLI(
        afterCoreUpdate expected: GatewayLaunchAgentManager.InstalledServiceCLI) throws -> GatewayLaunchAgentManager
        .InstalledServiceCLI
    {
        let refreshed = try ManagedNodeGatewayMigration.refreshedLegacyCLI(
            after: expected, currentRetained: self.retainedServiceIntent())
        self.retainedServiceCLI = refreshed
        return refreshed
    }

    func retryManagedNodeMigration(
        coreRepairVerifiedCLI: GatewayLaunchAgentManager.InstalledServiceCLI? = nil) async throws
    {
        let retryGeneration = self.gatewayStartGeneration
        await self.waitForStartupAttempt()
        guard self.isCurrentGatewayStart(retryGeneration), !AppStateStore.shared.isPaused,
              !Task.isCancelled else { throw CancellationError() }
        let receipt = PostAppUpdateReceiptStore.pending(currentVersion: GatewayEnvironment.appVersionString())
        let failedRuntimeSwitch = self.nodeMigrationFailure != nil ||
            receipt?.hasPendingRuntimeMigration == true
        let retained = try self.nodeMigrationRetainedCLI()
        let namedServiceRetry = AppProfile.current.isActive && failedRuntimeSwitch &&
            GatewayLaunchAgentManager.launchdProgramArguments()?.isEmpty == false && retained != nil
        if namedServiceRetry || coreRepairVerifiedCLI != nil {
            let candidate = try await ManagedNodeGatewayMigration.candidate(
                onboardingSeen: AppStateStore.shared.onboardingSeen,
                installPolicy: CLIInstallPolicy.storedPolicy(),
                gatewayUpdateChannel: OpenClawConfigFile.gatewayUpdateChannel(),
                retainedCLI: retained,
                allowNamedServiceRetry: AppProfile.current.isActive,
                coreRepairVerifiedCLI: coreRepairVerifiedCLI)
            guard self.isCurrentGatewayStart(retryGeneration), !AppStateStore.shared.isPaused,
                  !Task.isCancelled else { throw CancellationError() }
            guard let candidate else {
                throw GatewayHostingError(message: "The retained Node service no longer matches this runtime retry; " +
                    "the existing service was preserved.")
            }
            self.nodeMigrationAttempted = true
            self.nodeMigrationFailure = nil
            self.nodeMigrationNeedsCoreRepair = false
            self.nodeMigrationVersionUpdated = false
            self.nodeMigrationCompleted = false
            self.gatewayStartGeneration &+= 1
            let generation = self.gatewayStartGeneration
            self.status = .starting
            let result = await self.enableLaunchAgentIfNeeded(
                port: candidate.port, generation: generation, nodeMigration: candidate)
            if let failure = result.error, failure.contains(GatewayLaunchAgentManager.runtimePinSelectionChanged) {
                throw GatewayHostingError(message: failure)
            }
            guard self.isCurrentGatewayStart(generation) else { throw CancellationError() }
            if let failure = result.error {
                self.recordNodeMigrationFailure(failure)
                self.lastFailureReason = failure
                self.status = .failed(failure)
                throw GatewayHostingError(message: failure)
            }
            guard self.nodeMigrationCompleted || self.nodeMigrationVersionUpdated else {
                throw GatewayHostingError(
                    message: "The Gateway runtime switch did not finish; retry core repair first.")
            }
            self.status = .stopped
            self.startIfNeeded()
            await self.waitForStartupAttempt()
            return
        }
        self.nodeMigrationAttempted = false
        self.nodeMigrationFailure = nil
        self.nodeMigrationNeedsCoreRepair = false
        self.nodeMigrationVersionUpdated = false
        self.nodeMigrationCompleted = false
        self.status = .stopped
        self.startIfNeeded()
        await self.waitForStartupAttempt()
        if let failure = self.nodeMigrationFailure { throw GatewayHostingError(message: failure) }
        if retained != nil, !self.nodeMigrationCompleted, !self.nodeMigrationVersionUpdated {
            throw GatewayHostingError(message: "The retained Gateway was not eligible for this runtime switch.")
        }
    }

    func storeHosting(_ hosting: GatewayHosting) {
        if hosting == .app { self.retainedServiceCLI = nil }
        AppDefaults.standard.set(hosting.rawValue, forKey: GatewayHosting.defaultsKey)
        self.hostingRevision &+= 1
    }

    func appHostedEnvironment(runtime: BundledRuntime) throws -> [String: String] {
        let profile = AppProfile.current
        let retained = try GatewayLaunchAgentManager.retainedServiceEnvironment(
            stateDirectory: profile.stateDirectoryURL(), profile: profile)
        return Self.appHostedEnvironment(
            runtime: runtime,
            profile: profile,
            processEnvironment: ProcessInfo.processInfo.environment,
            retainedEnvironment: retained,
            searchPaths: CommandResolver.preferredPaths())
    }

    static func appHostedEnvironment(
        runtime: BundledRuntime,
        profile: AppProfile,
        processEnvironment: [String: String],
        retainedEnvironment: [String: String],
        searchPaths: [String]) -> [String: String]
    {
        var environment = processEnvironment.merging(retainedEnvironment) { _, retained in retained }
        let servicePaths = environment["PATH"]?.split(separator: ":").map(String.init) ?? []
        environment.merge(runtime.environment) { _, runtimeValue in runtimeValue }
        var seen = Set<String>()
        environment["PATH"] = ([runtime.bun.deletingLastPathComponent().path] + servicePaths + searchPaths)
            .filter { seen.insert($0).inserted }.joined(separator: ":")
        environment["OPENCLAW_PROFILE"] = profile.name ?? "default"
        environment["OPENCLAW_STATE_DIR"] = profile.stateDirectoryURL().path
        environment["OPENCLAW_CONFIG_PATH"] = profile.stateDirectoryURL().appendingPathComponent("openclaw.json").path
        return environment
    }

    func startAppHostedGateway(startGeneration: UInt64) async {
        guard self.isCurrentGatewayStart(startGeneration) else { return }
        guard self.installation == .managed else {
            let reason = self.installation == .unreadable
                ? Installation.ownershipFailure
                : "This Gateway is externally managed. Start it with its installation owner."
            self.fail(reason)
            return
        }
        do {
            let runtime = try await BundledRuntime.seed()
            guard self.isCurrentGatewayStart(startGeneration) else { return }
            let port = GatewayEnvironment.gatewayPort()
            if await PortGuardian.shared.describe(port: port) != nil {
                _ = await self.attachExistingGatewayIfAvailable(port: port, startGeneration: startGeneration)
                return
            }
            guard self.isCurrentGatewayStart(startGeneration) else { return }
            let environment = try self.appHostedEnvironment(runtime: runtime)
            let pid = try await self.childSupervisor.start(configuration: .init(
                bun: runtime.bun,
                packageRoot: runtime.packageRoot,
                environment: environment,
                logPath: GatewayLaunchAgentManager.launchdGatewayLogPath(),
                port: port,
                allowUnconfigured: self.hostsLocalGatewayWithRemotePrimary))
            { [weak self] event in
                self?.handleChildEvent(event, port: port)
            }
            guard self.isCurrentGatewayStart(startGeneration) else { return }
            await self.observeChildReadiness(pid: pid, port: port, generation: startGeneration)
        } catch {
            guard self.isCurrentGatewayStart(startGeneration) else { return }
            self.fail(error.localizedDescription)
            self.appendLog("[gateway] \(error.localizedDescription)\n")
            self.logger.error("gateway child launch failed: \(error.localizedDescription, privacy: .public)")
        }
    }

    func handleChildEvent(_ event: GatewayChildSupervisor.Event, port: Int) {
        // A readiness retry can attach the same child. Its supervisor remains the event owner
        // until stop drains it, independently of which readiness attempt created the child.
        let generation = self.gatewayStartGeneration
        guard self.isCurrentGatewayStart(generation), self.launchAgentDisableTask == nil else { return }
        self.setLaunchAgentReadinessState(candidate: nil, failure: nil)
        self.gatewayStartTask?.cancel()
        switch event {
        case let .started(pid):
            self.status = .starting
            self.beginGatewayStartTask(generation: generation) { [weak self] in
                await self?.observeChildReadiness(pid: pid, port: port, generation: generation)
            }
        case let .restarting(delay):
            self.status = .starting
            self.appendLog("[gateway] child exited; restarting in \(delay)\n")
        case let .failed(reason):
            self.terminalChildFailureGeneration = generation
            self.desiredActive = false
            self.fail(reason)
            self.appendLog("[gateway] \(reason)\n")
        }
    }

    func prepareHostingRecoveryActivation(generation: UInt64, restoring: GatewayHosting) throws -> UInt64? {
        guard !self.isTerminating, self.gatewayStartGeneration == generation, !AppStateStore.shared.isPaused else {
            throw CancellationError()
        }
        guard !self.desiredActive else { return nil }
        guard restoring == .service, self.terminalChildFailureGeneration == generation else {
            throw CancellationError()
        }
        // The admitted switch still owns service custody. Rearm only its exhausted replacement
        // child; keep the failure fact until health or cleanup settles this recovery.
        self.desiredActive = true
        return generation
    }

    func finishHostingRecoveryActivation(
        _ failedGeneration: UInt64?, generation: UInt64, healthy: Bool, failure: String?)
    {
        guard let failedGeneration, self.terminalChildFailureGeneration == failedGeneration else { return }
        self.terminalChildFailureGeneration = nil
        if !healthy, self.gatewayStartGeneration == generation {
            self.desiredActive = false
            if let failure {
                self.fail(failure)
            }
        }
    }

    private func observeChildReadiness(pid: Int32, port: Int, generation: UInt64) async {
        let context = self.gatewayReadinessContext(
            purpose: .child, port: port, generation: generation, readinessPID: pid)
        let terminal = await self.observeGatewayReadiness(
            context: context,
            deadlinePolicy: .startup(timeout: GatewayLaunchAgentManager.startupMigrationTolerance),
            clock: self.readinessClock)
        if await self.publishGatewayReadinessTerminal(terminal, context: context) {
            do { try await BundledRuntime.garbageCollectAfterHealthy() } catch {
                self.appendLog("[gateway] old runtime cleanup deferred: \(error.localizedDescription)\n")
            }
        }
    }

    func shutdownAppHostedGateway() async {
        self.isTerminating = true
        _ = try? await self.hostingChangeTask?.value
        // Already-admitted service writes and a pending pause settle before app exit.
        // Quitting otherwise leaves the always-on service alone.
        _ = await self.launchAgentEnableTask?.value
        await self.waitForPendingLaunchAgentDisable()
        guard self.childSupervisor.isActive || self.gatewayStartTask != nil || self.bundledUpdateTask != nil else {
            return
        }
        guard self.gatewayHosting == .app || self.childSupervisor.isActive else { return }
        let updateTask = self.bundledUpdateTask
        updateTask?.cancel()
        self.desiredActive = false
        self.gatewayStartGeneration &+= 1
        self.gatewayStartTask?.cancel()
        await self.childSupervisor.stop()
        await self.gatewayStartTask?.value
        _ = try? await updateTask?.value
        self.status = .stopped
    }

    func prepareBundledRuntimeAfterUpdate(source: ActivationSource = .recovery) async throws -> CLIInstaller
    .LocalGatewayActivation {
        var activationGeneration = self.gatewayStartGeneration
        while true {
            guard !self.isTerminating, !Task.isCancelled else { throw CancellationError() }
            if let task = self.bundledUpdateTask {
                let id = self.bundledUpdateTaskID
                let result = try await task.value
                let activation = try self.currentBundledRuntimeActivation(result)
                if source == .request, result.source == .recovery,
                   activation != .ready, !AppStateStore.shared.isPaused
                {
                    activationGeneration = result.generation
                    // An explicit Retry joins existing work, then gets one explicit attempt.
                    // Another requester may already own that attempt; its task must survive this cleanup.
                    if self.bundledUpdateTaskID == id {
                        self.bundledUpdateTask = nil
                        self.bundledUpdateTaskID = nil
                    }
                    continue
                }
                return activation
            }
            _ = try? await self.hostingChangeTask?.value
            if let activation = try self.validateBundledRuntimeArrival(generation: activationGeneration) {
                return activation
            }
            if self.bundledUpdateTask != nil { continue }
            let id = UUID()
            let generation = activationGeneration
            let task = Task { @MainActor in
                try await self.performBundledRuntimeUpdate(source: source, generation: generation)
            }
            self.bundledUpdateTask = task
            self.bundledUpdateTaskID = id
            defer {
                if self.bundledUpdateTaskID == id {
                    self.bundledUpdateTask = nil
                    self.bundledUpdateTaskID = nil
                }
            }
            return try await self.currentBundledRuntimeActivation(task.value)
        }
    }

    private func validateBundledRuntimeArrival(generation: UInt64) throws -> CLIInstaller.LocalGatewayActivation? {
        guard !self.isTerminating, !Task.isCancelled else { throw CancellationError() }
        guard self.gatewayStartGeneration == generation else {
            if AppStateStore.shared.isPaused { return .deferred }
            throw CancellationError()
        }
        return nil
    }

    private func bundledRuntimeUpdateIsPaused(generation: UInt64) throws -> Bool {
        guard !self.isTerminating, !Task.isCancelled else { throw CancellationError() }
        if AppStateStore.shared.isPaused { return true }
        guard self.gatewayStartGeneration == generation else { throw CancellationError() }
        return false
    }

    private func inactiveBundledRuntimeActivation() -> CLIInstaller.LocalGatewayActivation {
        if case let .failed(reason) = self.status { return .failed(reason: reason) }
        return .deferred
    }

    private func currentBundledRuntimeActivation(_ result: BundledRuntimeUpdateResult) throws -> CLIInstaller
    .LocalGatewayActivation {
        if try self.bundledRuntimeUpdateIsPaused(generation: result.generation) { return .deferred }
        if result.activation == .ready {
            guard self.desiredActive else { return self.inactiveBundledRuntimeActivation() }
            if case let .failed(reason) = self.status { return .failed(reason: reason) }
        }
        return result.activation
    }

    func activatePreparedBundledRuntime(
        source: ActivationSource,
        generation: UInt64,
        selection: (hosting: GatewayHosting, port: Int, allowUnconfigured: Bool),
        expectedService: ManagedNodeGatewayMigration.ServiceCustody) async throws -> CLIInstaller
        .LocalGatewayActivation?
    {
        let current = try await ManagedNodeGatewayMigration.captureServiceCustody(requireService: false)
        if try self.bundledRuntimeUpdateIsPaused(generation: generation) { return .deferred }
        guard current == expectedService, self.installation == .managed,
              self.gatewayHosting == selection.hosting, GatewayEnvironment.gatewayPort() == selection.port,
              self.hostsLocalGatewayWithRemotePrimary == selection.allowUnconfigured,
              !CommandResolver.connectionModeIsRemote() || self.hostsLocalGatewayWithRemotePrimary
        else { throw GatewayHostingError(message: "Gateway ownership changed while preparing its runtime; retry.") }
        if source == .recovery, !self.desiredActive { return self.inactiveBundledRuntimeActivation() }
        // Preparation owns startup until the old host is drained. Explicit Retry restores
        // intent here, after seeding, without launching the previous broken runtime first.
        let wasChangingHosting = self.hostingChangeInProgress
        self.hostingChangeInProgress = true
        defer { self.hostingChangeInProgress = wasChangingHosting }
        self.setActive(true, source: source)
        return self.desiredActive ? nil : .failed(reason: self.lastFailureReason)
    }

    private func restartPreparedBundledChild(
        selection: (hosting: GatewayHosting, port: Int, allowUnconfigured: Bool),
        expectedService: ManagedNodeGatewayMigration.ServiceCustody) async throws
        -> (activation: CLIInstaller.LocalGatewayActivation?, generation: UInt64)
    {
        let authority = try expectedService.serviceAuthority()
        self.stop(preservingActivationIntent: true, expectedServiceAuthority: authority)
        let stopGeneration = self.gatewayStartGeneration
        await self.waitForPendingLaunchAgentDisable()
        if try self.bundledRuntimeUpdateIsPaused(generation: stopGeneration) { return (.deferred, stopGeneration) }
        guard try await ManagedNodeGatewayMigration.captureServiceCustody(requireService: false) == expectedService
        else {
            throw GatewayHostingError(
                message: "Gateway ownership changed while restarting; the newer service was preserved.")
        }
        if try self.bundledRuntimeUpdateIsPaused(generation: stopGeneration) { return (.deferred, stopGeneration) }
        if let failure = self.lastFailureReason { throw GatewayHostingError(message: failure) }
        guard self.gatewayHosting == selection.hosting, GatewayEnvironment.gatewayPort() == selection.port,
              self.hostsLocalGatewayWithRemotePrimary == selection.allowUnconfigured
        else { throw GatewayHostingError(message: "Gateway selection changed while restarting; retry.") }
        guard self.desiredActive else { return (self.inactiveBundledRuntimeActivation(), stopGeneration) }
        self.hostingChangeInProgress = false
        self.startIfNeeded()
        return (nil, self.gatewayStartGeneration)
    }

    private func performBundledRuntimeUpdate(
        source: ActivationSource, generation updateGeneration: UInt64) async throws -> BundledRuntimeUpdateResult
    {
        await self.waitForStartupAttempt()
        if let activation = try self.validateBundledRuntimeArrival(generation: updateGeneration) {
            return .init(activation: activation, generation: updateGeneration, source: source)
        }
        var ownedGeneration = updateGeneration
        func completion(_ activation: CLIInstaller.LocalGatewayActivation) -> BundledRuntimeUpdateResult {
            .init(activation: activation, generation: ownedGeneration, source: source)
        }
        try self.loadRetainedServiceForResume()
        guard self.usesSeededGateway else {
            throw GatewayHostingError(
                message: "This Gateway is no longer hosted by OpenClaw.app. Update it with its installation owner.")
        }
        let hosting = self.gatewayHosting
        let port = GatewayEnvironment.gatewayPort()
        let allowUnconfigured = self.hostsLocalGatewayWithRemotePrimary
        var custody = try await ManagedNodeGatewayMigration.captureServiceCustody(requireService: false)
        let pausedUpdate = AppStateStore.shared.isPaused ? try self.preparePausedServiceUpdate() : nil
        self.hostingChangeInProgress = true
        defer { self.hostingChangeInProgress = false }
        let runtime = try await BundledRuntime.seed()
        if try self.bundledRuntimeUpdateIsPaused(generation: updateGeneration) {
            if self.gatewayStartGeneration == updateGeneration {
                try await self.completePausedServiceUpdate(pausedUpdate, runtime: runtime) {
                    guard !self.isTerminating, !Task.isCancelled,
                          self.gatewayStartGeneration == updateGeneration, AppStateStore.shared.isPaused
                    else { throw CancellationError() }
                }
            }
            return completion(.deferred)
        }
        guard self.gatewayHosting == hosting, GatewayEnvironment.gatewayPort() == port,
              self.hostsLocalGatewayWithRemotePrimary == allowUnconfigured
        else { throw GatewayHostingError(message: "Gateway selection changed while preparing its runtime; retry.") }
        if let activation = try await self.activatePreparedBundledRuntime(
            source: source,
            generation: updateGeneration,
            selection: (hosting, port, allowUnconfigured),
            expectedService: custody) { return completion(activation) }
        if hosting == .app {
            let restart = try await self.restartPreparedBundledChild(
                selection: (hosting, port, allowUnconfigured), expectedService: custody)
            ownedGeneration = restart.generation
            if let activation = restart.activation { return completion(activation) }
        } else {
            self.gatewayStartGeneration &+= 1
            let generation = self.gatewayStartGeneration
            ownedGeneration = generation
            self.status = .starting
            let expectedService = custody
            let result = try await self.enableLaunchAgentIfNeeded(
                port: port,
                generation: generation,
                runtimeForUpdate: runtime,
                expectedServiceAuthority: custody.serviceAuthority(),
                mutationCheck: {
                    let current = try await ManagedNodeGatewayMigration.captureServiceCustody(requireService: false)
                    guard !self.isTerminating, !AppStateStore.shared.isPaused,
                          self.isCurrentGatewayStart(generation), current == expectedService
                    else { throw CancellationError() }
                })
            if try self.bundledRuntimeUpdateIsPaused(generation: generation) { return completion(.deferred) }
            if let error = result.error {
                self.fail(error)
                throw GatewayHostingError(message: error)
            }
            guard result.installed
            else { throw GatewayHostingError(message: "The updated Gateway service was not installed.") }
            custody = try await ManagedNodeGatewayMigration.installedServiceCustody(
                runtime: runtime, port: port, allowUnconfigured: allowUnconfigured)
            if try self.bundledRuntimeUpdateIsPaused(generation: generation) { return completion(.deferred) }
        }
        let readinessGeneration = ownedGeneration
        let ready = await self.waitForGatewayReady(timeout: GatewayLaunchAgentManager.startupMigrationTolerance)
        if try self.bundledRuntimeUpdateIsPaused(generation: readinessGeneration) { return completion(.deferred) }
        guard ready else {
            return completion(.failed(reason: self.lastFailureReason ?? "The updated Gateway did not become ready."))
        }
        guard try await ManagedNodeGatewayMigration.captureServiceCustody(requireService: false) == custody,
              GatewayEnvironment.gatewayPort() == port, self.gatewayHosting == hosting,
              self.hostsLocalGatewayWithRemotePrimary == allowUnconfigured
        else { throw GatewayHostingError(message: "Gateway ownership changed while verifying its runtime; retry.") }
        if try self.bundledRuntimeUpdateIsPaused(generation: readinessGeneration) { return completion(.deferred) }
        do { try await BundledRuntime.garbageCollectAfterHealthy() } catch {
            self.appendLog("[gateway] old runtime cleanup deferred: \(error.localizedDescription)\n")
        }
        if try self.bundledRuntimeUpdateIsPaused(generation: readinessGeneration) { return completion(.deferred) }
        return completion(self.desiredActive ? .ready : self.inactiveBundledRuntimeActivation())
    }
}
