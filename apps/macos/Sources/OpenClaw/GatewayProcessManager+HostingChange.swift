import Foundation

extension GatewayProcessManager {
    @MainActor
    struct HostingChangeOperations {
        var prepare: () async throws -> Void
        var isAuthorized: () -> Bool
        var replace: (_ admit: @escaping @MainActor () throws -> Void) async throws -> Bool
        var recover: () async throws -> Void
        var verifyHealth: () async throws -> Void
    }

    static func changeHosting(operations: HostingChangeOperations) async throws {
        try await operations.prepare()
        guard operations.isAuthorized() else { throw CancellationError() }
        var admitted = false
        do {
            let verify = try await operations.replace {
                guard operations.isAuthorized() else { throw CancellationError() }
                admitted = true
            }
            if verify { try await operations.verifyHealth() }
        } catch {
            guard admitted else { throw error }
            let failure = error.localizedDescription
            do {
                try await operations.recover()
                try await operations.verifyHealth()
            } catch {
                throw GatewayHostingError(
                    message: "\(failure) Previous Gateway recovery: \(error.localizedDescription)")
            }
            throw GatewayHostingError(message: failure)
        }
    }

    @MainActor
    private final class HostingChange {
        let previous: GatewayHosting
        let previousCLI: GatewayLaunchAgentManager.InstalledServiceCLI?
        let port: Int
        let allowUnconfigured: Bool
        var generation: UInt64
        var expectedService: ManagedNodeGatewayMigration.ServiceCustody
        var runtime: BundledRuntime?
        var recoveryActivation: UInt64?
        var recoveryHealthy = false
        var recoveryFailure: String?
        init(manager: GatewayProcessManager, service: ManagedNodeGatewayMigration.ServiceCustody) {
            self.previous = manager.gatewayHosting
            self.previousCLI = GatewayLaunchAgentManager.installedServiceCLI() ?? manager.retainedServiceCLI
            self.port = GatewayEnvironment.gatewayPort()
            self.allowUnconfigured = manager.hostsLocalGatewayWithRemotePrimary
            self.generation = manager.gatewayStartGeneration
            self.expectedService = service
        }
    }

    func setKeepGatewayRunning(
        _ enabled: Bool,
        isAuthorized: @escaping @MainActor () -> Bool = { true }) async throws
    {
        guard !self.isTerminating, isAuthorized() else { throw CancellationError() }
        let previous = self.hostingChangeTask
        let id = UUID()
        let task = Task { @MainActor in
            _ = try? await previous?.value
            try await self.performHostingChange(to: enabled ? .service : .app, isAuthorized: isAuthorized)
        }
        self.hostingChangeTask = task
        self.hostingChangeID = id
        defer {
            if self.hostingChangeID == id {
                self.hostingChangeTask = nil
                self.hostingChangeID = nil
                self.startIfNeeded()
            }
        }
        try await task.value
    }

