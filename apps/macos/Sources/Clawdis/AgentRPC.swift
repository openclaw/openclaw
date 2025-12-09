import Foundation
import Darwin
import OSLog

struct ControlRequestParams: @unchecked Sendable {
    let raw: [String: AnyHashable]
}

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

    static let heartbeatNotification = Notification.Name("clawdis.rpc.heartbeat")
    static let agentEventNotification = Notification.Name("clawdis.rpc.agent")

    private struct ControlResponse: Decodable {
        let type: String
        let id: String
        let ok: Bool
        let payload: AnyCodable?
        let error: String?
    }

    struct AnyCodable: Codable {
        let value: Any

        init(_ value: Any) { self.value = value }

        init(from decoder: Decoder) throws {
            let container = try decoder.singleValueContainer()
            if let intVal = try? container.decode(Int.self) { self.value = intVal; return }
            if let doubleVal = try? container.decode(Double.self) { self.value = doubleVal; return }
            if let boolVal = try? container.decode(Bool.self) { self.value = boolVal; return }
            if let stringVal = try? container.decode(String.self) { self.value = stringVal; return }
            if container.decodeNil() { self.value = NSNull(); return }
            if let dict = try? container.decode([String: AnyCodable].self) { self.value = dict; return }
            if let array = try? container.decode([AnyCodable].self) { self.value = array; return }
            throw DecodingError.dataCorruptedError(in: container, debugDescription: "Unsupported type")
        }

        func encode(to encoder: Encoder) throws {
            var container = encoder.singleValueContainer()
            switch self.value {
            case let intVal as Int: try container.encode(intVal)
            case let doubleVal as Double: try container.encode(doubleVal)
            case let boolVal as Bool: try container.encode(boolVal)
            case let stringVal as String: try container.encode(stringVal)
            case is NSNull: try container.encodeNil()
            case let dict as [String: AnyCodable]: try container.encode(dict)
            case let array as [AnyCodable]: try container.encode(array)
            default:
                let context = EncodingError.Context(
                    codingPath: encoder.codingPath,
                    debugDescription: "Unsupported type")
                throw EncodingError.invalidValue(self.value, context)
            }
        }
    }

    private var process: Process?
    private var stdinHandle: FileHandle?
    private var stdoutHandle: FileHandle?
    private var buffer = Data()
    private var waiters: [CheckedContinuation<String, Error>] = []
    private var controlWaiters: [String: CheckedContinuation<Data, Error>] = [:]
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

    func controlRequest(method: String, params: ControlRequestParams? = nil) async throws -> Data {
        if self.process?.isRunning != true {
            try await self.start()
        }
        let id = UUID().uuidString
        var frame: [String: Any] = ["type": "control-request", "id": id, "method": method]
        if let params { frame["params"] = params.raw }
        let data = try JSONSerialization.data(withJSONObject: frame)
        guard let stdinHandle else { throw RpcError(message: "stdin missing") }
        return try await withCheckedThrowingContinuation { (cont: CheckedContinuation<Data, Error>) in
            self.controlWaiters[id] = cont
            stdinHandle.write(data)
            stdinHandle.write(Data([0x0A]))
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

    func shutdown() async {
        await self.stop()
    }

    private func stop() async {
        self.stdoutHandle?.readabilityHandler = nil
        let proc = self.process
        proc?.terminate()
        if let proc, proc.isRunning {
            try? await Task.sleep(nanoseconds: 700_000_000)
            if proc.isRunning {
                kill(proc.processIdentifier, SIGKILL)
            }
        }
        proc?.waitUntilExit()
        self.process = nil
        self.stdinHandle = nil
        self.stdoutHandle = nil
        self.buffer.removeAll(keepingCapacity: false)
        let waiters = self.waiters
        self.waiters.removeAll()
        for waiter in waiters {
            waiter.resume(throwing: RpcError(message: "rpc process stopped"))
        }
        let control = self.controlWaiters
        self.controlWaiters.removeAll()
        for (_, waiter) in control {
            waiter.resume(throwing: RpcError(message: "rpc process stopped"))
        }
    }

    private func ingest(data: Data) {
        self.buffer.append(data)
        while let range = buffer.firstRange(of: Data([0x0A])) {
            let lineData = self.buffer.subdata(in: self.buffer.startIndex..<range.lowerBound)
            self.buffer.removeSubrange(self.buffer.startIndex...range.lowerBound)
            guard let line = String(data: lineData, encoding: .utf8) else { continue }

            // Event frames are pushed without request/response pairing (e.g., heartbeats/agent).
            if self.handleEventLine(line) {
                continue
            }
            if self.handleControlResponse(line) {
                continue
            }
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

    private func parseAgentEvent(from line: String) -> ControlAgentEvent? {
        guard let data = line.data(using: .utf8) else { return nil }
        guard
            let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
            let type = obj["type"] as? String,
            type == "event",
            let evt = obj["event"] as? String,
            evt == "agent",
            let payload = obj["payload"]
        else {
            return nil
        }

        guard let payloadData = try? JSONSerialization.data(withJSONObject: payload) else { return nil }
        return try? JSONDecoder().decode(ControlAgentEvent.self, from: payloadData)
    }

    private func handleEventLine(_ line: String) -> Bool {
        if let hb = self.parseHeartbeatEvent(from: line) {
            DispatchQueue.main.async {
                NotificationCenter.default.post(name: Self.heartbeatNotification, object: hb)
                NotificationCenter.default.post(name: .controlHeartbeat, object: hb)
            }
            return true
        }
        if let agent = self.parseAgentEvent(from: line) {
            DispatchQueue.main.async {
                NotificationCenter.default.post(name: Self.agentEventNotification, object: agent)
                NotificationCenter.default.post(name: .controlAgentEvent, object: agent)
            }
            return true
        }
        return false
    }

    private func handleControlResponse(_ line: String) -> Bool {
        guard let data = line.data(using: .utf8) else { return false }
        guard let parsed = try? JSONDecoder().decode(ControlResponse.self, from: data) else { return false }
        guard parsed.type == "control-response" else { return false }
        self.logger.debug("control response parsed id=\(parsed.id, privacy: .public) ok=\(parsed.ok, privacy: .public)")
        guard let waiter = self.controlWaiters.removeValue(forKey: parsed.id) else {
            self.logger.debug("control response with no waiter id=\(parsed.id, privacy: .public)")
            return true
        }
        if parsed.ok {
            let payloadData: Data = if let payload = parsed.payload {
                (try? JSONEncoder().encode(payload)) ?? Data()
            } else {
                Data()
            }
            waiter.resume(returning: payloadData)
        } else {
            waiter.resume(throwing: RpcError(message: parsed.error ?? "control error"))
        }
        return true
    }

    private func nextLine() async throws -> String {
        try await withCheckedThrowingContinuation { (cont: CheckedContinuation<String, Error>) in
            self.waiters.append(cont)
        }
    }
}
