import Foundation
import Observation
import OpenClawKit

private struct GatewayHealthProbeTimeout: LocalizedError, Sendable {
    let timeoutMs: Double

    var errorDescription: String? {
        "Gateway health probe timed out after \(Int(self.timeoutMs))ms"
    }
}

@MainActor
@Observable
final class GatewayProcessManager {
    static let shared = GatewayProcessManager()

    private struct LaunchAgentReadinessFailure: Equatable {
        let port: Int
        let pid: Int32
    }

    private struct LaunchAgentReadinessCandidate: Equatable {
        let failure: LaunchAgentReadinessFailure
        let generation: UInt64
    }

    private struct GatewayReadinessContext {
        let purpose: GatewayReadinessPurpose
        let port: Int
        let generation: UInt64
        let readinessPID: Int32?
        let readinessRevision: UInt64
        let readinessCandidate: LaunchAgentReadinessCandidate?
        let readinessFailure: LaunchAgentReadinessFailure?
        let endpointPIDBeforeProbe: Int32?
        let launchAgentInstalled: Bool
        let inspectionFailure: String?
    }

    private enum GatewayReadinessFailure {
        case attachProbe(String)
        case responsiveProbe(String)
        case serviceInspection(String)
        case timeoutWithRepairEvidence(LaunchAgentReadinessFailure)
        case deadlineWithoutRepairEvidence

        var reason: String {
            switch self {
            case let .attachProbe(reason), let .responsiveProbe(reason), let .serviceInspection(reason): reason
            case .timeoutWithRepairEvidence: "Gateway did not start in time"
            case .deadlineWithoutRepairEvidence: "Gateway did not become ready in time"
            }
        }
    }

    private enum GatewayReadinessTerminal {
        case ready(
            instance: PortGuardian.Descriptor?,
            startingPID: Int32?,
            snapshot: HealthSnapshot?)
        case superseded
        case failed(GatewayReadinessFailure)
    }

    private(set) var status: Status = .stopped {
        didSet { CanvasManager.shared.refreshDebugStatus() }
    }

    /// Pause removes managed service records without changing installation responsibility.
    /// Remember the established owner, not just that this port once answered.
    var gatewayOwnership: (port: Int, installation: Installation)?

    private(set) var log: String = ""
    private(set) var environmentStatus: GatewayEnvironmentStatus = .checking
    private(set) var existingGatewayDetails: String?
    private(set) var lastFailureReason: String?

    var retainedServiceCLI: GatewayLaunchAgentManager.InstalledServiceCLI? {
        didSet {
            if let cli = self.retainedServiceCLI {
                AppDefaults.standard.set(
                    try? GatewayLaunchAgentManager.resumeData(for: cli),
                    forKey: GatewayLaunchAgentManager.resumeCommandKey)
            } else {
                AppDefaults.standard.removeObject(forKey: GatewayLaunchAgentManager.resumeCommandKey)
            }
        }
    }

    var installation: Installation {
        self.installation(for: GatewayEnvironment.gatewayPort(), whenMissing: .managed)
    }

    var gatewayHosting: GatewayHosting {
        if self.retainedServiceCLI != nil ||
            AppDefaults.standard.object(forKey: GatewayLaunchAgentManager.resumeCommandKey) != nil
        {
            return .service
        }
        return GatewayHosting.resolve(
            stored: AppDefaults.standard.string(forKey: GatewayHosting.defaultsKey),
            bundled: BundledRuntime.isBundledApp,
            serviceExists: GatewayLaunchAgentManager.launchdProgramArguments()?.isEmpty != true)
    }

    var hasAppHostedGateway: Bool {
        self.childSupervisor.isActive
    }

    var usesSeededGateway: Bool {
        if (try? self.shouldDeferLegacyServiceWhilePaused()) != false { return false }
        guard BundledRuntime.isBundledApp, self.installation == .managed,
              !CommandResolver.connectionModeIsRemote() || self.hostsLocalGatewayWithRemotePrimary,
              let arguments = GatewayLaunchAgentManager.launchdProgramArguments()
        else { return false }
        return GatewayHosting.usesSeededGateway(
            hasService: !arguments.isEmpty,
            installedCLI: GatewayLaunchAgentManager.installedServiceCLI(),
            hasCurrentSeed: self.childSupervisor.isActive || (try? BundledRuntime.seeded()) != nil,
            stateDirectory: OpenClawPaths.stateDirURL,
            hasRetainedService: self.retainedServiceCLI != nil ||
                AppDefaults.standard.object(forKey: GatewayLaunchAgentManager.resumeCommandKey) != nil,
            retainedCLI: self.retainedServiceCLI)
    }

    private var desiredActive = false
    private(set) var isTerminating = false
    private var environmentRefreshTask: Task<Void, Never>?
    private var lastEnvironmentRefresh: Date?
    private var logRefreshTask: Task<Void, Never>?
    private var launchAgentEnableTask: Task<[UInt64: LaunchAgentEnableResult], Never>?
    private var launchAgentEnableCurrentRequest: LaunchAgentEnableRequest?
    private var launchAgentEnablePendingRequest: LaunchAgentEnableRequest?
    private var launchAgentEnableNextInvocationID: UInt64 = 0
    private var launchAgentDisableTask: Task<Void, Never>?
    private var launchAgentDisableGeneration: UInt64?
    private var launchAgentReadinessFailure: LaunchAgentReadinessFailure?
    private var launchAgentReadinessCandidate: LaunchAgentReadinessCandidate?
    private var launchAgentReadinessRevision: UInt64 = 0
    private var launchAgentInstallGeneration: UInt64?
    private var launchAgentFreshInstallGeneration: UInt64?
    private var profilePortConflict: String?
    private var lastObservedGatewayPID: Int32?
    /// Async readiness audits may outlive stop/restart. Only the current generation may publish
    /// their failure state or retain a PID for a later repair.
    private var gatewayStartGeneration: UInt64 = 0
    private var gatewayStartTask: Task<Void, Never>?
    private var gatewayStartTaskGeneration: UInt64?
    private var gatewayStartTaskID: UUID?
    private let childSupervisor = GatewayChildSupervisor()
    private var bundledUpdateTask: Task<Void, Error>?
    #if DEBUG
    private var testingConnection: GatewayConnection?
    private var testingLaunchAgentDisableWaitHook: (() -> Void)?
    private var testingSkipControlChannelRefresh = false
    private var testingControlChannelRefreshForces: [Bool] = []
    #endif
    private let logger = Logger(subsystem: "ai.openclaw", category: "gateway.process")

    private let logLimit = 20000 // characters to keep in-memory
    private let environmentRefreshMinInterval: TimeInterval = 30
    private let readinessClock: any Clock<Duration>

    init(readinessClock: any Clock<Duration> = ContinuousClock()) {
        self.readinessClock = readinessClock
    }

    private var hostsLocalGatewayWithRemotePrimary: Bool {
        CommandResolver.connectionModeIsRemote() && AppStateStore.shared.hostsLocalGatewayWithRemotePrimary
    }

    private var connection: GatewayConnection {
        get async {
            #if DEBUG
            if let testingConnection { return testingConnection }
            #endif
            if CommandResolver.connectionModeIsRemote() {
                return await MacGatewayConnectionFleet.shared.localConnection()
            }
            return .shared
        }
    }

    enum ActivationSource {
        case request, recovery
    }