    private func performHostingChange(
        to hosting: GatewayHosting,
        isAuthorized: @escaping @MainActor () -> Bool) async throws
    {
        _ = try? await self.bundledUpdateTask?.value
        await self.waitForStartupAttempt()
        guard !self.isTerminating, isAuthorized() else { throw CancellationError() }
        try self.loadRetainedServiceForResume()
        guard self.keepGatewayRunningAvailable else {
            throw GatewayHostingError(message: "This Gateway is not hosted by OpenClaw.app.")
        }
        guard self.gatewayHosting != hosting else { return }
        self.hostingChangeInProgress = true
        defer { self.hostingChangeInProgress = false }
        let service = try await Self.hostingServiceCustody()
        guard isAuthorized() else { throw CancellationError() }
        let change = HostingChange(manager: self, service: service)
        defer {
            self.finishHostingRecoveryActivation(
                change.recoveryActivation,
                generation: change.generation,
                healthy: change.recoveryHealthy,
                failure: change.recoveryFailure)
        }
        if hosting == .app { try self.requireDurableAppHostingEnvironment(change.previousCLI) }
        do {
            try await Self.changeHosting(operations: .init(
                prepare: {
                    change.runtime = try await BundledRuntime.seed()
                    _ = try GatewayLaunchAgentManager.retainedServiceEnvironment(
                        stateDirectory: AppProfile.current.stateDirectoryURL())
                    try await self.checkHostingChange(change)
                },
                isAuthorized: isAuthorized,
                replace: { admit in
                    if !self.desiredActive || AppStateStore.shared.isPaused {
                        try admit()
                        if hosting == .service, let runtime = change.runtime {
                            self.retainedServiceCLI = try GatewayLaunchAgentManager.InstalledServiceCLI(
                                prefix: runtime.cliCommand,
                                sqliteLibrary: runtime.sqliteLibrary.path,
                                environment: self.appHostedEnvironment(runtime: runtime),
                                usesGeneratedEnvironment: change.expectedService.definition.environment != nil &&
                                    change.expectedService.definition.wrapper != nil)
                        }
                        self.storeHosting(hosting)
                        return false
                    }
                    // All prior drains have settled before the document transfers this operation
                    // to the lifecycle owner. Its admitted replacement includes failure recovery.
                    try await self.checkHostingChange(change)
                    guard isAuthorized() else { throw CancellationError() }
                    try await self.stopHostingChange(change, admission: admit)
                    self.storeHosting(hosting)
                    try await self.startHostingChange(change, hosting: hosting, restoring: false)
                    return true
                },
                recover: {
                    try await self.checkHostingChange(change)
                    change.recoveryActivation = try self.prepareHostingRecoveryActivation(
                        generation: change.generation, restoring: change.previous)
                    try await self.stopHostingChange(change)
                    if change.previous == .service { self.retainedServiceCLI = change.previousCLI }
                    self.storeHosting(change.previous)
                    try await self.startHostingChange(change, hosting: change.previous, restoring: true)
                },
                verifyHealth: {
                    try await self.verifyHostingChange(change)
                    if change.recoveryActivation != nil { change.recoveryHealthy = true }
                }))
        } catch {
            change.recoveryFailure = error.localizedDescription
            throw error
        }
    }

    private static func hostingServiceCustody() async throws -> ManagedNodeGatewayMigration.ServiceCustody {
        let custody = try await ManagedNodeGatewayMigration.captureServiceCustody(requireService: false)
        guard custody.definition.plist != nil || custody.runtimePin == nil else {
            throw GatewayHostingError(
                message: "Gateway service or runtime pin changed; the newer selection was preserved.")
        }
        return custody
    }

    private func checkHostingChange(_ change: HostingChange, requiresActive: Bool = false) async throws {
        let service = try await Self.hostingServiceCustody()
        guard !self.isTerminating, self.gatewayStartGeneration == change.generation,
              !requiresActive || (self.desiredActive && !AppStateStore.shared.isPaused)
        else { throw CancellationError() }
        guard service == change.expectedService,
              GatewayEnvironment.gatewayPort() == change.port,
              self.hostsLocalGatewayWithRemotePrimary == change.allowUnconfigured,
              self.installation == .managed
        else {
            throw GatewayHostingError(message: "Gateway ownership changed; the newer service was preserved.")
        }
    }

    private func stopHostingChange(
        _ change: HostingChange,
        admission: () throws -> Void = {}) async throws
    {
        _ = await self.launchAgentEnableTask?.value
        await self.waitForPendingLaunchAgentDisable()
        try await self.checkHostingChange(change, requiresActive: true)
        try admission()
        try self.stop(
            preservingActivationIntent: true,
            expectedServiceAuthority: change.expectedService.serviceAuthority(),
            mutationCheck: { try await self.checkHostingChange(change, requiresActive: true) })
        change.generation = self.gatewayStartGeneration
        await self.waitForPendingLaunchAgentDisable()
        guard !self.isTerminating, self.gatewayStartGeneration == change.generation,
              self.desiredActive, !AppStateStore.shared.isPaused else { throw CancellationError() }
        let current = try await Self.hostingServiceCustody()
        // An uninstall that failed before changing the original service retains that claim;
        // any other installed definition is external to this transition and remains untouched.
        guard current == change.expectedService.afterUninstall || current == change.expectedService else {
            throw GatewayHostingError(
                message: "Gateway service changed while stopping; the newer service was preserved.")
        }
        change.expectedService = current
        if let failure = self.lastFailureReason { throw GatewayHostingError(message: failure) }
        guard current.definition.plist == nil
        else { throw GatewayHostingError(message: "The previous Gateway service was not removed.") }
    }

