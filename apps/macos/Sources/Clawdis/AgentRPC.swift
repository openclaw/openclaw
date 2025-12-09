import Foundation
import OSLog

actor AgentRPC {
    static let shared = AgentRPC()

    struct HeartbeatEvent: Codable {
        let ts: Double
        let status: String
        let to: String?
        let preview: String?
        let durationMs: Double?
        let hasMedia: Bool?
        let reason: String?
    }

    struct JobStateEvent: Codable {
        let id: String
        let state: String
        let durationMs: Double?
    }

    static let heartbeatNotification = Notification.Name("clawdis.rpc.heartbeat")

    private var process: Process?
    private var stdinHandle: FileHandle?
    private var stdoutHandle: FileHandle?
    private var buffer = Data()
    private var waiters: [CheckedContinuation<String, Error>] = []
    private let logger = Logger(subsystem: "com.steipete.clawdis", category: "agent.rpc")
    private var starting = false

    private struct RpcError: Error { let message: String }

    func send(
        text: String,
        thinking: String?,
        session: String,
        deliver: Bool,
        to: String?) async -> (ok: Bool, text: String?, error: String?)
    {
        if self.process?.isRunning != true {
            do {
                try await self.start()
            } catch {
                return (false, nil, "rpc worker not running: \(error.localizedDescription)")
            }
        }
        do {
            var payload: [String: Any] = [
                "type": "send",
                "text": text,
                "session": session,
                "thinking": thinking ?? "default",
                "deliver": deliver,
            ]
            if let to { payload["to"] = to }
            let data = try JSONSerialization.data(withJSONObject: payload)
            guard let stdinHandle else { throw RpcError(message: "stdin missing") }
            stdinHandle.write(data)
            stdinHandle.write(Data([0x0A]))

            let line = try await nextLine()
            let parsed = try JSONSerialization.jsonObject(with: Data(line.utf8)) as? [String: Any]
            guard let parsed else { throw RpcError(message: "invalid JSON") }

            if let ok = parsed["ok"] as? Bool, let type = parsed["type"] as? String, type == "result" {
                if ok {
                    if let payloadDict = parsed["payload"] as? [String: Any],
                       let payloads = payloadDict["payloads"] as? [[String: Any]],
                       let first = payloads.first,
                       let txt = first["text"] as? String
                    {
                        return (true, txt, nil)
                    }
                    return (true, nil, nil)
                }
            }
            if let err = parsed["error"] as? String {
                return (false, nil, err)
            }
            return (false, nil, "rpc returned unexpected response: \(line)")
        } catch {
            self.logger.error("rpc send failed: \(error.localizedDescription, privacy: .public)")
            await self.stop()
            return (false, nil, error.localizedDescription)
        }
    }

    func status() async -> (ok: Bool, error: String?) {
        if self.process?.isRunning != true {
            do {
                try await self.start()
            } catch {
                return (false, "rpc worker not running: \(error.localizedDescription)")
            }
        }
        do {
            let payload: [String: Any] = ["type": "status"]
            let data = try JSONSerialization.data(withJSONObject: payload)
            guard let stdinHandle else { throw RpcError(message: "stdin missing") }
            stdinHandle.write(data)
            stdinHandle.write(Data([0x0A]))

            let line = try await nextLine()
            let parsed = try JSONSerialization.jsonObject(with: Data(line.utf8)) as? [String: Any]
            if let ok = parsed?["ok"] as? Bool, ok { return (true, nil) }
            return (false, parsed?["error"] as? String ?? "rpc status failed: \(line)")
        } catch {
            self.logger.error("rpc status failed: \(error.localizedDescription, privacy: .public)")
            await self.stop()
            return (false, error.localizedDescription)
        }
    }

    func setHeartbeatsEnabled(_ enabled: Bool) async -> Bool {
        guard self.process?.isRunning == true else { return false }
        do {
            let payload: [String: Any] = ["type": "set-heartbeats", "enabled": enabled]
            let data = try JSONSerialization.data(withJSONObject: payload)
            guard let stdinHandle else { throw RpcError(message: "stdin missing") }
            stdinHandle.write(data)
            stdinHandle.write(Data([0x0A]))

            let line = try await nextLine()
            let parsed = try JSONSerialization.jsonObject(with: Data(line.utf8)) as? [String: Any]
            if let ok = parsed?["ok"] as? Bool, ok { return true }
            return false
        } catch {
            self.logger.error("rpc set-heartbeats failed: \(error.localizedDescription, privacy: .public)")
            await self.stop()
            return false
        }
    }

    // MARK: - Process lifecycle

    func start() async throws {
        if self.starting { return }
        self.starting = true
        defer { self.starting = false }
        let process = Process()
        let command = CommandResolver.clawdisCommand(subcommand: "rpc")
        process.executableURL = URL(fileURLWithPath: command.first ?? "/usr/bin/env")
        process.arguments = Array(command.dropFirst())
        process.currentDirectoryURL = URL(fileURLWithPath: CommandResolver.projectRootPath())
        var env = ProcessInfo.processInfo.environment
        env["PATH"] = CommandResolver.preferredPaths().joined(separator: ":")
        process.environment = env

        let stdinPipe = Pipe()
        let stdoutPipe = Pipe()
        process.standardInput = stdinPipe
        process.standardOutput = stdoutPipe
        process.standardError = Pipe()

        try process.run()

        self.process = process
        self.stdinHandle = stdinPipe.fileHandleForWriting
        self.stdoutHandle = stdoutPipe.fileHandleForReading

        stdoutPipe.fileHandleForReading.readabilityHandler = { [weak self] handle in
            guard let self else { return }
            let data = handle.availableData
            if data.isEmpty { return }
            Task { await self.ingest(data: data) }
        }

        Task.detached { [weak self] in
            // Ensure all waiters are failed if the worker dies (e.g., crash or SIGTERM).
            process.waitUntilExit()
            await self?.stop()
        }
    }

    private func stop() async {
        self.stdoutHandle?.readabilityHandler = nil
        self.process?.terminate()
        self.process = nil
        self.stdinHandle = nil
        self.stdoutHandle = nil
        self.buffer.removeAll(keepingCapacity: false)
        let waiters = self.waiters
        self.waiters.removeAll()
        for waiter in waiters {
            waiter.resume(throwing: RpcError(message: "rpc process stopped"))
        }
    }

    private func ingest(data: Data) {
        self.buffer.append(data)
        while let range = buffer.firstRange(of: Data([0x0A])) {
            let lineData = self.buffer.subdata(in: self.buffer.startIndex..<range.lowerBound)
            self.buffer.removeSubrange(self.buffer.startIndex...range.lowerBound)
            guard let line = String(data: lineData, encoding: .utf8) else { continue }

            // Event frames are pushed without request/response pairing (e.g., heartbeats).
            if let event = self.parseHeartbeatEvent(from: line) {
                DispatchQueue.main.async {
                    NotificationCenter.default.post(name: Self.heartbeatNotification, object: event)
                }
                continue
            }
            if self.parseJobStateEvent(from: line) != nil { continue }

            if let waiter = waiters.first {
                self.waiters.removeFirst()
                waiter.resume(returning: line)
            }
        }
    }

    private func parseHeartbeatEvent(from line: String) -> HeartbeatEvent? {
        guard let data = line.data(using: .utf8) else { return nil }
        guard
            let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
            let type = obj["type"] as? String,
            type == "event",
            let evt = obj["event"] as? String,
            evt == "heartbeat",
            let payload = obj["payload"] as? [String: Any]
        else {
            return nil
        }

        let decoder = JSONDecoder()
        guard let payloadData = try? JSONSerialization.data(withJSONObject: payload) else { return nil }
        return try? decoder.decode(HeartbeatEvent.self, from: payloadData)
    }

    private func parseJobStateEvent(from line: String) -> JobStateEvent? {
        guard let data = line.data(using: .utf8) else { return nil }
        guard
            let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
            let type = obj["type"] as? String,
            type == "event",
            let evt = obj["event"] as? String,
            evt == "job-state",
            let payload = obj["payload"] as? [String: Any]
        else {
            return nil
        }

        let decoder = JSONDecoder()
        guard let payloadData = try? JSONSerialization.data(withJSONObject: payload) else { return nil }
        return try? decoder.decode(JobStateEvent.self, from: payloadData)
    }

    private func nextLine() async throws -> String {
        try await withCheckedThrowingContinuation { (cont: CheckedContinuation<String, Error>) in
            self.waiters.append(cont)
        }
    }
}