    func setActive(_ active: Bool, source: ActivationSource = .request) {
        guard !self.isTerminating else { return }
        if active, source == .recovery {
            guard self.desiredActive, !AppStateStore.shared.isPaused else { return }
        }
        if CommandResolver.connectionModeIsRemote(), !self.hostsLocalGatewayWithRemotePrimary {
            self.desiredActive = false
            self.stop()
            self.status = .stopped
            self.appendLog("[gateway] remote mode active; skipping local gateway\n")
            self.logger.info("gateway process skipped: remote mode active")
            return
        }
        if active, self.profilePortConflict != nil {
            // Background recovery cannot erase an ownership rejection and briefly
            // publish the rejected endpoint as ready before the next attach fails.
            guard source != .recovery else { return }
            self.profilePortConflict = nil
            Task { await GatewayEndpointStore.shared.setLocalUnavailableReason(nil) }
        }
        if active {
            do {
                _ = try GatewayEndpointStore.localEndpoint(
                    hostingBesideRemotePrimary: self.hostsLocalGatewayWithRemotePrimary)
            } catch {
                let conflict = error.localizedDescription
                if self.desiredActive { self.stop() }
                self.desiredActive = false
                self.recordProfilePortConflict(conflict)
                Task { await GatewayEndpointStore.shared.setLocalUnavailableReason(conflict) }
                return
            }
        }
        self.logger.debug("gateway active requested active=\(active)")
        self.desiredActive = active
        self.refreshEnvironmentStatus()
        if active {
            self.startIfNeeded()
        } else {
            self.stop()
        }
    }

    func ensureLaunchAgentEnabledIfNeeded() async -> Bool {
        guard self.gatewayHosting == .service else { return false }
        guard !CommandResolver.connectionModeIsRemote() || self.hostsLocalGatewayWithRemotePrimary else { return false }
        guard self.desiredActive else { return false }
        guard self.profilePortConflict == nil else { return false }
        if GatewayLaunchAgentManager.isLaunchAgentWriteDisabled() {
            self.appendLog("[gateway] launchd auto-enable skipped (attach-only)\n")
            self.logger.info("gateway launchd auto-enable skipped (disable marker set)")
            return false
        }
        let port = GatewayEnvironment.gatewayPort()
        let result = await self.enableLaunchAgentIfNeeded(
            port: port,
            generation: self.gatewayStartGeneration)
        if let err = result.error {
            self.appendLog("[gateway] launchd auto-enable failed: \(err)\n")
        }
        return result.installed
    }

    private func enableLaunchAgentIfNeeded(
        port: Int,
        generation expectedGeneration: UInt64? = nil,
        runtimeForUpdate: BundledRuntime? = nil) async -> LaunchAgentEnableResult
    {
        do { try self.loadRetainedServiceForResume() } catch {
            return .failed(error.localizedDescription)
        }
        let generation = expectedGeneration ?? self.gatewayStartGeneration
        await self.waitForPendingLaunchAgentDisable()
        guard generation == self.gatewayStartGeneration else { return .skipped }
        self.launchAgentEnableNextInvocationID &+= 1
        let invocationID = self.launchAgentEnableNextInvocationID
        let request = LaunchAgentEnableRequest(
            port: port,
            allowUnconfigured: self.hostsLocalGatewayWithRemotePrimary,
            generation: generation,
            runtimeForUpdate: runtimeForUpdate,
            invocationIDs: [invocationID])
        if let task = self.launchAgentEnableTask {
            if var current = self.launchAgentEnableCurrentRequest,
               current.hasSameConfiguration(as: request)
            {
                // The in-flight request already represents the newest configuration. Drop an
                // older queued change so A -> B -> A cannot finish on B.
                current.invocationIDs.append(invocationID)
                self.launchAgentEnableCurrentRequest = current
                self.launchAgentEnablePendingRequest = nil
            } else if var pending = self.launchAgentEnablePendingRequest,
                      pending.hasSameConfiguration(as: request)
            {
                pending.invocationIDs.append(invocationID)
                self.launchAgentEnablePendingRequest = pending
            } else {
                self.launchAgentEnablePendingRequest = request
            }
            let results = await task.value
            return results[invocationID] ?? .skipped
        }

        self.launchAgentEnablePendingRequest = request
        let task = Task { @MainActor in
            await self.drainLaunchAgentEnableRequests()
        }
        self.launchAgentEnableTask = task
        let results = await task.value
        return results[invocationID] ?? .skipped
    }

    private func waitForPendingLaunchAgentDisable() async {
        // A stop may already be uninstalling launchd. Wait until it finishes so a newer start's
        // attach/install is ordered last; loop because another stop can supersede it while waiting.
        while let disableTask = self.launchAgentDisableTask {
            #if DEBUG
            self.testingLaunchAgentDisableWaitHook?()
            #endif
            await disableTask.value
        }
    }

    private func drainLaunchAgentEnableRequests()
        async -> [UInt64: LaunchAgentEnableResult]
    {
        var results: [UInt64: LaunchAgentEnableResult] = [:]
        while let request = self.launchAgentEnablePendingRequest {
            self.launchAgentEnablePendingRequest = nil
            self.launchAgentEnableCurrentRequest = request
            let result = await self.performLaunchAgentEnable(request)
            let completedRequest = self.launchAgentEnableCurrentRequest ?? request
            for invocationID in completedRequest.invocationIDs {
                results[invocationID] = result
            }
            self.launchAgentEnableCurrentRequest = nil
        }
        // Clear the task before returning. A later caller then starts a fresh drain instead of
        // joining a completed task after the final pending-request check.
        self.launchAgentEnableTask = nil
        return results
    }

    private func performLaunchAgentEnable(_ request: LaunchAgentEnableRequest) async -> LaunchAgentEnableResult {
        if let runtime = request.runtimeForUpdate {
            guard self.isCurrentGatewayStart(request.generation) else { return .skipped }
            if let error = await GatewayLaunchAgentManager.reinstallBundledRuntime(
                runtime: runtime, port: request.port, allowUnconfigured: request.allowUnconfigured)
            {
                return .failed(error)
            }
            self.launchAgentInstallGeneration = request.generation
            self.launchAgentFreshInstallGeneration = request.generation
            return .installedService
        }
        // App startup and onboarding can request persistence together. One drain owns all installs;
        // a second forced install would kill the first Gateway during startup migrations.
        let launchAgent: GatewayLaunchAgentManager.LoadedGatewayState?
        do {
            launchAgent = try await GatewayLaunchAgentManager.loadedGatewayState(
                port: request.port,
                allowUnconfigured: request.allowUnconfigured)
        } catch {
            let reason = error.localizedDescription
            self.appendLog("[gateway] launchd inspection failed: \(reason); waiting for readiness\n")
            return .deferred(reason)
        }
        guard let launchAgent else {
            self.appendLog("[gateway] launchd status unavailable; deferring installation\n")
            return .skipped
        }
        // Pair one launchd snapshot with a current listener read. A PID that starts after the
        // status read cannot look reusable, so the ownership guard preserves it instead of forcing
        // an install; a reusable PID from this same snapshot receives its readiness cycle below.
        let listener = await PortGuardian.shared.describe(port: request.port)
        // Stop waits for the admitted install before disabling; it only discards queued requests.
        guard request.allowUnconfigured == self.hostsLocalGatewayWithRemotePrimary
        else { return .skipped }
        if let listener {
            guard listener.pid == launchAgent.runningPID else {
                // A healthy manually started Gateway may be attached without becoming app-owned.
                // Persistence checks and retained repair markers must not replace it.
                return .skipped
            }
        }

        var isReadinessRepair = false
        if let pid = launchAgent.reusablePID {
            let failure = LaunchAgentReadinessFailure(port: request.port, pid: pid)
            if self.launchAgentReadinessFailure != failure {
                // A new launchd PID may still be running migrations. It must fail one complete
                // readiness cycle before a later retry is allowed to replace it.
                self.setLaunchAgentReadinessState(
                    candidate: LaunchAgentReadinessCandidate(
                        failure: failure,
                        generation: request.generation),
                    failure: nil)
                return .skipped
            }

            isReadinessRepair = true
            self.appendLog(
                "[gateway] launchd pid \(pid) failed readiness on port \(request.port); repairing\n")
            self.logger.warning(
                "gateway launchd pid=\(pid) failed readiness on port=\(request.port); repairing")
        }
        self.setLaunchAgentReadinessState(candidate: nil, failure: nil)
        self.appendLog(
            "[gateway] enabling launchd job (\(gatewayLaunchdLabel)) on port \(request.port)\n")
        if let error = await GatewayLaunchAgentManager.set(
            enabled: true,
            port: request.port,
            allowUnconfigured: request.allowUnconfigured,
            whenMissingCLI: self.retainedServiceCLI)
        {
            return .failed(error)
        }
        // Keep replacement evidence until a healthy audit refreshes the control channel. Startup
        // and persistence calls coalesce, so the later caller may not receive `installed` itself.
        self.launchAgentInstallGeneration = request.generation
        self.launchAgentFreshInstallGeneration = isReadinessRepair ? nil : request.generation
        return .installedService
    }

