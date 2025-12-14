import Foundation
import Network
import Observation
import OSLog
import Subprocess
#if canImport(Darwin)
import Darwin
#endif
#if canImport(System)
import System
#else
import SystemPackage
#endif

@MainActor
@Observable
final class GatewayProcessManager {
    static let shared = GatewayProcessManager()

    enum Status: Equatable {
        case stopped
        case starting
        case running(pid: Int32)
        case restarting
        case attachedExisting(details: String?)
        case failed(String)

        var label: String {
            switch self {
            case .stopped: return "Stopped"
            case .starting: return "Starting…"
            case let .running(pid): return "Running (pid \(pid))"
            case .restarting: return "Restarting…"
            case let .attachedExisting(details):
                if let details, !details.isEmpty {
                    return "Using existing gateway (\(details))"
                }
                return "Using existing gateway"
            case let .failed(reason): return "Failed: \(reason)"
            }
        }
    }

    private(set) var status: Status = .stopped
    private(set) var log: String = ""
    private(set) var restartCount: Int = 0
    private(set) var environmentStatus: GatewayEnvironmentStatus = .checking
    private(set) var existingGatewayDetails: String?

    private var execution: Execution?
    private var lastPid: Int32?
    private var lastCommand: [String]?
    private var desiredActive = false
    private var stopping = false
    private var recentCrashes: [Date] = []

    private final class GatewayLockHandle {
        private let fd: FileDescriptor
        private let path: String

        init(fd: FileDescriptor, path: String) {
            self.fd = fd
            self.path = path
        }

        func cancel() {
            try? self.fd.close()
            try? FileManager.default.removeItem(atPath: self.path)
        }
    }

    private let logger = Logger(subsystem: "com.steipete.clawdis", category: "gateway")
    private let logLimit = 20000 // characters to keep in-memory
    private let maxCrashes = 3
    private let crashWindow: TimeInterval = 120 // seconds

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

