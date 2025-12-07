import Foundation
import OSLog

actor AgentRPC {
    static let shared = AgentRPC()

    private var process: Process?
    private var stdinHandle: FileHandle?
    private var stdoutHandle: FileHandle?
    private var buffer = Data()
    private var waiters: [CheckedContinuation<String, Error>] = []
    private let logger = Logger(subsystem: "com.steipete.clawdis", category: "agent.rpc")

    private struct RpcError: Error { let message: String }

    func send(
        text: String,
        thinking: String?,
        session: String,
        deliver: Bool,
        to: String?) async -> (ok: Bool, text: String?, error: String?)
    {
        guard process?.isRunning == true else {
            return (false, nil, "rpc worker not running")
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
                       let txt = first["text"] as? String {
                        return (true, txt, nil)
                    }
                    return (true, nil, nil)
                }
            }
            if let err = parsed["error"] as? String {
                return (false, nil, err)
            }
            return (false, nil, "rpc returned unexpected response")
        } catch {
            logger.error("rpc send failed: \(error.localizedDescription, privacy: .public)")
            await stop()
            return (false, nil, error.localizedDescription)
        }
    }

    func status() async -> (ok: Bool, error: String?) {
        guard process?.isRunning == true else {
            return (false, "rpc worker not running")
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
            return (false, parsed?["error"] as? String ?? "rpc status failed")
        } catch {
            logger.error("rpc status failed: \(error.localizedDescription, privacy: .public)")
            await stop()
            return (false, error.localizedDescription)
        }
    }

    func setHeartbeatsEnabled(_ enabled: Bool) async -> Bool {
        guard process?.isRunning == true else { return false }
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
            logger.error("rpc set-heartbeats failed: \(error.localizedDescription, privacy: .public)")
            await stop()
            return false
        }
    }

    // MARK: - Process lifecycle

    func start() async throws {
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
            process.waitUntilExit()
            await self?.stop()
        }
    }

    private func stop() async {
        stdoutHandle?.readabilityHandler = nil
        process?.terminate()
        process = nil
        stdinHandle = nil
        stdoutHandle = nil
        buffer.removeAll(keepingCapacity: false)
        let waiters = self.waiters
        self.waiters.removeAll()
        for waiter in waiters {
            waiter.resume(throwing: RpcError(message: "rpc process stopped"))
        }
    }

    private func ingest(data: Data) {
        buffer.append(data)
        while let range = buffer.firstRange(of: Data([0x0A])) {
            let lineData = buffer.subdata(in: buffer.startIndex..<range.lowerBound)
            buffer.removeSubrange(buffer.startIndex...range.lowerBound)
            guard let line = String(data: lineData, encoding: .utf8) else { continue }
            if let waiter = waiters.first {
                waiters.removeFirst()
                waiter.resume(returning: line)
            }
        }
    }

    private func nextLine() async throws -> String {
        try await withCheckedThrowingContinuation { (cont: CheckedContinuation<String, Error>) in
            waiters.append(cont)
        }
    }
}