    private func resolveLaunchAgentReadinessFailure(
        port: Int,
        startingPID: Int32?) async -> LaunchAgentReadinessFailure?
    {
        guard let startingPID,
              let pid = await self.reusableLaunchdPIDOwningPort(port: port),
              pid == startingPID
        else {
            return nil
        }
        return LaunchAgentReadinessFailure(port: port, pid: pid)
    }

    private func reusableLaunchdPIDOwningPort(port: Int) async -> Int32? {
        guard let pid = await GatewayLaunchAgentManager.reusableLoadedGatewayPID(
            port: port,
            allowUnconfigured: self.hostsLocalGatewayWithRemotePrimary)
        else {
            return nil
        }
        // A stable launchd PID that owns the port can still have a wedged health RPC. A listener
        // owned by anyone else is protected and surfaced through the attach path instead.
        if let listener = await PortGuardian.shared.describe(port: port), listener.pid != pid {
            return nil
        }
        return pid
    }

    private func setLaunchAgentReadinessState(
        candidate: LaunchAgentReadinessCandidate?,
        failure: LaunchAgentReadinessFailure?)
    {
        self.launchAgentReadinessCandidate = candidate
        self.launchAgentReadinessFailure = failure
        self.launchAgentReadinessRevision &+= 1
    }

    func startIfNeeded() {
        guard self.desiredActive, !self.isTerminating else { return }
        do { try self.loadRetainedServiceForResume() } catch {
            self.status = .failed(error.localizedDescription)
            self.lastFailureReason = error.localizedDescription
            return
        }
        guard !CommandResolver.connectionModeIsRemote() || self.hostsLocalGatewayWithRemotePrimary else {
            self.status = .stopped
            return
        }
        if BundledRuntime.isBundledApp,
           AppDefaults.standard.string(forKey: GatewayHosting.defaultsKey) == nil
        {
            AppDefaults.standard.set(self.gatewayHosting.rawValue, forKey: GatewayHosting.defaultsKey)
        }
        guard OpenClawConfigFile.migrateRetiredAppMetadataForGatewayStart() else {
            let message =
                "Could not repair retired macOS config metadata. Run `openclaw doctor --fix`, then retry."
            self.status = .failed(message)
            self.lastFailureReason = message
            self.appendLog("[gateway] \(message)\n")
            self.logger.error("gateway config metadata migration failed")
            return
        }
        // Many surfaces can call `setActive(true)` in quick succession (startup, Canvas, health checks).
        // Avoid concurrent startup tasks that can thrash launchd and flap the port.
        switch self.status {
        case .starting, .running, .attachedExisting:
            return
        case .stopped, .failed:
            break
        }
        self.status = .starting
        self.gatewayStartGeneration &+= 1
        let startGeneration = self.gatewayStartGeneration
        self.logger.debug("gateway start requested")

        // First try to attach to an already-running Gateway before enabling launchd.
        self.beginGatewayStartTask(generation: startGeneration) { [weak self] in
            guard let self else { return }
            if await self.attachExistingGatewayAfterPendingDisable(startGeneration: startGeneration) {
                return
            }
            if self.gatewayHosting == .app {
                await self.startAppHostedGateway(startGeneration: startGeneration)
            } else {
                await self.enableLaunchdGateway(startGeneration: startGeneration)
            }
        }
    }

    private func beginGatewayStartTask(
        generation: UInt64,
        operation: @escaping @MainActor @Sendable () async -> Void)
    {
        let taskID = UUID()
        self.gatewayStartTaskID = taskID
        self.gatewayStartTaskGeneration = generation
        self.gatewayStartTask = Task { @MainActor [weak self] in
            guard let self else { return }
            defer {
                if self.gatewayStartTaskID == taskID {
                    self.gatewayStartTask = nil
                    self.gatewayStartTaskGeneration = nil
                    self.gatewayStartTaskID = nil
                }
            }
            await operation()
        }
    }

    func waitForStartupAttempt() async {
        // Persistence/repair follows the complete attach-or-start decision. This prevents the
        // automatic ensure path from replacing a PID while startup is accepting that same PID.
        while let task = self.gatewayStartTask {
            await task.value
        }
        await self.waitForPendingLaunchAgentDisable()
    }

    func stop() {
        do { try self.initializeGatewayHosting() } catch {
            self.lastFailureReason = error.localizedDescription
            self.status = .failed(error.localizedDescription)
            return
        }
        let hosting = self.gatewayHosting
        self.gatewayStartGeneration &+= 1
        let stopGeneration = self.gatewayStartGeneration
        self.desiredActive = false
        self.existingGatewayDetails = nil
        self.lastFailureReason = nil
        self.setLaunchAgentReadinessState(candidate: nil, failure: nil)
        self.launchAgentInstallGeneration = nil
        self.launchAgentFreshInstallGeneration = nil
        // Queued work belongs to the previous lifecycle. The active enable cannot be cancelled
        // safely, so the disable waits for its drain and wins unless a newer start supersedes it.
        self.launchAgentEnablePendingRequest = nil
        let enableTask = self.launchAgentEnableTask
        self.status = .stopped
        self.logger.info("gateway stop requested")
        let priorDisableTask = self.launchAgentDisableTask
        let disableTask = Task { @MainActor in
            _ = await priorDisableTask?.value
            _ = await enableTask?.value
            defer {
                if self.launchAgentDisableGeneration == stopGeneration {
                    self.launchAgentDisableTask = nil
                    self.launchAgentDisableGeneration = nil
                }
            }
            guard self.launchAgentDisableGeneration == stopGeneration else { return }
            // A service can be installed while our child still runs. Pause owns both teardowns.
            await self.childSupervisor.stop()
            guard hosting == .service, self.launchAgentDisableGeneration == stopGeneration else { return }
            do {
                // A published paused installation has no plist or resume record. Keep
                // its always-on intent without probing, capturing credentials, or uninstalling.
                if try self.shouldDeferLegacyServiceWhilePaused() { return }
                if self.installation == .external { return }
                let custody = try await self.retainManagedServiceForResume()
                if self.launchAgentDisableGeneration == stopGeneration {
                    let error = await GatewayLaunchAgentManager.set(
                        enabled: false, port: GatewayEnvironment.gatewayPort(), expectedServiceAuthority: custody)
                    if let error { throw GatewayHostingError(message: error) }
                }
            } catch {
                if self.launchAgentDisableGeneration == stopGeneration {
                    self.lastFailureReason = error.localizedDescription
                    self.status = .failed(error.localizedDescription)
                }
            }
        }
        self.launchAgentDisableGeneration = stopGeneration
        self.launchAgentDisableTask = disableTask
    }

    func clearLastFailure() {
        self.lastFailureReason = nil
    }

    func refreshEnvironmentStatus(force: Bool = false) {
        let now = Date()
        if !force {
            if self.environmentRefreshTask != nil { return }
            if let last = self.lastEnvironmentRefresh,
               now.timeIntervalSince(last) < self.environmentRefreshMinInterval
            {
                return
            }
        }
        self.lastEnvironmentRefresh = now
        self.environmentRefreshTask = Task { [weak self] in
            let status = await GatewayEnvironment.check()
            await MainActor.run {
                guard let self else { return }
                self.environmentStatus = status
                self.environmentRefreshTask = nil
            }
        }
    }

