import Foundation
import Network
import OSLog
import Darwin

struct ControlHeartbeatEvent: Codable {
    let ts: Double
    let status: String
    let to: String?
    let preview: String?
    let durationMs: Double?
    let hasMedia: Bool?
    let reason: String?
}

struct ControlAgentEvent: Codable, Sendable {
    let runId: String
    let seq: Int
    let stream: String
    let ts: Double
    let data: [String: AnyCodable]
}

extension Notification.Name {
    static let controlAgentEvent = Notification.Name("clawdis.control.agent")
}

struct AnyCodable: Codable, @unchecked Sendable {
    let value: Any

    init(_ value: Any) { self.value = value }

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if let intVal = try? container.decode(Int.self) {
            self.value = intVal; return
        }
        if let doubleVal = try? container.decode(Double.self) {
            self.value = doubleVal; return
        }
        if let boolVal = try? container.decode(Bool.self) {
            self.value = boolVal; return
        }
        if let stringVal = try? container.decode(String.self) {
            self.value = stringVal; return
        }
        if container.decodeNil() {
            self.value = NSNull(); return
        }
        if let dict = try? container.decode([String: AnyCodable].self) {
            self.value = dict; return
        }
        if let array = try? container.decode([AnyCodable].self) {
            self.value = array; return
        }
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
            let context = EncodingError.Context(codingPath: encoder.codingPath, debugDescription: "Unsupported type")
            throw EncodingError.invalidValue(self.value, context)
        }
    }
}

// Handles single-shot continuation resumption without Sendable capture issues
actor ConnectionWaiter {
    private var cont: CheckedContinuation<Void, Error>?
    private var resumed = false
    private var pendingResult: Result<Void, Error>?

    func wait() async throws {
        // Acts like a one-shot Future; if the connection resolves before wait() is called,
        // stash the result so the waiter resumes immediately.
        try await withCheckedThrowingContinuation { (c: CheckedContinuation<Void, Error>) in
            if let pending = pendingResult {
                pendingResult = nil
                resumed = true
                c.resume(with: pending)
            } else {
                cont = c
            }
        }
    }

    func succeed() {
        resume(.success(()))
    }

    func fail(_ error: Error) {
        resume(.failure(error))
    }

    private func resume(_ result: Result<Void, Error>) {
        if resumed { return }
        if let c = cont {
            resumed = true
            cont = nil
            c.resume(with: result)
        } else {
            pendingResult = result
        }
    }
}

struct ControlHealthSnapshot: Codable {
    struct Web: Codable {
        let linked: Bool
        let authAgeMs: Double?
        let connect: Connect?

        struct Connect: Codable {
            let ok: Bool
            let status: Int?
            let error: String?
            let elapsedMs: Double?
        }
    }

    struct Sessions: Codable {
        struct Entry: Codable {
            let key: String
            let updatedAt: Double?
            let age: Double?
        }
        let path: String
        let count: Int
        let recent: [Entry]
    }

    struct IPC: Codable {
        let path: String
        let exists: Bool
    }

    let ts: Double
    let durationMs: Double
    let web: Web
    let heartbeatSeconds: Int
    let sessions: Sessions
    let ipc: IPC
}

enum ControlChannelError: Error, LocalizedError {
    case disconnected
    case badResponse(String)
    case sshFailed(String)

    var errorDescription: String? {
        switch self {
        case .disconnected: return "Control channel disconnected"
        case let .badResponse(msg): return msg
        case let .sshFailed(msg): return "SSH tunnel failed: \(msg)"
        }
    }
}

@MainActor
final class ControlChannel: ObservableObject {
    static let shared = ControlChannel()

    enum Mode: Equatable {
        case local
        case remote(target: String, identity: String)
    }

    enum ConnectionState: Equatable {
        case disconnected
        case connecting
        case connected
        case degraded(String)
    }

    private let logger = Logger(subsystem: "com.steipete.clawdis", category: "control")
    private var connection: NWConnection?
    private var sshProcess: Process?
    private var buffer = Data()
    private var pending: [String: CheckedContinuation<Data, Error>] = [:]
    private var listenTask: Task<Void, Never>?
    private var mode: Mode = .local
    private var localPort: UInt16 = 18789
    private var pingTask: Task<Void, Never>?
    private var jobStates: [String: String] = [:]

    @Published private(set) var state: ConnectionState = .disconnected
    @Published private(set) var lastPingMs: Double?

    func configure(mode: Mode) async throws {
        if mode == self.mode, self.connection != nil { return }
        await self.disconnect()
        self.mode = mode
        try await self.connect()

        NotificationCenter.default.addObserver(
            forName: .controlAgentEvent,
            object: nil,
            queue: .main)
        { note in
            if let evt = note.object as? ControlAgentEvent {
                DispatchQueue.main.async { @MainActor in
                    AgentEventStore.shared.append(evt)
                }
            }
        }
    }

