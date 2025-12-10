import Foundation
import OSLog

actor PortGuardian {
    static let shared = PortGuardian()

    struct Record: Codable {
        let port: Int
        let pid: Int32
        let command: String
        let mode: String
        let timestamp: TimeInterval
    }

    private var records: [Record] = []
    private let logger = Logger(subsystem: "com.steipete.clawdis", category: "portguard")
    nonisolated private static let appSupportDir: URL = {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first!
        return base.appendingPathComponent("Clawdis", isDirectory: true)
    }()
    nonisolated private static var recordPath: URL {
        self.appSupportDir.appendingPathComponent("port-guard.json", isDirectory: false)
    }

    init() {
        self.records = Self.loadRecords(from: Self.recordPath)
    }

    func sweep(mode: AppState.ConnectionMode) async {
        self.logger.info("port sweep starting (mode=\(mode.rawValue, privacy: .public))")
        let ports = [18788, 18789]
        for port in ports {
            let listeners = await self.listeners(on: port)
            guard !listeners.isEmpty else { continue }
            for listener in listeners {
                if self.isExpected(listener, port: port, mode: mode) {
                    self.logger.info("port \(port, privacy: .public) already served by expected \(listener.command, privacy: .public) (pid \(listener.pid)) — keeping")
                    continue
                }
                let killed = await self.kill(listener.pid)
                if killed {
                    self.logger.error("port \(port, privacy: .public) was held by \(listener.command, privacy: .public) (pid \(listener.pid)); terminated")
                } else {
                    self.logger.error("failed to terminate pid \(listener.pid) on port \(port, privacy: .public)")
                }
            }
        }
        self.logger.info("port sweep done")
    }

    func record(port: Int, pid: Int32, command: String, mode: AppState.ConnectionMode) async {
        try? FileManager.default.createDirectory(at: Self.appSupportDir, withIntermediateDirectories: true)
        self.records.removeAll { $0.pid == pid }
        self.records.append(Record(port: port, pid: pid, command: command, mode: mode.rawValue, timestamp: Date().timeIntervalSince1970))
        self.save()
    }

    func removeRecord(pid: Int32) {
        let before = self.records.count
        self.records.removeAll { $0.pid == pid }
        if self.records.count != before {
            self.save()
        }
    }

    // MARK: - Internals

    private struct Listener {
        let pid: Int32
        let command: String
        let user: String?
    }

    private func listeners(on port: Int) async -> [Listener] {
        let res = await ShellExecutor.run(
            command: ["lsof", "-nP", "-iTCP:\(port)", "-sTCP:LISTEN", "-Fpcn"],
            cwd: nil,
            env: nil,
            timeout: 5)
        guard res.ok, let data = res.payload, !data.isEmpty else { return [] }
        let text = String(data: data, encoding: .utf8) ?? ""
        var listeners: [Listener] = []
        var currentPid: Int32?
        var currentCmd: String?
        var currentUser: String?

        func flush() {
            if let pid = currentPid, let cmd = currentCmd {
                listeners.append(Listener(pid: pid, command: cmd, user: currentUser))
            }
            currentPid = nil
            currentCmd = nil
            currentUser = nil
        }

        for line in text.split(separator: "\n") {
            guard let prefix = line.first else { continue }
            let value = String(line.dropFirst())
            switch prefix {
            case "p":
                flush()
                currentPid = Int32(value) ?? 0
            case "c":
                currentCmd = value
            case "u":
                currentUser = value
            default:
                continue
            }
        }
        flush()
        return listeners
    }

    private func kill(_ pid: Int32) async -> Bool {
        let term = await ShellExecutor.run(command: ["kill", "-TERM", "\(pid)"], cwd: nil, env: nil, timeout: 2)
        if term.ok { return true }
        let sigkill = await ShellExecutor.run(command: ["kill", "-KILL", "\(pid)"], cwd: nil, env: nil, timeout: 2)
        return sigkill.ok
    }

    private func isExpected(_ listener: Listener, port: Int, mode: AppState.ConnectionMode) -> Bool {
        let cmd = listener.command.lowercased()
        switch mode {
        case .remote:
            if port == 18788 {
                return cmd.contains("ssh") && cmd.contains("18788")
            }
            return false
        case .local:
            return cmd.contains("node") || cmd.contains("clawdis") || cmd.contains("tsx") || cmd.contains("pnpm") || cmd.contains("bun")
        }
    }

    private static func loadRecords(from url: URL) -> [Record] {
        guard let data = try? Data(contentsOf: url),
              let decoded = try? JSONDecoder().decode([Record].self, from: data)
        else { return [] }
        return decoded
    }

    private func save() {
        guard let data = try? JSONEncoder().encode(self.records) else { return }
        try? data.write(to: Self.recordPath, options: [.atomic])
    }
}
