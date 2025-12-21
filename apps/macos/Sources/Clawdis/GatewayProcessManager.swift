import Foundation
import Observation

@MainActor
@Observable
final class GatewayProcessManager {
    static let shared = GatewayProcessManager()

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

    private let logLimit = 20000 // characters to keep in-memory
    private let environmentRefreshMinInterval: TimeInterval = 30

    func setActive(_ active: Bool) {
        // Remote mode should never spawn a local gateway; treat as stopped.
        if CommandResolver.connectionModeIsRemote() {
            self.desiredActive = false
            self.stop()
            self.status = .stopped
            self.appendLog("[gateway] remote mode active; skipping local gateway\n")
            return
        }
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
        guard !AppStateStore.attachExistingGatewayOnly else { return }
        let enabled = await GatewayLaunchAgentManager.status()
        guard !enabled else { return }
        let bundlePath = Bundle.main.bundleURL.path
        let port = GatewayEnvironment.gatewayPort()
        self.appendLog("[gateway] auto-enabling launchd job (\(gatewayLaunchdLabel)) on port \(port)\n")
        let err = await GatewayLaunchAgentManager.set(enabled: true, bundlePath: bundlePath, port: port)
        if let err {
            self.appendLog("[gateway] launchd auto-enable failed: \(err)\n")
        }
    }

    func startIfNeeded() {
        guard self.desiredActive else { return }
        // Do not spawn in remote mode (the gateway should run on the remote host).
        guard !CommandResolver.connectionModeIsRemote() else {
            self.status = .stopped
            return
        }
        self.status = .starting

        // First try to latch onto an already-running gateway to avoid spawning a duplicate.
        Task { [weak self] in
            guard let self else { return }
            if await self.attachExistingGatewayIfAvailable() {
                return
            }
            // Respect debug toggle: only attach, never spawn, when enabled.
            if AppStateStore.attachExistingGatewayOnly {
                await MainActor.run {
                    self.status = .failed("Attach-only enabled; no gateway to attach")
                    self.appendLog("[gateway] attach-only enabled; not spawning local gateway\n")
                }
                return
            }
            await self.enableLaunchdGateway()
        }
    }

    func stop() {
        self.desiredActive = false
        self.existingGatewayDetails = nil
        self.lastFailureReason = nil
        self.status = .stopped
        let bundlePath = Bundle.main.bundleURL.path
        Task {
            _ = await GatewayLaunchAgentManager.set(
                enabled: false,
                bundlePath: bundlePath,
                port: GatewayEnvironment.gatewayPort())
        }
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
        let path = LogLocator.launchdGatewayLogPath
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
    private func attachExistingGatewayIfAvailable() async -> Bool {
        let port = GatewayEnvironment.gatewayPort()
        do {
            let data = try await GatewayConnection.shared.requestRaw(method: .health, timeoutMs: 2000)
            let snap = decodeHealthSnapshot(from: data)

            let instance = await PortGuardian.shared.describe(port: port)
            let instanceText: String
            if let instance {
                let path = instance.executablePath ?? "path unknown"
                instanceText = "pid \(instance.pid) \(instance.command) @ \(path)"
            } else {
                instanceText = "pid unknown"
            }

            let details: String
            if let snap {
                let linked = snap.web.linked ? "linked" : "not linked"
                let authAge = snap.web.authAgeMs.flatMap(msToAge) ?? "unknown age"
                details = "port \(port), \(linked), auth \(authAge), \(instanceText)"
            } else {
                details = "port \(port), health probe succeeded, \(instanceText)"
            }

            self.existingGatewayDetails = details
            self.status = .attachedExisting(details: details)
            self.appendLog("[gateway] using existing instance: \(details)\n")
            self.refreshLog()
            return true
        } catch {
            // No reachable gateway (or token mismatch) — fall through to spawn.
            self.existingGatewayDetails = nil
            return false
        }
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
            return
        }

        let bundlePath = Bundle.main.bundleURL.path
        let port = GatewayEnvironment.gatewayPort()
        self.appendLog("[gateway] enabling launchd job (\(gatewayLaunchdLabel)) on port \(port)\n")
        let err = await GatewayLaunchAgentManager.set(enabled: true, bundlePath: bundlePath, port: port)
        if let err {
            self.status = .failed(err)
            self.lastFailureReason = err
            return
        }

        // Best-effort: wait for the gateway to accept connections.
        let deadline = Date().addingTimeInterval(6)
        while Date() < deadline {
            if !self.desiredActive { return }
            do {
                _ = try await GatewayConnection.shared.requestRaw(method: .health, timeoutMs: 1500)
                let instance = await PortGuardian.shared.describe(port: port)
                let details = instance.map { "pid \($0.pid)" }
                self.status = .running(details: details)
                self.refreshLog()
                return
            } catch {
                try? await Task.sleep(nanoseconds: 400_000_000)
            }
        }

        self.status = .failed("Gateway did not start in time")
        self.lastFailureReason = "launchd start timeout"
    }

    private func appendLog(_ chunk: String) {
        self.log.append(chunk)
        if self.log.count > self.logLimit {
            self.log = String(self.log.suffix(self.logLimit))
        }
    }

    func clearLog() {
        self.log = ""
        try? FileManager.default.removeItem(atPath: LogLocator.launchdGatewayLogPath)
    }

    func setProjectRoot(path: String) {
        CommandResolver.setProjectRoot(path)
    }

    func projectRootPath() -> String {
        CommandResolver.projectRootPath()
    }

    private nonisolated static func readGatewayLog(path: String, limit: Int) -> String {
        guard FileManager.default.fileExists(atPath: path) else { return "" }
        guard let data = try? Data(contentsOf: URL(fileURLWithPath: path)) else { return "" }
        let text = String(data: data, encoding: .utf8) ?? ""
        if text.count <= limit { return text }
        return String(text.suffix(limit))
    }
}