    func refreshLog() {
        guard self.logRefreshTask == nil else { return }
        let path = GatewayLaunchAgentManager.launchdGatewayLogPath()
        let limit = self.logLimit
        self.logRefreshTask = Task { [weak self] in
            let log = await Task.detached(priority: .utility) {
                Self.readGatewayLog(path: path, limit: limit)
            }.value
            await MainActor.run {
                guard let self else { return }
                if !log.isEmpty {
                    self.log = log
                }
                self.logRefreshTask = nil
            }
        }
    }

    // MARK: - Internals

    private func isCurrentGatewayStart(_ generation: UInt64) -> Bool {
        !self.isTerminating && self.desiredActive && self.gatewayStartGeneration == generation
    }

    private func isCurrentGatewayReadiness(_ context: GatewayReadinessContext) -> Bool {
        if case .child = context.purpose,
           self.childSupervisor.processIdentifier != context.readinessPID
        { return false }
        return !Task.isCancelled &&
            self.isCurrentGatewayStart(context.generation) &&
            self.launchAgentReadinessRevision == context.readinessRevision &&
            self.launchAgentReadinessCandidate == context.readinessCandidate
    }

    private func attachExistingGatewayAfterPendingDisable(
        port requestedPort: Int? = nil,
        startGeneration: UInt64) async -> Bool
    {
        // A gateway that is still reachable during uninstall is not reusable. Let the stop finish
        // before attachment so the new lifecycle cannot latch onto a process launchd then removes.
        await self.waitForPendingLaunchAgentDisable()
        guard self.isCurrentGatewayStart(startGeneration) else { return true }
        return await self.attachExistingGatewayIfAvailable(
            port: requestedPort,
            startGeneration: startGeneration)
    }

    /// Attempt to connect to an already-running gateway on the configured port.
    /// If successful, mark status as attached and skip launchd startup.
    private func attachExistingGatewayIfAvailable(
        port requestedPort: Int? = nil,
        startGeneration: UInt64) async -> Bool
    {
        let port = requestedPort ?? GatewayEnvironment.gatewayPort()
        let instance = await PortGuardian.shared.describe(port: port)
        guard self.isCurrentGatewayStart(startGeneration) else { return true }
        let hasListener = instance != nil
        if hasListener,
           await !(self.profileOwnsGateway(
               instance,
               port: port,
               startGeneration: startGeneration))
        {
            return true
        }

        let context = self.gatewayReadinessContext(
            purpose: .attach,
            port: port,
            generation: startGeneration,
            readinessPID: instance?.pid)
        let terminal = await self.observeGatewayReadiness(
            context: context,
            deadlinePolicy: .fixed(timeout: hasListener ? 6.5 : 2),
            clock: self.readinessClock)
        if !hasListener, case .failed = terminal {
            guard self.isCurrentGatewayReadiness(context) else { return true }
            self.existingGatewayDetails = nil
            self.gatewayOwnership = nil
            return false
        }
        let published = await self.publishGatewayReadinessTerminal(terminal, context: context)
        return hasListener || published || !self.isCurrentGatewayStart(startGeneration)
    }

    private func profileOwnsGateway(
        _ instance: PortGuardian.Descriptor?,
        port: Int,
        startGeneration: UInt64) async -> Bool
    {
        if let pid = self.childSupervisor.processIdentifier, instance?.pid == pid {
            return self.isCurrentGatewayStart(startGeneration)
        }
        guard AppProfile.current.isActive else { return true }
        let managedPID = await GatewayLaunchAgentManager.runningGatewayPID()
        guard self.isCurrentGatewayStart(startGeneration) else { return false }
        guard Self.profileAllowsExistingGatewayAttachment(
            profile: .current,
            listenerPID: instance?.pid,
            managedServicePID: managedPID)
        else {
            await self.failProfilePortOwnership(
                port: port,
                startGeneration: startGeneration)
            return false
        }
        return true
    }

    private func failProfilePortOwnership(port: Int, startGeneration: UInt64) async {
        guard self.isCurrentGatewayStart(startGeneration) else { return }
        let message = "Gateway port \(port) is already owned by another process or OpenClaw profile. " +
            "Set gateway.port to a free port for profile \(AppProfile.current.name ?? "named")."
        self.recordProfilePortConflict(message)
        await GatewayEndpointStore.shared.setLocalUnavailableReason(message)
    }

    private func recordProfilePortConflict(_ message: String) {
        self.profilePortConflict = message
        self.status = .failed(message)
        self.lastFailureReason = message
        self.appendLog("[gateway] \(message)\n")
        self.logger.error("\(message, privacy: .public)")
    }

    private func describe(details instance: String?, port: Int, snap: HealthSnapshot?) -> String {
        let instanceText = instance ?? "pid unknown"
        if let snap {
            let order = snap.channelOrder ?? Array(snap.channels.keys)
            let linkId = order.first(where: { snap.channels[$0]?.linked == true })
                ?? order.first(where: { snap.channels[$0]?.linked != nil })
            guard let linkId else {
                return "port \(port), health probe succeeded, \(instanceText)"
            }
            let linked = snap.channels[linkId]?.linked ?? false
            let authAge = snap.channels[linkId]?.authAgeMs.flatMap(msToAge) ?? "unknown age"
            let label =
                snap.channelLabels?[linkId] ??
                linkId.capitalized
            let linkText = linked ? "linked" : "not linked"
            return "port \(port), \(label) \(linkText), auth \(authAge), \(instanceText)"
        }
        return "port \(port), health probe succeeded, \(instanceText)"
    }

    private func describe(instance: PortGuardian.Descriptor) -> String {
        let path = instance.executablePath ?? "path unknown"
        return "pid \(instance.pid) \(instance.command) @ \(path)"
    }

    private func describeAttachFailure(_ error: Error, port: Int, instance: PortGuardian.Descriptor?) -> String {
        if let issue = GatewayCompatibilityIssue(error: error) {
            return issue.message
        }
        let ns = error as NSError
        let message = ns.localizedDescription.isEmpty ? "unknown error" : ns.localizedDescription
        let lower = message.lowercased()
        if self.isGatewayTokenAuthFailure(error) {
            return """
            Gateway on port \(port) rejected auth. Set gateway.auth.token to match the running gateway \
            (or clear it on the gateway) and retry.
            """
        }
        if lower.contains("unexpected response") || lower.contains("invalid response") {
            return "Port \(port) returned non-gateway data; another process is using it."
        }
        if let instance {
            let instanceText = self.describe(instance: instance)
            return "Gateway listener found on port \(port) (\(instanceText)) but health check failed: \(message)"
        }
        return "Gateway listener found on port \(port) but health check failed: \(message)"
    }

    private func isGatewayTokenAuthFailure(_ error: Error) -> Bool {
        guard let detail = (error as? GatewayConnectAuthError)?.detail else { return false }
        return detail == .authTokenMissing ||
            detail == .authTokenMismatch ||
            detail == .authTokenNotConfigured
    }
}

extension GatewayProcessManager {
    private func gatewayReadinessContext(
        purpose: GatewayReadinessPurpose,
        port: Int,
        generation: UInt64,
        readinessPID: Int32? = nil,
        launchAgentInstalled: Bool = false,
        inspectionFailure: String? = nil) -> GatewayReadinessContext
    {
        GatewayReadinessContext(
            purpose: purpose,
            port: port,
            generation: generation,
            readinessPID: readinessPID,
            readinessRevision: self.launchAgentReadinessRevision,
            readinessCandidate: self.launchAgentReadinessCandidate,
            readinessFailure: self.launchAgentReadinessFailure,
            endpointPIDBeforeProbe: self.lastObservedGatewayPID,
            launchAgentInstalled: launchAgentInstalled,
            inspectionFailure: inspectionFailure)
    }