    func disconnect() async {
        self.listenTask?.cancel()
        self.listenTask = nil
        self.pingTask?.cancel()
        self.pingTask = nil
        if let conn = self.connection {
            conn.cancel()
        }
        self.connection = nil
        if let ssh = self.sshProcess, ssh.isRunning { ssh.terminate() }
        self.sshProcess = nil
        for (_, cont) in self.pending {
            cont.resume(throwing: ControlChannelError.disconnected)
        }
        self.pending.removeAll()
        self.state = .disconnected
    }

    func health(timeout: TimeInterval? = nil) async throws -> Data {
        try await self.ensureConnected()
        let start = Date()
        self.logger.debug("health probe start timeout=\(timeout?.description ?? "nil", privacy: .public)")
        let payload = try await self.request(
            method: "health",
            params: timeout.map { ["timeoutMs": Int($0 * 1000)] },
            timeout: timeout.map { $0 + 1 } // small cushion over server-side timeout
        )
        let ms = Int(Date().timeIntervalSince(start) * 1000)
        self.logger.debug("health probe ok in \(ms)ms")
        return payload
    }

    func lastHeartbeat() async throws -> ControlHeartbeatEvent? {
        try await self.ensureConnected()
        let data = try await self.request(method: "last-heartbeat")
        if data.isEmpty { return nil }
        return try? JSONDecoder().decode(ControlHeartbeatEvent.self, from: data)
    }

    private func request(method: String, params: [String: Any]? = nil, timeout: TimeInterval? = nil) async throws -> Data {
        try await self.ensureConnected()
        let id = UUID().uuidString
        var frame: [String: Any] = ["type": "request", "id": id, "method": method]
        if let params { frame["params"] = params }
        let data = try JSONSerialization.data(withJSONObject: frame)
        try await self.send(data)
        return try await withCheckedThrowingContinuation { (cont: CheckedContinuation<Data, Error>) in
            self.pending[id] = cont
            if let timeout {
                Task { [weak self] in
                    try? await Task.sleep(nanoseconds: UInt64(timeout * 1_000_000_000))
                    guard let self else { return }
                    if let pending = self.pending.removeValue(forKey: id) {
                        self.logger.error("control request \(method) timed out after \(Int(timeout))s")
                        pending.resume(throwing: ControlChannelError.badResponse("timeout after \(Int(timeout))s"))
                    }
                }
            }
        }
    }

    private func ensureConnected() async throws {
        if let conn = self.connection {
            switch conn.state {
            case .ready: return
            default: break
            }
        }
        try await self.connect()
    }

    private func connect() async throws {
        switch self.mode {
        case .local:
            self.localPort = 18789
        case let .remote(target, identity):
            self.localPort = try self.startSSHTunnel(target: target, identity: identity)
        }

        self.state = .connecting

        let host = NWEndpoint.Host("127.0.0.1")
        let port = NWEndpoint.Port(rawValue: self.localPort)!
        let conn = NWConnection(host: host, port: port, using: .tcp)
        self.connection = conn

        let waiter = ConnectionWaiter()

        conn.stateUpdateHandler = { [weak self, weak conn] state in
            switch state {
            case .ready:
                Task { @MainActor in self?.state = .connected }
                Task {
                    await waiter.succeed()
                    conn?.stateUpdateHandler = nil
                }
            case let .failed(err):
                Task { @MainActor in self?.state = .degraded(err.localizedDescription) }
                Task {
                    await waiter.fail(err)
                    conn?.stateUpdateHandler = nil
                }
            case let .waiting(err):
                Task { @MainActor in self?.state = .degraded(err.localizedDescription) }
                Task {
                    await waiter.fail(err)
                    conn?.stateUpdateHandler = nil
                }
            default:
                break
            }
        }

        conn.start(queue: .global())
        try await waiter.wait()

        self.listenTask = Task.detached { [weak self] in
            await self?.listen()
        }

        self.pingTask = Task.detached { [weak self] in
            guard let self else { return }
            while !Task.isCancelled {
                do {
                    try await Task.sleep(nanoseconds: 30 * 1_000_000_000)
                    let start = Date()
                    _ = try await self.request(method: "ping")
                    let ms = Date().timeIntervalSince(start) * 1000
                    await MainActor.run { self.lastPingMs = ms; self.state = .connected }
                } catch {
                    await MainActor.run { self.state = .degraded(error.localizedDescription) }
                }
            }
        }
    }

