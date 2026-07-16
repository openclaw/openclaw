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

    private struct LaunchAgentEnableRequest: Equatable {
        let bundlePath: String
        let port: Int
    }

    private struct LaunchAgentReadinessFailure: Equatable {
        let port: Int
        let pid: Int32
    }

    enum Status: Equatable {
        case stopped
        case starting
        case running(details: String?)
        case attachedExisting(details: String?)
        case failed(String)

        var label: String {
            switch self {
            case .stopped: return "Stopped"
            case .starting: return "Starting…"
            case let .running(details):
                if let details, !details.isEmpty { return "Running (\(details))" }
                return "Running"
            case let .attachedExisting(details):
                if let details, !details.isEmpty {
                    return "Using existing gateway (\(details))"
                }
                return "Using existing gateway"
            case let .failed(reason): return "Failed: \(reason)"
            }
        }
    }

    private(set) var status: Status = .stopped {
        didSet { CanvasManager.shared.refreshDebugStatus() }
    }

    private(set) var log: String = ""
    private(set) var environmentStatus: GatewayEnvironmentStatus = .checking
    private(set) var existingGatewayDetails: String?
    private(set) var lastFailureReason: String?
    private var desiredActive = false
    private var environmentRefreshTask: Task<Void, Never>?
    private var lastEnvironmentRefresh: Date?
    private var logRefreshTask: Task<Void, Never>?
    private var launchAgentEnableTask: Task<String?, Never>?
    private var launchAgentEnableCurrentRequest: LaunchAgentEnableRequest?
    private var launchAgentEnablePendingRequest: LaunchAgentEnableRequest?
    private var launchAgentReadinessFailure: LaunchAgentReadinessFailure?
    #if DEBUG
    private var testingConnection: GatewayConnection?
    private var testingSkipControlChannelRefresh = false
    #endif
    private let logger = Logger(subsystem: "ai.openclaw", category: "gateway.process")

    private let logLimit = 20000 // characters to keep in-memory
    private let environmentRefreshMinInterval: TimeInterval = 30
    private var connection: GatewayConnection {
        #if DEBUG
        return self.testingConnection ?? .shared
        #else
        return .shared
        #endif
    }

    func setActive(_ active: Bool) {
        // Remote mode should never spawn a local gateway; treat as stopped.
        if CommandResolver.connectionModeIsRemote() {
            self.desiredActive = false
            self.stop()
            self.status = .stopped
            self.appendLog("[gateway] remote mode active; skipping local gateway\n")
            self.logger.info("gateway process skipped: remote mode active")
            return
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

    func ensureLaunchAgentEnabledIfNeeded() async {
        guard !CommandResolver.connectionModeIsRemote() else { return }
        if GatewayLaunchAgentManager.isLaunchAgentWriteDisabled() {
            self.appendLog("[gateway] launchd auto-enable skipped (attach-only)\n")
            self.logger.info("gateway launchd auto-enable skipped (disable marker set)")
            return
        }
        let bundlePath = Bundle.main.bundleURL.path
        let port = GatewayEnvironment.gatewayPort()
        let err = await self.enableLaunchAgentIfNeeded(bundlePath: bundlePath, port: port)
        if let err {
            self.appendLog("[gateway] launchd auto-enable failed: \(err)\n")
        }
    }

    private func enableLaunchAgentIfNeeded(bundlePath: String, port: Int) async -> String? {
        let request = LaunchAgentEnableRequest(bundlePath: bundlePath, port: port)
        if let task = self.launchAgentEnableTask {
            if self.launchAgentEnableCurrentRequest == request {
                // The in-flight request already represents the newest configuration. Drop an
                // older queued change so A -> B -> A cannot finish on B.
                self.launchAgentEnablePendingRequest = nil
            } else {
                self.launchAgentEnablePendingRequest = request
            }
            return await task.value
        }

        self.launchAgentEnablePendingRequest = request
        let task = Task { @MainActor in
            await self.drainLaunchAgentEnableRequests()
        }
        self.launchAgentEnableTask = task
        return await task.value
    }

    private func drainLaunchAgentEnableRequests() async -> String? {
        var result: String?
        while let request = self.launchAgentEnablePendingRequest {
            self.launchAgentEnablePendingRequest = nil
            self.launchAgentEnableCurrentRequest = request
            result = await self.performLaunchAgentEnable(request)
            self.launchAgentEnableCurrentRequest = nil
        }
        // Clear the task before returning. A later caller then starts a fresh drain instead of
        // joining a completed task after the final pending-request check.
        self.launchAgentEnableTask = nil
        return result
    }

    private func performLaunchAgentEnable(_ request: LaunchAgentEnableRequest) async -> String? {
        // App startup and onboarding can request persistence together. One drain owns all installs;
        // a second forced install would kill the first Gateway during startup migrations.
        if let pid = await GatewayLaunchAgentManager.reusableLoadedGatewayPID(port: request.port) {
            let failure = LaunchAgentReadinessFailure(port: request.port, pid: pid)
            if self.launchAgentReadinessFailure != failure {
                // A new launchd PID may still be running migrations. It must fail one complete
                // readiness cycle before a later retry is allowed to replace it.
                self.launchAgentReadinessFailure = nil
                return nil
            }

            let listener = await PortGuardian.shared.describe(port: request.port)
            if let listener, listener.pid != pid {
                // A foreign listener must never be displaced. The attach path reports its failure.
                return nil
            }

            self.appendLog(
                "[gateway] launchd pid \(pid) failed readiness on port \(request.port); repairing\n")
            self.logger.warning(
                "gateway launchd pid=\(pid) failed readiness on port=\(request.port); repairing")
        }
        self.launchAgentReadinessFailure = nil
        self.appendLog(
            "[gateway] enabling launchd job (\(gatewayLaunchdLabel)) on port \(request.port)\n")
        return await GatewayLaunchAgentManager.set(
            enabled: true,
            bundlePath: request.bundlePath,
            port: request.port)
    }

    private func recordLaunchAgentReadinessFailure(port: Int, startingPID: Int32?) async {
        guard let startingPID,
              let pid = await GatewayLaunchAgentManager.reusableLoadedGatewayPID(port: port),
              pid == startingPID
        else {
            self.launchAgentReadinessFailure = nil
            return
        }
        // A stable launchd PID that owns the port can still have a wedged health RPC. A listener
        // owned by anyone else is protected and surfaced through the attach path instead.
        if let listener = await PortGuardian.shared.describe(port: port), listener.pid != pid {
            self.launchAgentReadinessFailure = nil
            return
        }
        self.launchAgentReadinessFailure = LaunchAgentReadinessFailure(port: port, pid: pid)
    }

    func startIfNeeded() {
        guard self.desiredActive else { return }
        // Do not spawn in remote mode (the gateway should run on the remote host).
        guard !CommandResolver.connectionModeIsRemote() else {
            self.status = .stopped
            return
        }
        // Many surfaces can call `setActive(true)` in quick succession (startup, Canvas, health checks).
        // Avoid spawning multiple concurrent "start" tasks that can thrash launchd and flap the port.
        switch self.status {
        case .starting, .running, .attachedExisting:
            return
        case .stopped, .failed:
            break
        }
        self.status = .starting
        self.logger.debug("gateway start requested")

        // First try to latch onto an already-running gateway to avoid spawning a duplicate.
        Task { [weak self] in
            guard let self else { return }
            if await self.attachExistingGatewayIfAvailable() {
                return
            }
            await self.enableLaunchdGateway()
        }
    }

    func stop() {
        self.desiredActive = false
        self.existingGatewayDetails = nil
        self.lastFailureReason = nil
        self.launchAgentReadinessFailure = nil
        self.status = .stopped
        self.logger.info("gateway stop requested")
        if CommandResolver.connectionModeIsRemote() {
            return
        }
        let bundlePath = Bundle.main.bundleURL.path
        Task {
            _ = await GatewayLaunchAgentManager.set(
                enabled: false,
                bundlePath: bundlePath,
                port: GatewayEnvironment.gatewayPort())
        }
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
            let status = await Task.detached(priority: .utility) {
                GatewayEnvironment.check()
            }.value
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

    /// Attempt to connect to an already-running gateway on the configured port.
    /// If successful, mark status as attached and skip spawning a new process.
    private func attachExistingGatewayIfAvailable(port requestedPort: Int? = nil) async -> Bool {
        let port = requestedPort ?? GatewayEnvironment.gatewayPort()
        let instance = await PortGuardian.shared.describe(port: port)
        let instanceText = instance.map { self.describe(instance: $0) }
        let hasListener = instance != nil

        let attemptAttach = {
            try await self.probeGatewayHealth(timeoutMs: 2000)
        }

        for attempt in 0..<(hasListener ? 3 : 1) {
            do {
                let data = try await attemptAttach()
                let snap = decodeHealthSnapshot(from: data)
                let details = self.describe(details: instanceText, port: port, snap: snap)
                self.existingGatewayDetails = details
                self.launchAgentReadinessFailure = nil
                self.clearLastFailure()
                self.status = .attachedExisting(details: details)
                self.appendLog("[gateway] using existing instance: \(details)\n")
                self.logger.info("gateway using existing instance details=\(details)")
                self.refreshControlChannelIfNeeded(reason: "attach existing")
                self.refreshLog()
                return true
            } catch {
                if attempt < 2, hasListener {
                    try? await Task.sleep(nanoseconds: 250_000_000)
                    continue
                }

                if hasListener {
                    let reason = self.describeAttachFailure(error, port: port, instance: instance)
                    self.existingGatewayDetails = instanceText
                    self.status = .failed(reason)
                    self.lastFailureReason = reason
                    self.appendLog("[gateway] existing listener on port \(port) but attach failed: \(reason)\n")
                    self.logger.warning("gateway attach failed reason=\(reason)")
                    return true
                }

                // No reachable gateway (and no listener) — fall through to spawn.
                self.existingGatewayDetails = nil
                return false
            }
        }

        self.existingGatewayDetails = nil
        return false
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
        let ns = error as NSError
        let message = ns.localizedDescription.isEmpty ? "unknown error" : ns.localizedDescription
        let lower = message.lowercased()
        if self.isGatewayAuthFailure(error) {
            return """
            Gateway on port \(port) rejected auth. Set gateway.auth.token to match the running gateway \
            (or clear it on the gateway) and retry.
            """
        }
        if lower.contains("protocol mismatch") {
            return "Gateway on port \(port) is incompatible (protocol mismatch). Update the app/gateway."
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

    private func isGatewayAuthFailure(_ error: Error) -> Bool {
        if let urlError = error as? URLError, urlError.code == .dataNotAllowed {
            return true
        }
        let ns = error as NSError
        if ns.domain == "Gateway", ns.code == 1008 { return true }
        let lower = ns.localizedDescription.lowercased()
        return lower.contains("unauthorized") || lower.contains("auth")
    }

    private func enableLaunchdGateway() async {
        self.existingGatewayDetails = nil
        let resolution = await Task.detached(priority: .utility) {
            GatewayEnvironment.resolveGatewayCommand()
        }.value
        await MainActor.run { self.environmentStatus = resolution.status }
        guard resolution.command != nil else {
            await MainActor.run {
                self.status = .failed(resolution.status.message)
            }
            self.logger.error("gateway command resolve failed: \(resolution.status.message)")
            return
        }

        if GatewayLaunchAgentManager.isLaunchAgentWriteDisabled() {
            let message = "Launchd disabled; start the Gateway manually or disable attach-only."
            self.status = .failed(message)
            self.lastFailureReason = "launchd disabled"
            self.appendLog("[gateway] launchd disabled; skipping auto-start\n")
            self.logger.info("gateway launchd enable skipped (disable marker set)")
            return
        }

        let bundlePath = Bundle.main.bundleURL.path
        let port = GatewayEnvironment.gatewayPort()
        self.logger.info("gateway ensuring launchd port=\(port)")
        let err = await self.enableLaunchAgentIfNeeded(bundlePath: bundlePath, port: port)
        if let err {
            self.status = .failed(err)
            self.lastFailureReason = err
            self.logger.error("gateway launchd enable failed: \(err)")
            return
        }

        let readinessPID = await GatewayLaunchAgentManager.reusableLoadedGatewayPID(port: port)
        // Best-effort: wait for the gateway to accept connections.
        let deadline = Date().addingTimeInterval(6)
        while Date() < deadline {
            if !self.desiredActive { return }
            do {
                let remainingMs = max(1, deadline.timeIntervalSinceNow * 1000)
                _ = try await self.probeGatewayHealth(timeoutMs: min(1500, remainingMs))
                let instance = await PortGuardian.shared.describe(port: port)
                let details = instance.map { "pid \($0.pid)" }
                self.launchAgentReadinessFailure = nil
                self.clearLastFailure()
                self.status = .running(details: details)
                self.logger.info("gateway started details=\(details ?? "ok")")
                self.refreshControlChannelIfNeeded(reason: "gateway started")
                self.refreshLog()
                return
            } catch {
                let retryDelay = min(0.4, max(0, deadline.timeIntervalSinceNow))
                if retryDelay > 0 {
                    try? await Task.sleep(nanoseconds: UInt64(retryDelay * 1_000_000_000))
                }
            }
        }

        // Only a PID that survived this entire readiness cycle may be replaced later. launchd can
        // restart the service while polling; that replacement needs its own full startup chance.
        await self.recordLaunchAgentReadinessFailure(port: port, startingPID: readinessPID)
        self.status = .failed("Gateway did not start in time")
        self.lastFailureReason = "launchd start timeout"
        self.logger.warning("gateway start timed out")
    }

    private func appendLog(_ chunk: String) {
        self.log.append(chunk)
        if self.log.count > self.logLimit {
            self.log = String(self.log.suffix(self.logLimit))
        }
    }

    private func refreshControlChannelIfNeeded(reason: String) {
        #if DEBUG
        if self.testingSkipControlChannelRefresh {
            return
        }
        #endif
        switch ControlChannel.shared.state {
        case .connected, .connecting:
            return
        case .disconnected, .degraded:
            break
        }
        self.appendLog("[gateway] refreshing control channel (\(reason))\n")
        self.logger.debug("gateway control channel refresh reason=\(reason)")
        Task { await ControlChannel.shared.configure() }
    }

    func waitForGatewayReady(timeout: TimeInterval = 6) async -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if !self.desiredActive { return false }
            do {
                let remainingMs = max(1, deadline.timeIntervalSinceNow * 1000)
                _ = try await self.probeGatewayHealth(timeoutMs: min(1500, remainingMs))
                self.clearLastFailure()
                return true
            } catch {
                let retryDelay = min(0.3, max(0, deadline.timeIntervalSinceNow))
                if retryDelay > 0 {
                    try? await Task.sleep(nanoseconds: UInt64(retryDelay * 1_000_000_000))
                }
            }
        }
        self.appendLog("[gateway] readiness wait timed out\n")
        self.logger.warning("gateway readiness wait timed out")
        return false
    }

    private func probeGatewayHealth(timeoutMs: Double) async throws -> Data {
        let connection = self.connection
        // Startup owns recovery and its wall-clock deadline. A normal request can recursively
        // start the Gateway and spend several 30-second connect retries before its RPC timer begins.
        return try await AsyncTimeout.withTimeout(
            seconds: max(0.001, timeoutMs / 1000),
            onTimeout: { GatewayHealthProbeTimeout(timeoutMs: timeoutMs) },
            operation: {
                try await connection.request(
                    method: GatewayConnection.Method.health.rawValue,
                    params: nil,
                    timeoutMs: timeoutMs,
                    retryTransportFailures: false)
            })
    }

    func clearLog() {
        self.log = ""
        try? FileManager().removeItem(atPath: GatewayLaunchAgentManager.launchdGatewayLogPath())
        self.logger.debug("gateway log cleared")
    }

    func setProjectRoot(path: String) {
        CommandResolver.setProjectRoot(path)
    }

    func projectRootPath() -> String {
        CommandResolver.projectRootPath()
    }

    private nonisolated static func readGatewayLog(path: String, limit: Int) -> String {
        guard FileManager().fileExists(atPath: path) else { return "" }
        guard let data = try? Data(contentsOf: URL(fileURLWithPath: path)) else { return "" }
        let text = String(data: data, encoding: .utf8) ?? ""
        if text.count <= limit { return text }
        return String(text.suffix(limit))
    }
}

#if DEBUG
extension GatewayProcessManager {
    func setTestingConnection(_ connection: GatewayConnection?) {
        self.testingConnection = connection
    }

    func setTestingSkipControlChannelRefresh(_ skip: Bool) {
        self.testingSkipControlChannelRefresh = skip
    }

    func setTestingDesiredActive(_ active: Bool) {
        self.desiredActive = active
    }

    func setTestingLastFailureReason(_ reason: String?) {
        self.lastFailureReason = reason
    }

    func _testAttachExistingGatewayIfAvailable(port: Int) async -> Bool {
        await self.attachExistingGatewayIfAvailable(port: port)
    }

    func _testEnableLaunchAgentIfNeeded(bundlePath: String, port: Int) async -> String? {
        await self.enableLaunchAgentIfNeeded(bundlePath: bundlePath, port: port)
    }

    func _testRecordLaunchAgentReadinessFailure(port: Int, startingPID: Int32?) async {
        await self.recordLaunchAgentReadinessFailure(port: port, startingPID: startingPID)
    }

    func _testClearLaunchAgentReadinessFailure() {
        self.launchAgentReadinessFailure = nil
    }

    func _testPendingLaunchAgentPort() -> Int? {
        self.launchAgentEnablePendingRequest?.port
    }
}
#endif
