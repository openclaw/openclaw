import Darwin
import Foundation
import Subprocess

@MainActor
final class GatewayChildSupervisor {
    // gateway-shutdown-budget.mjs: 325 s shutdown + 5 s supervisor margin.
    nonisolated static let shutdownTimeoutSeconds: TimeInterval = 330

    struct Configuration: Sendable {
        let bun: URL
        let packageRoot: URL
        let environment: [String: String]
        let logPath: String
        let port: Int
        let allowUnconfigured: Bool

        var arguments: [String] {
            [
                self.packageRoot.appendingPathComponent("openclaw.mjs").path,
                "gateway",
                "run",
                "--port",
                String(self.port),
            ] +
                (self.allowUnconfigured ? ["--allow-unconfigured"] : [])
        }

        var childEnvironment: [String: String] {
            var environment = GatewayChildSupervisor.environmentWithoutSupervisorMarkers(self.environment)
            environment["OPENCLAW_GATEWAY_HOST_LIFELINE"] = "stdin"
            return environment
        }
    }

    nonisolated static func environmentWithoutSupervisorMarkers(_ source: [String: String]) -> [String: String] {
        // Neither a child Gateway nor an installer CLI inherits the app or old service's supervisor.
        // Keep aligned with src/infra/supervisor-markers.ts.
        let markers: Set = [
            "OPENCLAW_SUPERVISOR_MODE", "OPENCLAW_LAUNCHD_LABEL", "XPC_SERVICE_NAME",
            "OPENCLAW_SYSTEMD_UNIT", "INVOCATION_ID", "SYSTEMD_EXEC_PID", "JOURNAL_STREAM",
            "OPENCLAW_WINDOWS_TASK_NAME", "OPENCLAW_SERVICE_MARKER", "OPENCLAW_SERVICE_KIND",
            "OPENCLAW_GATEWAY_HOST_LIFELINE",
        ]
        return source.filter { !markers.contains($0.key) && !$0.key.hasPrefix("LAUNCH_JOB_") }
    }

    struct Child: Sendable {
        let waitUntilStarted: @Sendable () async throws -> Int32
        let wait: @Sendable () async -> String
        let terminate: @Sendable () async -> Void
    }

    enum Event: Equatable {
        /// Initial startup returns its PID directly; this event is only for automatic restarts.
        case started(Int32)
        case restarting(delay: Duration)
        case failed(String)
    }

    typealias Launcher = @MainActor (Configuration) throws -> Child

    private(set) var processIdentifier: Int32?
    var isActive: Bool {
        self.child != nil || self.monitorTask != nil || self.stopTask != nil
    }

    private let launcher: Launcher
    private let clock: any Clock<Duration>
    private let elapsedTime: @Sendable () -> Duration
    private var child: Child?
    private var generation: UInt64 = 0
    private var fastFailures = 0
    private var monitorTask: Task<Void, Never>?
    private var healthySince: Duration?
    private var stopTask: Task<Void, Never>?

    init(
        clock: any Clock<Duration> = ContinuousClock(),
        launcher: @escaping Launcher = GatewayChildSupervisor.launch)
    {
        self.clock = clock
        self.elapsedTime = Self.elapsedTime(clock: clock)
        self.launcher = launcher
    }

    private static func elapsedTime<C: Clock>(clock: C) -> @Sendable () -> Duration where C.Duration == Duration {
        let origin = clock.now
        return { origin.duration(to: clock.now) }
    }

    func start(
        configuration: Configuration,
        onEvent: @escaping @MainActor (Event) -> Void) async throws -> Int32
    {
        if let stopTask { await stopTask.value }
        if let processIdentifier { return processIdentifier }
        guard self.child == nil, self.monitorTask == nil else { throw CancellationError() }
        self.generation &+= 1
        let generation = self.generation
        self.fastFailures = 0
        let child = try self.launcher(configuration)
        self.child = child
        let pid: Int32
        do {
            pid = try await child.waitUntilStarted()
        } catch {
            await child.terminate()
            if self.generation == generation { self.child = nil }
            throw error
        }
        guard self.generation == generation else { throw CancellationError() }
        self.processIdentifier = pid
        self.monitorTask = Task { [weak self] in
            await self?.monitor(child, configuration: configuration, generation: generation, onEvent: onEvent)
        }
        return pid
    }

    func markHealthy(pid: Int32) {
        guard self.processIdentifier == pid, self.healthySince == nil else { return }
        self.healthySince = self.elapsedTime()
    }