    private func prepareLaunchdGatewayStart(startGeneration: UInt64) async -> GatewayReadinessContext? {
        guard self.isCurrentGatewayStart(startGeneration) else { return nil }
        self.existingGatewayDetails = nil
        if GatewayLaunchAgentManager.isLaunchAgentWriteDisabled() {
            let message = "Launchd disabled; start the Gateway manually or disable attach-only."
            self.status = .failed(message)
            self.lastFailureReason = "launchd disabled"
            self.appendLog("[gateway] launchd disabled; skipping auto-start\n")
            self.logger.info("gateway launchd enable skipped (disable marker set)")
            return nil
        }

        let port = GatewayEnvironment.gatewayPort()
        self.logger.info("gateway ensuring launchd port=\(port)")
        let enableResult = await self.enableLaunchAgentIfNeeded(
            port: port,
            generation: startGeneration)
        guard self.isCurrentGatewayStart(startGeneration) else { return nil }
        if let err = enableResult.error {
            self.status = .failed(err)
            self.lastFailureReason = err
            self.logger.error("gateway launchd enable failed: \(err)")
            return nil
        }

        let readinessPID = await GatewayLaunchAgentManager.reusableLoadedGatewayPID(
            port: port,
            allowUnconfigured: self.hostsLocalGatewayWithRemotePrimary)
        guard self.isCurrentGatewayStart(startGeneration) else { return nil }
        return self.gatewayReadinessContext(
            purpose: .launchd,
            port: port,
            generation: startGeneration,
            readinessPID: readinessPID,
            launchAgentInstalled: enableResult.installed,
            inspectionFailure: enableResult.inspectionFailure)
    }

    private func enableLaunchdGateway(startGeneration: UInt64) async {
        guard let context = await self.prepareLaunchdGatewayStart(startGeneration: startGeneration) else {
            return
        }
        await self.observeLaunchdGatewayReadiness(context: context)
    }

    private func observeLaunchdGatewayReadiness(
        context: GatewayReadinessContext,
        readinessWindow: TimeInterval = 6,
        // Fresh installs keep probing through the same first-run migration budget as the CLI.
        firstInstallReadinessBudget: TimeInterval = GatewayLaunchAgentManager.startupMigrationTolerance) async
    {
        let terminal = await self.observeGatewayReadiness(
            context: context,
            deadlinePolicy: .migration(
                window: readinessWindow,
                tolerance: firstInstallReadinessBudget),
            clock: self.readinessClock)
        _ = await self.publishGatewayReadinessTerminal(terminal, context: context)
    }

    private func observeGatewayReadiness<C: Clock>(
        context: GatewayReadinessContext,
        deadlinePolicy: GatewayReadinessDeadlinePolicy,
        clock: C) async -> GatewayReadinessTerminal where C.Duration == Duration
    {
        let startedAt = clock.now
        let initialWindow: TimeInterval
        let finalProbeDeadline: C.Instant
        switch deadlinePolicy {
        case let .migration(window, tolerance):
            initialWindow = window
            finalProbeDeadline = startedAt.advanced(by: .seconds(max(window, tolerance)))
        case let .fixed(timeout):
            initialWindow = timeout
            finalProbeDeadline = startedAt.advanced(by: .seconds(timeout))
        }
        var deadline = startedAt.advanced(by: .seconds(initialWindow))
        var latestRetryDisposition: GatewayProbeFailureDisposition?
        var readinessPID = context.readinessPID
        var freshInstallGraceAuthorized = false
        var responsiveStartupProgressObserved = false
        var latestProbeError: Error?
        readinessLoop: while true {
            guard self.isCurrentGatewayReadiness(context) else { return .superseded }
            while clock.now >= deadline {
                guard let extensionDecision = deadlinePolicy.extensionDecision(
                    deadline: deadline,
                    finalProbeDeadline: finalProbeDeadline,
                    responsiveStartupProgressObserved: responsiveStartupProgressObserved,
                    freshInstallGraceAuthorized: freshInstallGraceAuthorized)
                else { break readinessLoop }
                let extensionAuthorization = await self.authorizeReadinessExtension(
                    context: context,
                    requiresLaunchdProof: extensionDecision.requiresLaunchdProof,
                    readinessPID: readinessPID)
                guard self.isCurrentGatewayReadiness(context) else { return .superseded }
                guard extensionAuthorization.allowed else { break readinessLoop }
                readinessPID = extensionAuthorization.readinessPID
                freshInstallGraceAuthorized = true
                deadline = extensionDecision.deadline
                guard clock.now < finalProbeDeadline else { break readinessLoop }
            }
            do {
                let remaining = clock.now.duration(to: deadline).components
                let remainingMs = max(1, Double(remaining.seconds) * 1000 + Double(remaining.attoseconds) / 1e15)
                let data = try await self.probeGatewayHealth(timeoutMs: min(1500, remainingMs), clock: clock)
                guard self.isCurrentGatewayReadiness(context) else { return .superseded }
                let instance = await PortGuardian.shared.describe(port: context.port)
                guard self.isCurrentGatewayReadiness(context) else { return .superseded }
                return .ready(
                    instance: instance,
                    startingPID: readinessPID,
                    snapshot: decodeHealthSnapshot(from: data))
            } catch {
                guard self.isCurrentGatewayReadiness(context) else { return .superseded }
                latestProbeError = error
                switch self.probeFailureDisposition(error) {
                case .fail:
                    return await self.gatewayProbeFailureTerminal(error, context: context)
                case .retryWithRepair:
                    latestRetryDisposition = .retryWithRepair
                case .retryWithoutRepair:
                    // A responsive transient invalidates older connection-failure evidence.
                    latestRetryDisposition = .retryWithoutRepair
                    if self.probeFailureShowsStartupProgress(error) {
                        responsiveStartupProgressObserved = true
                    }
                }
                let retryDelay = min(.milliseconds(300), max(.zero, clock.now.duration(to: deadline)))
                if retryDelay > .zero {
                    try? await clock.sleep(until: clock.now.advanced(by: retryDelay), tolerance: nil)
                }
            }
        }

        return await self.gatewayReadinessTimeout(
            context: context,
            policy: deadlinePolicy,
            latestDisposition: latestRetryDisposition,
            latestError: latestProbeError,
            responsiveStartupProgressObserved: responsiveStartupProgressObserved,
            readinessPID: readinessPID)
    }

    private func gatewayReadinessTimeout(
        context: GatewayReadinessContext,
        policy: GatewayReadinessDeadlinePolicy,
        latestDisposition: GatewayProbeFailureDisposition?,
        latestError: Error?,
        responsiveStartupProgressObserved: Bool,
        readinessPID: Int32?) async -> GatewayReadinessTerminal
    {
        guard self.isCurrentGatewayReadiness(context) else { return .superseded }
        if case .attach = context.purpose, let latestError {
            return await self.gatewayProbeFailureTerminal(latestError, context: context)
        }
        let migration = if case .migration = policy {
            true
        } else {
            false
        }
        let fallbackFailure = if responsiveStartupProgressObserved {
            GatewayReadinessFailure.deadlineWithoutRepairEvidence
        } else {
            context.inspectionFailure.map(GatewayReadinessFailure.serviceInspection)
                ?? .deadlineWithoutRepairEvidence
        }
        guard latestDisposition == .retryWithRepair else {
            return migration ? .failed(fallbackFailure) : .superseded
        }
        let failure: LaunchAgentReadinessFailure? = if migration || context.readinessCandidate != nil {
            await self.resolveLaunchAgentReadinessFailure(
                port: context.port,
                startingPID: readinessPID)
        } else {
            context.readinessFailure
        }
        guard self.isCurrentGatewayReadiness(context) else { return .superseded }
        guard let failure else {
            return migration ? .failed(fallbackFailure) : .superseded
        }
        return .failed(.timeoutWithRepairEvidence(failure))
    }