    private func startSSHTunnel(target: String, identity: String) throws -> UInt16 {
        let localPort = Self.pickAvailablePort()
        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: "/usr/bin/ssh")
        var args: [String] = [
            "-o", "BatchMode=yes",
            "-o", "ExitOnForwardFailure=yes",
            "-N", // don't run a remote shell; keep the tunnel open
            "-T", // no pseudo-tty
            "-L", "\(localPort):127.0.0.1:18789",
            target,
        ]
        if !identity.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            args.insert(contentsOf: ["-i", identity], at: 2)
        }
        proc.arguments = args
        proc.standardInput = nil
        let outPipe = Pipe()
        let errPipe = Pipe()
        proc.standardOutput = outPipe
        proc.standardError = errPipe
        try proc.run()
        // Give ssh a brief moment; if it exits immediately we surface stderr instead of silently failing.
        Thread.sleep(forTimeInterval: 0.2) // 200ms
        if !proc.isRunning {
            let err = String(data: errPipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines)
            throw ControlChannelError.sshFailed(err ?? "ssh exited")
        }
        self.sshProcess = proc
        return localPort
    }

    private func send(_ data: Data) async throws {
        guard let conn = self.connection else { throw ControlChannelError.disconnected }
        let line = data + Data([0x0A])
        try await withCheckedThrowingContinuation { (cont: CheckedContinuation<Void, Error>) in
            conn.send(content: line, completion: .contentProcessed { error in
                if let error { cont.resume(throwing: error) }
                else { cont.resume(returning: ()) }
            })
        }
    }

    private func listen() async {
        guard let conn = self.connection else { return }
        while true {
            let result: (Data?, Bool, NWError?) = await withCheckedContinuation { cont in
                conn.receiveMessage { data, _, isComplete, error in
                    cont.resume(returning: (data, isComplete, error))
                }
            }

            let (data, isComplete, error) = result
            if let error {
                self.logger.debug("control receive error: \(error.localizedDescription, privacy: .public)")
                break
            }
            if isComplete {
                self.logger.debug("control receive complete")
                break
            }
            guard let data else { continue }
            self.buffer.append(data)
            while let range = buffer.firstRange(of: Data([0x0A])) {
                let lineData = buffer.subdata(in: buffer.startIndex..<range.lowerBound)
                buffer.removeSubrange(buffer.startIndex...range.lowerBound)
                self.handleLine(lineData)
            }
        }
        // If we exit the loop, drop the connection so the next request reconnects.
        await self.disconnect()
    }

    private func handleLine(_ data: Data) {
        guard let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let type = obj["type"] as? String else { return }

        if type == "event", let event = obj["event"] as? String {
            if event == "heartbeat", let payload = obj["payload"] {
                if let payloadData = try? JSONSerialization.data(withJSONObject: payload) {
                    NotificationCenter.default.post(name: .controlHeartbeat, object: payloadData)
                }
            } else if event == "agent", let payload = obj["payload"] {
                if let payloadData = try? JSONSerialization.data(withJSONObject: payload),
                   let agent = try? JSONDecoder().decode(ControlAgentEvent.self, from: payloadData) {
                    self.handleAgentEvent(agent)
                    NotificationCenter.default.post(name: .controlAgentEvent, object: agent)
                }
            }
            return
        }

        if type == "response", let id = obj["id"] as? String {
            let ok = obj["ok"] as? Bool ?? false
            if ok, let payload = obj["payload"] {
                let payloadData = (try? JSONSerialization.data(withJSONObject: payload)) ?? Data()
                self.pending[id]?.resume(returning: payloadData)
            } else {
                let err = (obj["error"] as? String) ?? "control error"
                self.pending[id]?.resume(throwing: ControlChannelError.badResponse(err))
            }
            self.pending.removeValue(forKey: id)
        }
    }

    private func handleAgentEvent(_ event: ControlAgentEvent) {
        if event.stream == "job" {
            if let state = event.data["state"]?.value as? String {
                let normalized = state.lowercased()
                if normalized == "done" || normalized == "error" {
                    self.jobStates.removeValue(forKey: event.runId)
                } else {
                    self.jobStates[event.runId] = normalized
                }

                let workingStates: Set<String> = ["started", "streaming", "running", "queued", "waiting"]
                let working = self.jobStates.values.contains { workingStates.contains($0) }
                Task { @MainActor in
                    AppStateStore.shared.setWorking(working)
                }
            }
        }
    }

    private static func pickAvailablePort() -> UInt16 {
        var port: UInt16 = 0
        let socket = socket(AF_INET, SOCK_STREAM, 0)
        defer { close(socket) }
        var addr = sockaddr_in()
        addr.sin_family = sa_family_t(AF_INET)
        addr.sin_port = in_port_t(0).bigEndian
        addr.sin_addr = in_addr(s_addr: inet_addr("127.0.0.1"))
        _ = withUnsafePointer(to: &addr) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                bind(socket, $0, socklen_t(MemoryLayout<sockaddr_in>.size))
            }
        }
        var len = socklen_t(MemoryLayout<sockaddr_in>.size)
        getsockname(socket, withUnsafeMutablePointer(to: &addr) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { $0 }
        }, &len)
        // Asking the kernel for port 0 yields an ephemeral free port; reuse it for the SSH tunnel.
        port = UInt16(bigEndian: addr.sin_port)
        return port
    }
}

extension Notification.Name {
    static let controlHeartbeat = Notification.Name("clawdis.control.heartbeat")
}