    func stop() async {
        if let stopTask {
            await stopTask.value
            return
        }
        self.generation &+= 1
        let monitorTask = self.monitorTask
        monitorTask?.cancel()
        self.monitorTask = nil
        self.healthySince = nil
        self.processIdentifier = nil
        let child = self.child
        self.child = nil
        let stopTask = Task {
            await child?.terminate()
            await monitorTask?.value
        }
        self.stopTask = stopTask
        await stopTask.value
        self.stopTask = nil
    }

    private func monitor(
        _ firstChild: Child,
        configuration: Configuration,
        generation: UInt64,
        onEvent: @escaping @MainActor (Event) -> Void) async
    {
        var child = firstChild
        var failure = await child.wait()
        while self.generation == generation, !Task.isCancelled {
            self.child = nil
            self.processIdentifier = nil
            if let healthySince, self.elapsedTime() - healthySince >= .seconds(60) {
                self.fastFailures = 0
            }
            self.healthySince = nil
            self.fastFailures += 1
            guard self.fastFailures < 5 else {
                self.monitorTask = nil
                let tail = Self.logTail(path: configuration.logPath)
                onEvent(.failed("Gateway stopped after five failed starts (\(failure))." +
                        (tail.isEmpty ? "" : "\n\(tail)")))
                return
            }
            let delay = Duration.seconds(min(30, 1 << (self.fastFailures - 1)))
            onEvent(.restarting(delay: delay))
            do { try await self.clock.sleep(for: delay) } catch { return }
            guard self.generation == generation, !Task.isCancelled else { return }
            do {
                child = try self.launcher(configuration)
                self.child = child
                let pid = try await child.waitUntilStarted()
                guard self.generation == generation, !Task.isCancelled else { return }
                self.processIdentifier = pid
                onEvent(.started(pid))
                failure = await child.wait()
            } catch {
                if self.child != nil { await child.terminate() }
                failure = error.localizedDescription
            }
        }
    }

    private static func logTail(path: String) -> String {
        guard let handle = FileHandle(forReadingAtPath: path) else { return "" }
        defer { try? handle.close() }
        do {
            let size = try handle.seekToEnd()
            try handle.seek(toOffset: size > 20000 ? size - 20000 : 0)
            guard let bytes = try handle.readToEnd() else { return "" }
            // Seeking into the tail can split one UTF-8 scalar at the beginning.
            for offset in 0...min(3, bytes.count) {
                if let text = String(bytes: bytes.dropFirst(offset), encoding: .utf8) { return text }
            }
            return "Could not decode the Gateway log. Open \(path) for details."
        } catch { return "" }
    }

    private static func launch(configuration: Configuration) throws -> Child {
        let logURL = URL(fileURLWithPath: configuration.logPath)
        try FileManager.default.createDirectory(
            at: logURL.deletingLastPathComponent(), withIntermediateDirectories: true)
        // Darwin's SETEXEC session spawn needs this descriptor open for its file actions.
        // Subprocess applies CLOEXEC_DEFAULT to close unrelated descriptors in the child.
        let descriptor = Darwin.open(logURL.path, O_WRONLY | O_CREAT | O_APPEND, S_IRUSR | S_IWUSR)
        guard descriptor >= 0 else { throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO) }
        let log = FileHandle(fileDescriptor: descriptor, closeOnDealloc: true)
        let lifeline = Pipe()
        let process = ManagedProcess.launch(
            configuration: Subprocess.Configuration(
                executable: .path(.init(configuration.bun.path)),
                arguments: Arguments(configuration.arguments),
                environment: ManagedProcess.environment(from: configuration.childEnvironment)),
            input: .fileDescriptor(
                .init(rawValue: lifeline.fileHandleForReading.fileDescriptor),
                closeAfterSpawningProcess: false),
            output: .fileDescriptor(.init(rawValue: descriptor), closeAfterSpawningProcess: false),
            error: .fileDescriptor(.init(rawValue: descriptor), closeAfterSpawningProcess: false),
            closeAfterSpawn: [lifeline.fileHandleForReading, log],
            closeStdinForGracefulShutdown: lifeline.fileHandleForWriting,
            terminateWhenClosingStdin: true,
            gracefulShutdownTimeout: .seconds(Self.shutdownTimeoutSeconds))
        return Child(
            waitUntilStarted: { try await process.waitUntilStarted() },
            wait: { await String(describing: process.completionTask.value) },
            terminate: { await process.terminate() })
    }
}