    private func gatewayProbeFailureTerminal(
        _ error: Error,
        context: GatewayReadinessContext) async -> GatewayReadinessTerminal
    {
        let instance = await PortGuardian.shared.describe(port: context.port)
        guard self.isCurrentGatewayReadiness(context) else { return .superseded }
        let reason = self.describeAttachFailure(error, port: context.port, instance: instance)
        if case .attach = context.purpose { return .failed(.attachProbe(reason)) }
        return .failed(.responsiveProbe(reason))
    }

    private func authorizeReadinessExtension(
        context: GatewayReadinessContext,
        requiresLaunchdProof: Bool,
        readinessPID: Int32?) async -> (allowed: Bool, readinessPID: Int32?)
    {
        if case .child = context.purpose {
            return (
                self.isCurrentGatewayReadiness(context) &&
                    self.childSupervisor.processIdentifier == readinessPID,
                readinessPID)
        }
        if !requiresLaunchdProof {
            return (self.isCurrentGatewayReadiness(context), readinessPID)
        }
        guard self.launchAgentFreshInstallGeneration == context.generation,
              self.isCurrentGatewayReadiness(context)
        else { return (false, nil) }
        guard let reusablePID = await self.reusableLaunchdPIDOwningPort(port: context.port) else {
            return (false, nil)
        }
        let allowed = self.launchAgentFreshInstallGeneration == context.generation &&
            self.isCurrentGatewayReadiness(context)
        return (allowed, allowed ? reusablePID : nil)
    }

    private func probeFailureDisposition(_ error: Error) -> GatewayProbeFailureDisposition {
        if self.probeFailureIsCancellation(error) { return .retryWithoutRepair }
        if self.probeFailureShowsStartupProgress(error) { return .retryWithoutRepair }
        if error is GatewayHealthProbeTimeout { return .retryWithRepair }
        let nsError = error as NSError
        guard nsError.domain == NSURLErrorDomain else { return .fail }
        switch URLError.Code(rawValue: nsError.code) {
        case .timedOut,
             .cannotFindHost,
             .cannotConnectToHost,
             .networkConnectionLost,
             .dnsLookupFailed,
             .notConnectedToInternet,
             .resourceUnavailable:
            return .retryWithRepair
        default:
            return .fail
        }
    }

    private func probeFailureShowsStartupProgress(_ error: Error) -> Bool {
        guard let response = error as? GatewayResponseError else { return false }
        return response.code.uppercased() == "UNAVAILABLE"
    }

    private func probeFailureIsCancellation(_ error: Error) -> Bool {
        if error is CancellationError { return true }
        let nsError = error as NSError
        return nsError.domain == NSURLErrorDomain &&
            nsError.code == URLError.cancelled.rawValue
    }

    private static func gatewayPIDChanged(from previousPID: Int32?, to observedPID: Int32?) -> Bool {
        guard let previousPID, let observedPID else { return false }
        return previousPID != observedPID
    }

    private func appendLog(_ chunk: String) {
        self.log.append(chunk)
        if self.log.count > self.logLimit {
            self.log = String(self.log.suffix(self.logLimit))
        }
    }

    private func refreshControlChannelIfNeeded(reason: String, force: Bool = false) {
        guard !CommandResolver.connectionModeIsRemote() else { return }
        #if DEBUG
        self.testingControlChannelRefreshForces.append(force)
        if self.testingSkipControlChannelRefresh {
            return
        }
        #endif
        if !force {
            switch ControlChannel.shared.state {
            case .connected, .connecting:
                return
            case .disconnected, .degraded:
                break
            }
        }
        self.appendLog("[gateway] refreshing control channel (\(reason))\n")
        self.logger.debug("gateway control channel refresh reason=\(reason)")
        Task { await ControlChannel.shared.configure() }
    }

    func waitForGatewayReady(
        timeout: TimeInterval = 6,
        launchAgentInstalled: Bool = false) async -> Bool
    {
        let startGeneration = self.gatewayStartGeneration
        if await self.observeCurrentGatewayStart(generation: startGeneration) == true { return true }
        guard !Task.isCancelled, self.isCurrentGatewayStart(startGeneration) else { return false }
        // Only a real launch candidate/install can recover after its owner reports failure.
        if case .failed = self.status,
           !launchAgentInstalled,
           self.launchAgentReadinessCandidate == nil,
           self.launchAgentReadinessFailure == nil,
           self.launchAgentInstallGeneration != startGeneration
        {
            return false
        }
        let readinessPort = self.launchAgentReadinessCandidate?.failure.port
            ?? GatewayEnvironment.gatewayPort()
        let context = self.gatewayReadinessContext(
            purpose: .audit,
            port: readinessPort,
            generation: startGeneration,
            readinessPID: self.launchAgentReadinessCandidate?.failure.pid,
            launchAgentInstalled: launchAgentInstalled)
        let terminal = await self.observeGatewayReadiness(
            context: context,
            deadlinePolicy: .fixed(timeout: timeout),
            clock: self.readinessClock)
        return await self.publishGatewayReadinessTerminal(terminal, context: context)
    }

    private func observeCurrentGatewayStart(generation: UInt64) async -> Bool? {
        guard self.gatewayStartTaskGeneration == generation else { return nil }
        while self.gatewayStartTaskGeneration == generation {
            // Cancellation interrupts the sleep, so a waiter can leave without touching the owner.
            try? await Task.sleep(nanoseconds: 100_000_000)
            guard !Task.isCancelled, self.isCurrentGatewayStart(generation) else { return false }
        }
        guard !Task.isCancelled, self.isCurrentGatewayStart(generation) else { return false }
        return switch self.status {
        case .running, .attachedExisting: true
        case .stopped, .starting, .failed: false
        }
    }

    private func publishGatewayReadinessTerminal(
        _ terminal: GatewayReadinessTerminal,
        context: GatewayReadinessContext) async -> Bool
    {
        // Fixed audits without fresh endpoint evidence return `.superseded`, so a terminal failure
        // from this generation is replaced only by a later result carrying endpoint evidence.
        switch terminal {
        case let .ready(instance, startingPID, snapshot):
            guard await self.canPublishGatewayReadiness(instance: instance, context: context) else {
                return false
            }
            let installed = context.launchAgentInstalled || self.launchAgentInstallGeneration == context.generation
            let replaced = installed ||
                Self.gatewayPIDChanged(from: context.endpointPIDBeforeProbe, to: instance?.pid) ||
                Self.gatewayPIDChanged(from: startingPID, to: instance?.pid)
            let details: String?
            let refreshReason: String
            switch context.purpose {
            case .attach:
                details = self.describe(
                    details: instance.map { self.describe(instance: $0) },
                    port: context.port,
                    snap: snapshot)
                refreshReason = "attach existing"
            case .launchd, .child, .audit:
                details = instance.map { "pid \($0.pid)" }
                refreshReason = "gateway readiness recovered"
            }
            self.setLaunchAgentReadinessState(candidate: nil, failure: nil)
            self.clearLastFailure()
            // Only installation evidence replaces a remembered owner. A readiness path
            // may reuse an independent listener, so its purpose does not establish ownership.
            if installed {
                self.gatewayOwnership = nil
            }
            let ownedChild = instance?.pid != nil && instance?.pid == self.childSupervisor.processIdentifier
            self.gatewayOwnership = (
                context.port,
                ownedChild ? .managed : self.installation(
                    for: context.port, whenMissing: installed ? .managed : .external))
            if case .attach = context.purpose {
                self.existingGatewayDetails = details
                self.status = .attachedExisting(details: details)
                self.appendLog("[gateway] using existing instance: \(details ?? "unknown")\n")
            } else if case .attachedExisting = self.status, !replaced {
                self.status = .attachedExisting(details: details)
            } else {
                self.status = .running(details: details)
            }
            // A replaced process can leave the old socket briefly marked connected. Routine audits
            // retain the connected channel; only replacement evidence forces refresh.
            self.refreshControlChannelIfNeeded(reason: refreshReason, force: replaced)
            self.lastObservedGatewayPID = instance?.pid ?? self.lastObservedGatewayPID
            if self.launchAgentInstallGeneration == context.generation {
                self.launchAgentInstallGeneration = nil
            }
            if self.launchAgentFreshInstallGeneration == context.generation {
                self.launchAgentFreshInstallGeneration = nil
            }
            self.refreshLog()
            self.markChildHealthy(instance: instance)
            return true

        case let .failed(terminalFailure):
            let instance = await PortGuardian.shared.describe(port: context.port)
            // Ownership only matters when something is listening. With no listener, a named
            // profile's startup failure is its own; reporting a port conflict would hide it.
            let publishable = if instance == nil {
                self.isCurrentGatewayReadiness(context)
            } else {
                await self.canPublishGatewayReadiness(instance: instance, context: context)
            }
            guard publishable else {
                return false
            }
            let retainedFailure: LaunchAgentReadinessFailure? = if case let .timeoutWithRepairEvidence(failure) =
                terminalFailure
            {
                failure
            } else {
                nil
            }
            self.setLaunchAgentReadinessState(candidate: nil, failure: retainedFailure)
            self.status = .failed(terminalFailure.reason)
            switch terminalFailure {
            case .attachProbe:
                self.lastFailureReason = terminalFailure.reason
                self.appendLog("[gateway] existing listener attach failed: \(terminalFailure.reason)\n")
            case .responsiveProbe:
                self.lastFailureReason = terminalFailure.reason
                self.appendLog("[gateway] responsive health probe failed: \(terminalFailure.reason)\n")
            case .serviceInspection:
                self.lastFailureReason = terminalFailure.reason
                self.appendLog("[gateway] service inspection failed: \(terminalFailure.reason)\n")
            case .timeoutWithRepairEvidence:
                self.lastFailureReason = if case .launchd = context.purpose {
                    "launchd start timeout"
                } else {
                    "gateway readiness timeout"
                }
            case .deadlineWithoutRepairEvidence:
                // Transient responsive/cancellation outcomes never retain a PID for repair.
                self.lastFailureReason = "gateway readiness deadline elapsed"
            }
            self.logger.warning("gateway readiness failed reason=\(terminalFailure.reason)")
            return false

        case .superseded:
            return false
        }
    }

