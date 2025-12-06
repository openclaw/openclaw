import Foundation
import OSLog
import Subprocess
#if canImport(Darwin)
import Darwin
#endif

@MainActor
final class RelayProcessManager: ObservableObject {
    static let shared = RelayProcessManager()

    enum Status: Equatable {
        case stopped
        case starting
        case running(pid: Int32)
        case restarting
        case failed(String)

        var label: String {
            switch self {
            case .stopped: "Stopped"
            case .starting: "Starting…"
            case let .running(pid): "Running (pid \(pid))"
            case .restarting: "Restarting…"
            case let .failed(reason): "Failed: \(reason)"
            }
        }
    }

    @Published private(set) var status: Status = .stopped
    @Published private(set) var log: String = ""
    @Published private(set) var restartCount: Int = 0

    private var execution: Execution?
    private var desiredActive = false
    private var stopping = false
    private var recentCrashes: [Date] = []

    private let logger = Logger(subsystem: "com.steipete.clawdis", category: "relay")
    private let logLimit = 20_000 // characters to keep in-memory
    private let maxCrashes = 3
    private let crashWindow: TimeInterval = 120 // seconds

    func setActive(_ active: Bool) {
        self.desiredActive = active
        if active {
            self.startIfNeeded()
        } else {
            self.stop()
        }
    }

    func startIfNeeded() {
        guard self.execution == nil, self.desiredActive else { return }
        if self.shouldGiveUpAfterCrashes() {
            self.status = .failed("Too many crashes; giving up")
            return
        }
        self.status = self.status == .restarting ? .restarting : .starting
        Task.detached { [weak self] in
            guard let self else { return }
            await self.spawnRelay()
        }
    }

    func stop() {
        self.desiredActive = false
        self.stopping = true
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

    // MARK: - Internals

    private func spawnRelay() async {
        let command = self.resolveCommand()
        self.appendLog("[relay] starting: \(command.joined(separator: " "))\n")

        do {
            let result = try await run(
                .name(command.first ?? "clawdis"),
                arguments: Arguments(Array(command.dropFirst())),
                environment: self.makeEnvironment(),
                workingDirectory: nil
            ) { execution, stdin, stdout, stderr in
                self.didStart(execution)
                async let out: Void = self.stream(output: stdout, label: "stdout")
                async let err: Void = self.stream(output: stderr, label: "stderr")
                try await stdin.finish()
                await out
                await err
            }

            await self.handleTermination(status: result.terminationStatus)
        } catch {
            await self.handleError(error)
        }
    }

    private func didStart(_ execution: Execution) {
        self.execution = execution
        self.stopping = false
        self.status = .running(pid: execution.processIdentifier.value)
        self.logger.info("relay started pid \(execution.processIdentifier.value)")
    }

    private func handleTermination(status: TerminationStatus) async {
        let code: Int32 = {
            switch status {
            case let .exited(exitCode): return exitCode
            case let .unhandledException(sig): return -Int32(sig)
            }
        }()

        self.execution = nil
        if self.stopping || !self.desiredActive {
            self.status = .stopped
            self.stopping = false
            return
        }

        self.recentCrashes.append(Date())
        self.recentCrashes = self.recentCrashes.filter { Date().timeIntervalSince($0) < self.crashWindow }
        self.restartCount += 1
        self.appendLog("[relay] exited (\(code)).\n")

        if self.shouldGiveUpAfterCrashes() {
            self.status = .failed("Too many crashes; stopped auto-restart.")
            self.logger.error("relay crash loop detected; giving up")
            return
        }

        self.status = .restarting
        self.logger.warning("relay crashed (code \(code)); restarting")
        try? await Task.sleep(nanoseconds: 750_000_000)
        self.startIfNeeded()
    }

    private func handleError(_ error: any Error) async {
        self.execution = nil
        var message = error.localizedDescription
        if let sp = error as? SubprocessError {
            message = "SubprocessError \(sp.code.value): \(sp)"
        }
        self.appendLog("[relay] failed: \(message)\n")
        self.logger.error("relay failed: \(message, privacy: .public)")
        if self.desiredActive && !self.shouldGiveUpAfterCrashes() {
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
                self.appendLog("[relay \(label)] stream error: \(error.localizedDescription)\n")
            }
        }
    }

    private func appendLog(_ chunk: String) {
        self.log.append(chunk)
        if self.log.count > self.logLimit {
            self.log = String(self.log.suffix(self.logLimit))
        }
    }

    private func resolveCommand() -> [String] {
        // Keep it simple: rely on system-installed clawdis/warelay.
        // Default to `clawdis relay`; users can provide an override via env if needed.
        if let override = ProcessInfo.processInfo.environment["CLAWDIS_RELAY_CMD"],
           !override.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return override.split(separator: " ").map(String.init)
        }

        if let clawdisPath = self.findExecutable(named: "clawdis") {
            return [clawdisPath, "relay"]
        }
        if let pnpm = self.findExecutable(named: "pnpm") {
            return [pnpm, "clawdis", "relay"]
        }
        if let node = self.findExecutable(named: "node") {
            let warelay = self.defaultProjectRoot().appendingPathComponent("bin/warelay.js").path
            if FileManager.default.isReadableFile(atPath: warelay) {
                return [node, warelay, "relay"]
            }
        }
        return ["clawdis", "relay"]
    }

    private func makeEnvironment() -> Environment {
        let merged = self.preferredPaths().joined(separator: ":")
        return .inherit.updating(["PATH": merged])
    }

    private func preferredPaths() -> [String] {
        let current = ProcessInfo.processInfo.environment["PATH"]?
            .split(separator: ":").map(String.init) ?? []
        let extras = [
            self.defaultProjectRoot().appendingPathComponent("node_modules/.bin").path,
            FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/pnpm").path,
            "/opt/homebrew/bin",
            "/usr/local/bin",
            "/usr/bin",
            "/bin",
        ]
        var seen = Set<String>()
        return (extras + current).filter { seen.insert($0).inserted }
    }

    private func findExecutable(named name: String) -> String? {
        for dir in self.preferredPaths() {
            let candidate = (dir as NSString).appendingPathComponent(name)
            if FileManager.default.isExecutableFile(atPath: candidate) {
                return candidate
            }
        }
        return nil
    }

    private func defaultProjectRoot() -> URL {
        let home = FileManager.default.homeDirectoryForCurrentUser
        let candidate = home.appendingPathComponent("Projects/clawdis")
        if FileManager.default.fileExists(atPath: candidate.path) {
            return candidate
        }
        return home
    }
}