    private func startHostingChange(_ change: HostingChange, hosting: GatewayHosting, restoring: Bool) async throws {
        try await self.checkHostingChange(change, requiresActive: true)
        guard let runtime = change.runtime else { throw CancellationError() }
        if hosting == .app {
            self.hostingChangeInProgress = false
            self.startIfNeeded()
            change.generation = self.gatewayStartGeneration
            self.hostingChangeInProgress = true
            return
        }
        self.gatewayStartGeneration &+= 1
        change.generation = self.gatewayStartGeneration
        self.status = .starting
        let cli = restoring ? change.previousCLI : nil
        let selectedRuntime = cli?.prefix.first.map {
            BundledRuntime(root: URL(fileURLWithPath: $0).deletingLastPathComponent().deletingLastPathComponent())
        } ?? runtime
        let result = try await self.enableLaunchAgentIfNeeded(
            port: change.port,
            generation: change.generation,
            runtimeForUpdate: cli == nil ? selectedRuntime : nil,
            runtimeEnvironment: cli == nil ? self.appHostedEnvironment(runtime: selectedRuntime) : nil,
            serviceForRestoration: cli,
            expectedServiceAuthority: change.expectedService.serviceAuthority(),
            mutationCheck: { try await self.checkHostingChange(change, requiresActive: true) })
        do {
            change.expectedService = try await ManagedNodeGatewayMigration.installedServiceCustody(
                runtime: selectedRuntime,
                port: change.port,
                allowUnconfigured: change.allowUnconfigured,
                allowMissingRuntimePin: result.error != nil)
        } catch {
            // Before publication, a failed installer leaves the known empty service scope.
            // Do not acquire an arbitrary replacement just because the installer returned.
            if let failure = result.error { throw GatewayHostingError(message: failure) }
            throw error
        }
        if let failure = result.error { throw GatewayHostingError(message: failure) }
        guard result.installed else { throw GatewayHostingError(message: "The Gateway service was not installed.") }
    }

    private func requireDurableAppHostingEnvironment(_ cli: GatewayLaunchAgentManager.InstalledServiceCLI?) throws {
        guard let cli, let executable = cli.prefix.first else { return }
        let profile = AppProfile.current
        let retained = try GatewayLaunchAgentManager.retainedServiceEnvironment(
            stateDirectory: profile.stateDirectoryURL(), profile: profile)
        let runtime = BundledRuntime(root: URL(fileURLWithPath: executable)
            .deletingLastPathComponent().deletingLastPathComponent())
        func projected(_ environment: [String: String]) -> [String: String] {
            GatewayChildSupervisor.environmentWithoutSupervisorMarkers(Self.appHostedEnvironment(
                runtime: runtime,
                profile: profile,
                processEnvironment: [:],
                retainedEnvironment: environment,
                searchPaths: []))
        }
        // Compare what a fresh child would inherit, excluding runtime/profile values and
        // supervisor markers that its owners replace. Ambient app values are not durable.
        guard projected(cli.environment) == projected(retained) else {
            throw GatewayHostingError(message:
                "Gateway settings exist only in its service definition. Keep background hosting enabled. " +
                    "Move the settings into the profile's persistent configuration or .env file, " +
                    "then run openclaw gateway install --force and try again.")
        }
    }

    private func verifyHostingChange(_ change: HostingChange) async throws {
        guard await self.waitForGatewayReady(timeout: GatewayLaunchAgentManager.startupMigrationTolerance) else {
            throw GatewayHostingError(message: self.lastFailureReason ?? "The Gateway did not become ready.")
        }
        try await self.checkHostingChange(change, requiresActive: true)
    }
}