    private func canPublishGatewayReadiness(
        instance: PortGuardian.Descriptor?,
        context: GatewayReadinessContext) async -> Bool
    {
        guard self.isCurrentGatewayReadiness(context) else { return false }
        if case .child = context.purpose, instance?.pid != context.readinessPID { return false }
        guard await self.profileOwnsGateway(
            instance,
            port: context.port,
            startGeneration: context.generation)
        else { return false }
        return self.isCurrentGatewayReadiness(context)
    }

    private func markChildHealthy(instance: PortGuardian.Descriptor?) {
        if let pid = instance?.pid { self.childSupervisor.markHealthy(pid: pid) }
    }

    private func probeGatewayHealth<C: Clock>(timeoutMs: Double, clock: C) async throws -> Data
        where C.Duration == Duration
    {
        let connection = await self.connection
        // Startup owns recovery and its monotonic deadline. A normal request can recursively
        // start the Gateway and spend several 30-second connect retries before its RPC timer begins.
        // Disable the inner RPC timer so it cannot race the owner's typed probe timeout.
        return try await AsyncTimeout.withTimeout(
            seconds: max(0.001, timeoutMs / 1000),
            clock: clock,
            onTimeout: { GatewayHealthProbeTimeout(timeoutMs: timeoutMs) },
            operation: {
                try await connection.request(
                    method: GatewayConnection.Method.health.rawValue,
                    params: nil,
                    timeoutMs: 0,
                    retryTransportFailures: false)
            })
    }

    func clearLog() {
        self.log = ""
        try? FileManager().removeItem(atPath: GatewayLaunchAgentManager.launchdGatewayLogPath())
        self.logger.debug("gateway log cleared")
    }

    private nonisolated static func readGatewayLog(path: String, limit: Int) -> String {
        guard FileManager().fileExists(atPath: path) else { return "" }
        guard let data = try? Data(contentsOf: URL(fileURLWithPath: path)) else { return "" }
        let text = String(data: data, encoding: .utf8) ?? ""
        if text.count <= limit { return text }
        return String(text.suffix(limit))
    }
}

extension GatewayProcessManager {
    private func startAppHostedGateway(startGeneration: UInt64) async {
        guard self.isCurrentGatewayStart(startGeneration) else { return }
        guard self.installation == .managed else {
            let reason = self.installation == .unreadable
                ? Installation.ownershipFailure
                : "This Gateway is externally managed. Start it with its installation owner."
            self.status = .failed(reason)
            self.lastFailureReason = reason
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
            var environment = ProcessInfo.processInfo.environment
            environment.merge(runtime.environment) { _, runtimeValue in runtimeValue }
            environment["PATH"] = ([runtime.bun.deletingLastPathComponent().path] +
                CommandResolver.preferredPaths()).joined(separator: ":")
            environment["OPENCLAW_PROFILE"] = AppProfile.current.name ?? "default"
            // The selected profile owns state even when the app was opened from an operator shell.
            environment["OPENCLAW_STATE_DIR"] = AppProfile.current.stateDirectoryURL().path
            environment["OPENCLAW_CONFIG_PATH"] = AppProfile.current.stateDirectoryURL()
                .appendingPathComponent("openclaw.json").path
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
            self.status = .failed(error.localizedDescription)
            self.lastFailureReason = error.localizedDescription
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
            self.desiredActive = false
            self.status = .failed(reason)
            self.lastFailureReason = reason
            self.appendLog("[gateway] \(reason)\n")
        }
    }

    private func observeChildReadiness(pid: Int32, port: Int, generation: UInt64) async {
        let context = self.gatewayReadinessContext(
            purpose: .child, port: port, generation: generation, readinessPID: pid)
        let terminal = await self.observeGatewayReadiness(
            context: context,
            deadlinePolicy: .migration(window: 6, tolerance: GatewayLaunchAgentManager.startupMigrationTolerance),
            clock: self.readinessClock)
        if await self.publishGatewayReadinessTerminal(terminal, context: context) {
            do { try await BundledRuntime.garbageCollectAfterHealthy() } catch {
                self.appendLog("[gateway] old runtime cleanup deferred: \(error.localizedDescription)\n")
            }
        }
    }

    func shutdownAppHostedGateway() async {
        self.isTerminating = true
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

    func prepareBundledRuntimeAfterUpdate() async throws {
        guard !self.isTerminating else { throw CancellationError() }
        if let task = self.bundledUpdateTask { return try await task.value }
        let task = Task { @MainActor in try await self.performBundledRuntimeUpdate() }
        self.bundledUpdateTask = task
        defer { self.bundledUpdateTask = nil }
        try await task.value
    }

    private func performBundledRuntimeUpdate() async throws {
        let updateGeneration = self.gatewayStartGeneration
        await self.waitForStartupAttempt()
        guard !self.isTerminating, !Task.isCancelled,
              self.gatewayStartGeneration == updateGeneration else { throw CancellationError() }
        try self.loadRetainedServiceForResume()
        guard self.usesSeededGateway else { return }
        let pausedUpdate = AppStateStore.shared.isPaused ? try self.preparePausedServiceUpdate() : nil
        let runtime = try await BundledRuntime.seed()
        guard !self.isTerminating, !Task.isCancelled,
              self.gatewayStartGeneration == updateGeneration else { throw CancellationError() }
        if AppStateStore.shared.isPaused {
            try await self.completePausedServiceUpdate(pausedUpdate, runtime: runtime) {
                guard !self.isTerminating, !Task.isCancelled,
                      self.gatewayStartGeneration == updateGeneration, AppStateStore.shared.isPaused
                else { throw CancellationError() }
            }
            return
        }
        if self.gatewayHosting == .app {
            self.stop()
            let stopGeneration = self.gatewayStartGeneration
            await self.waitForPendingLaunchAgentDisable()
            guard !self.isTerminating, !Task.isCancelled,
                  self.gatewayStartGeneration == stopGeneration else { throw CancellationError() }
            if AppStateStore.shared.isPaused { return }
            self.setActive(true)
        } else {
            self.desiredActive = true
            self.gatewayStartGeneration &+= 1
            let generation = self.gatewayStartGeneration
            self.status = .starting
            let result = await self.enableLaunchAgentIfNeeded(
                port: GatewayEnvironment.gatewayPort(), generation: generation, runtimeForUpdate: runtime)
            guard self.isCurrentGatewayStart(generation) else { throw CancellationError() }
            if let error = result.error {
                self.status = .failed(error)
                self.lastFailureReason = error
                throw GatewayHostingError(message: error)
            }
        }
        guard await self.waitForGatewayReady(timeout: GatewayLaunchAgentManager.startupMigrationTolerance) else {
            throw GatewayHostingError(message: self.lastFailureReason ?? "The updated Gateway did not become ready.")
        }
        do { try await BundledRuntime.garbageCollectAfterHealthy() } catch {
            self.appendLog("[gateway] old runtime cleanup deferred: \(error.localizedDescription)\n")
        }
    }
}

#if DEBUG
extension GatewayProcessManager {
    func _testSetLaunchAgentDisableWaitHook(_ hook: (() -> Void)?) {
        self.testingLaunchAgentDisableWaitHook = hook
    }