    func startIfNeeded() {
        guard self.execution == nil, self.desiredActive else { return }
        // Do not spawn in remote mode (the gateway should run on the remote host).
        guard !CommandResolver.connectionModeIsRemote() else {
            self.status = .stopped
            return
        }
        if self.shouldGiveUpAfterCrashes() {
            self.status = .failed("Too many crashes; giving up")
            return
        }

        if self.status != .restarting {
            self.status = .starting
        }

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
            await self.spawnGateway()
        }
    }

    func stop() {
        self.desiredActive = false
        self.stopping = true
        self.existingGatewayDetails = nil
        guard let execution else {
            self.status = .stopped
            return
        }
        self.status = .stopped
        Task {
            await execution.teardown(using: [.gracefulShutDown(allowedDurationToNextStep: .seconds(1))])
        }
        self.execution = nil
    }

    func refreshEnvironmentStatus() {
        self.environmentStatus = GatewayEnvironment.check()
    }

    // MARK: - Internals

    /// Attempt to connect to an already-running gateway on the configured port.
    /// If successful, mark status as attached and skip spawning a new process.
    private func attachExistingGatewayIfAvailable() async -> Bool {
        let port = GatewayEnvironment.gatewayPort()
        do {
            let data = try await GatewayConnection.shared.request(method: "health", params: nil)
            let details: String
            if let snap = decodeHealthSnapshot(from: data) {
                let linked = snap.web.linked ? "linked" : "not linked"
                let authAge = snap.web.authAgeMs.flatMap(msToAge) ?? "unknown age"
                let instance = await PortGuardian.shared.describe(port: port)
                let instanceText: String
                if let instance {
                    let path = instance.executablePath ?? "path unknown"
                    instanceText = "pid \(instance.pid) \(instance.command) @ \(path)"
                } else {
                    instanceText = "pid unknown"
                }
                details = "port \(port), \(linked), auth \(authAge), \(instanceText)"
            } else {
                details = "port \(port), health probe succeeded"
            }
            self.existingGatewayDetails = details
            self.status = .attachedExisting(details: details)
            self.appendLog("[gateway] using existing instance: \(details)\n")
            return true
        } catch {
            // No reachable gateway (or token mismatch) — fall through to spawn.
            self.existingGatewayDetails = nil
            return false
        }
    }

    private func spawnGateway() async {
        if self.status != .restarting {
            self.status = .starting
        }
        self.existingGatewayDetails = nil
        let resolution = GatewayEnvironment.resolveGatewayCommand()
        await MainActor.run { self.environmentStatus = resolution.status }
        guard let command = resolution.command else {
            await MainActor.run {
                self.status = .failed(resolution.status.message)
            }
            return
        }

        let cwd = self.defaultProjectRoot().path
        self.appendLog("[gateway] starting: \(command.joined(separator: " ")) (cwd: \(cwd))\n")
        self.lastCommand = command

        do {
            // Acquire the same UDS lock the CLI uses to guarantee a single instance.
            let lockPath = FileManager.default.temporaryDirectory.appendingPathComponent("clawdis-gateway.lock").path
            let listener = try self.acquireGatewayLock(path: lockPath)

            let result = try await run(
                .name(command.first ?? "clawdis"),
                arguments: Arguments(Array(command.dropFirst())),
                environment: self.makeEnvironment(),
                workingDirectory: FilePath(cwd))
            { execution, stdin, stdout, stderr in
                self.didStart(execution)
                // Consume stdout/stderr eagerly so the gateway can't block on full pipes.
                async let out: Void = self.stream(output: stdout, label: "stdout")
                async let err: Void = self.stream(output: stderr, label: "stderr")
                try await stdin.finish()
                await out
                await err
            }

            // Release the lock after the process exits.
            listener.cancel()

            await self.handleTermination(status: result.terminationStatus)
        } catch {
            await self.handleError(error)
        }
    }

    /// Minimal clone of the Node gateway lock: take an exclusive file lock.
    private func acquireGatewayLock(path: String) throws -> GatewayLockHandle {
        // Remove stale lock if needed (mirrors CLI behavior).
        try? FileManager.default.removeItem(atPath: path)
        let fd = try FileDescriptor.open(
            FilePath(path),
            .readWrite,
            options: [.create, .exclusiveCreate],
            permissions: [.ownerReadWrite])
        return GatewayLockHandle(fd: fd, path: path)
    }

    private func didStart(_ execution: Execution) {
        self.execution = execution
        self.stopping = false
        self.status = .running(pid: execution.processIdentifier.value)
        self.lastPid = execution.processIdentifier.value
        self.logger.info("gateway started pid \(execution.processIdentifier.value)")
        Task {
            await PortGuardian.shared.record(
                port: GatewayEnvironment.gatewayPort(),
                pid: execution.processIdentifier.value,
                command: (self.lastCommand ?? []).joined(separator: " "),
                mode: AppStateStore.shared.connectionMode)
        }
    }

    private func handleTermination(status: TerminationStatus) async {
        let code: Int32 = switch status {
        case let .exited(exitCode): exitCode
        case let .unhandledException(sig): -Int32(sig)
        }

        self.execution = nil
        if let pid = self.lastPid {
            Task { await PortGuardian.shared.removeRecord(pid: pid) }
        }
        self.lastPid = nil
        self.lastCommand = nil
        if self.stopping || !self.desiredActive {
            self.status = .stopped
            self.stopping = false
            if let pid = self.lastPid {
                Task { await PortGuardian.shared.removeRecord(pid: pid) }
            }
            return
        }

        self.recentCrashes.append(Date())
        self.recentCrashes = self.recentCrashes.filter { Date().timeIntervalSince($0) < self.crashWindow }
        self.restartCount += 1
        self.appendLog("[gateway] exited (\(code)).\n")

        if self.shouldGiveUpAfterCrashes() {
            self.status = .failed("Too many crashes; stopped auto-restart.")
            self.logger.error("gateway crash loop detected; giving up")
            return
        }

        self.status = .restarting
        self.logger.warning("gateway crashed (code \(code)); restarting")
        // Slight backoff to avoid hammering the system in case of immediate crash-on-start.
        try? await Task.sleep(nanoseconds: 750_000_000)
        self.startIfNeeded()
    }

    private func handleError(_ error: any Error) async {
        self.execution = nil
        var message = error.localizedDescription
        if let sp = error as? SubprocessError {
            message = "SubprocessError \(sp.code.value): \(sp)"
        }
        self.appendLog("[gateway] failed: \(message)\n")
        self.logger.error("gateway failed: \(message, privacy: .public)")
        if self.desiredActive, !self.shouldGiveUpAfterCrashes() {
            self.status = .restarting
            self.recentCrashes.append(Date())
            self.startIfNeeded()
        } else {
            self.status = .failed(error.localizedDescription)
        }
    }

    private func shouldGiveUpAfterCrashes() -> Bool {
        self.recentCrashes = self.recentCrashes.filter { Date().timeIntervalSince($0) < self.crashWindow }
        return self.recentCrashes.count >= self.maxCrashes
    }

    private func stream(output: AsyncBufferSequence, label: String) async {
        do {
            for try await line in output.lines() {
                await MainActor.run {
                    self.appendLog(line + "\n")
                }
            }
        } catch {
            await MainActor.run {
                self.appendLog("[gateway \(label)] stream error: \(error.localizedDescription)\n")
            }
        }
    }

    private func appendLog(_ chunk: String) {
        self.log.append(chunk)
        if self.log.count > self.logLimit {
            self.log = String(self.log.suffix(self.logLimit))
        }
    }

    func clearLog() {
        self.log = ""
    }

    private func makeEnvironment() -> Environment {
        let merged = CommandResolver.preferredPaths().joined(separator: ":")
        return .inherit.updating([
            "PATH": merged,
            "PNPM_HOME": FileManager.default.homeDirectoryForCurrentUser
                .appendingPathComponent("Library/pnpm").path,
            "CLAWDIS_PROJECT_ROOT": CommandResolver.projectRoot().path,
        ])
    }

    private func defaultProjectRoot() -> URL {
        CommandResolver.projectRoot()
    }

    func setProjectRoot(path: String) {
        CommandResolver.setProjectRoot(path)
    }

    func projectRootPath() -> String {
        CommandResolver.projectRootPath()
    }
}