    func setTestingConnection(_ connection: GatewayConnection?) {
        self.testingConnection = connection
    }

    func setTestingSkipControlChannelRefresh(_ skip: Bool) {
        self.testingSkipControlChannelRefresh = skip
    }

    func _testControlChannelRefreshForces() -> [Bool] {
        self.testingControlChannelRefreshForces
    }

    func _testClearControlChannelRefreshForces() {
        self.testingControlChannelRefreshForces.removeAll(keepingCapacity: true)
    }

    func _testClearLaunchAgentInstallEvidence() {
        self.launchAgentInstallGeneration = nil
        self.launchAgentFreshInstallGeneration = nil
    }

    func _testHasLaunchAgentFreshInstallEvidence() -> Bool {
        self.launchAgentFreshInstallGeneration != nil
    }

    func _testSetLastObservedGatewayPID(_ pid: Int32?) {
        self.lastObservedGatewayPID = pid
    }

    func _testProbeFailureMayNeedLaunchAgentRepair(_ code: URLError.Code) -> Bool {
        if case .retryWithRepair = self.probeFailureDisposition(URLError(code)) {
            return true
        }
        return false
    }

    func _testGatewayResponseRetriesWithoutRepair(_ code: String) -> Bool {
        let error = GatewayResponseError(
            method: "health",
            code: code,
            message: "test",
            details: nil)
        if case .retryWithoutRepair = self.probeFailureDisposition(error) {
            return true
        }
        return false
    }

    func setTestingDesiredActive(_ active: Bool) {
        self.desiredActive = active
    }

    func setTestingLastFailureReason(_ reason: String?) {
        self.lastFailureReason = reason
    }

    func setTestingStatus(_ status: Status) {
        self.gatewayOwnership = nil
        switch status {
        case .running, .attachedExisting:
            let port = GatewayEnvironment.gatewayPort()
            let whenMissing: Installation = if case .attachedExisting = status {
                .external
            } else {
                .managed
            }
            self.gatewayOwnership = (
                port, self.installation(for: port, whenMissing: whenMissing))
        case .stopped, .starting, .failed:
            break
        }
        self.status = status
    }

    func _testAttachExistingGatewayIfAvailable(port: Int) async -> Bool {
        self.desiredActive = true
        return await self.attachExistingGatewayIfAvailable(
            port: port,
            startGeneration: self.gatewayStartGeneration)
    }

    func _testAttachExistingGatewayAfterPendingDisable(port: Int) async -> Bool {
        await self.attachExistingGatewayAfterPendingDisable(
            port: port,
            startGeneration: self.gatewayStartGeneration)
    }

    func _testEnableLaunchAgentIfNeeded(port: Int) async -> String? {
        await self.enableLaunchAgentIfNeeded(port: port).error
    }

    func _testEnableLaunchAgentIfNeededInstalled(port: Int) async -> Bool {
        await self.enableLaunchAgentIfNeeded(port: port).installed
    }

    func _testRecordLaunchAgentReadinessFailure(port: Int, startingPID: Int32?) async {
        let failure = await self.resolveLaunchAgentReadinessFailure(
            port: port,
            startingPID: startingPID)
        self.setLaunchAgentReadinessState(
            candidate: self.launchAgentReadinessCandidate,
            failure: failure)
    }

    func _testFinishLaunchAgentReadinessFailure(port: Int, startingPID: Int32?) async {
        let context = self.gatewayReadinessContext(
            purpose: .launchd,
            port: port,
            generation: self.gatewayStartGeneration,
            readinessPID: startingPID)
        let failure = await self.resolveLaunchAgentReadinessFailure(
            port: port,
            startingPID: startingPID)
        let terminalFailure: GatewayReadinessFailure = if let failure {
            .timeoutWithRepairEvidence(failure)
        } else {
            .deadlineWithoutRepairEvidence
        }
        _ = await self.publishGatewayReadinessTerminal(
            .failed(terminalFailure),
            context: context)
    }

    func _testClearLaunchAgentReadinessFailure() {
        self.setLaunchAgentReadinessState(candidate: nil, failure: nil)
    }

    func _testSetLaunchAgentReadinessFailure(port: Int, pid: Int32) {
        self.setLaunchAgentReadinessState(
            candidate: self.launchAgentReadinessCandidate,
            failure: LaunchAgentReadinessFailure(port: port, pid: pid))
    }

    func _testSetLaunchAgentReadinessCandidate(port: Int, pid: Int32) {
        self.setLaunchAgentReadinessState(
            candidate: LaunchAgentReadinessCandidate(
                failure: LaunchAgentReadinessFailure(port: port, pid: pid),
                generation: self.gatewayStartGeneration),
            failure: self.launchAgentReadinessFailure)
    }

    func _testHasLaunchAgentReadinessFailure() -> Bool {
        self.launchAgentReadinessFailure != nil
    }

    func _testHasLaunchAgentReadinessCandidate() -> Bool {
        self.launchAgentReadinessCandidate != nil
    }

    func _testLaunchAgentReadinessCandidatePID() -> Int32? {
        self.launchAgentReadinessCandidate?.failure.pid
    }

    func _testBeginGatewayStartGeneration() {
        self.desiredActive = true
        self.gatewayStartGeneration &+= 1
    }

    func _testPendingLaunchAgentPort() -> Int? {
        self.launchAgentEnablePendingRequest?.port
    }

    func _testResetGatewayStartTask() {
        self.desiredActive = false
        self.gatewayStartGeneration &+= 1
        self.gatewayStartTask?.cancel()
        self.gatewayStartTask = nil
        self.gatewayStartTaskGeneration = nil
    }

    func _testStartLaunchdGatewayReadiness(
        port: Int,
        pid: Int32,
        readinessWindow: TimeInterval,
        firstInstallReadinessBudget: TimeInterval)
    {
        self.desiredActive = true
        self.status = .starting
        self.gatewayStartGeneration &+= 1
        let generation = self.gatewayStartGeneration
        self.launchAgentInstallGeneration = generation
        self.launchAgentFreshInstallGeneration = generation
        let context = self.gatewayReadinessContext(
            purpose: .launchd,
            port: port,
            generation: generation,
            readinessPID: pid,
            launchAgentInstalled: true)
        self.beginGatewayStartTask(generation: generation) { [weak self] in
            await self?.observeLaunchdGatewayReadiness(
                context: context,
                readinessWindow: readinessWindow,
                firstInstallReadinessBudget: firstInstallReadinessBudget)
        }
    }
}
#endif
