import Foundation
import OSLog

struct GatewayEvent: Codable {
    let type: String
    let event: String?
    let payload: AnyCodable?
    let seq: Int?
}

extension Notification.Name {
    static let gatewaySnapshot = Notification.Name("clawdis.gateway.snapshot")
    static let gatewayEvent = Notification.Name("clawdis.gateway.event")
    static let gatewaySeqGap = Notification.Name("clawdis.gateway.seqgap")
}

private actor GatewayChannelActor {
    private let logger = Logger(subsystem: "com.steipete.clawdis", category: "gateway")
    private var task: URLSessionWebSocketTask?
    private var pending: [String: CheckedContinuation<Data, Error>] = [:]
    private var connected = false
    private var url: URL
    private var token: String?
    private let session = URLSession(configuration: .default)
    private var backoffMs: Double = 500
    private var shouldReconnect = true
    private var lastSeq: Int?

    init(url: URL, token: String?) {
        self.url = url
        self.token = token
    }

    func connect() async throws {
        if connected, task?.state == .running { return }
        task?.cancel(with: .goingAway, reason: nil)
        task = session.webSocketTask(with: url)
        task?.resume()
        try await sendHello()
        listen()
        connected = true
        backoffMs = 500
        lastSeq = nil
    }

    private func sendHello() async throws {
        let hello: [String: Any] = [
            "type": "hello",
            "minProtocol": 1,
            "maxProtocol": 1,
            "client": [
                "name": "clawdis-mac",
                "version": Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "dev",
                "platform": "macos",
                "mode": "app",
                "instanceId": Host.current().localizedName ?? UUID().uuidString,
            ],
            "caps": [],
            "auth": token != nil ? ["token": token!] : [:],
        ]
        let data = try JSONSerialization.data(withJSONObject: hello)
        try await task?.send(.data(data))
        // wait for hello-ok
        if let msg = try await task?.receive() {
            if try await handleHelloResponse(msg) { return }
        }
        throw NSError(domain: "Gateway", code: 1, userInfo: [NSLocalizedDescriptionKey: "hello failed"])
    }

    private func handleHelloResponse(_ msg: URLSessionWebSocketTask.Message) async throws -> Bool {
        let data: Data?
        switch msg {
        case .data(let d): data = d
        case .string(let s): data = s.data(using: .utf8)
        @unknown default: data = nil
        }
        guard let data else { return false }
        guard let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let type = obj["type"] as? String else { return false }
        if type == "hello-ok" {
            NotificationCenter.default.post(name: .gatewaySnapshot, object: nil, userInfo: obj)
            return true
        }
        return false
    }

    private func listen() {
        task?.receive { [weak self] result in
            guard let self else { return }
            switch result {
            case .failure(let err):
                self.logger.error("gateway ws receive failed \(err.localizedDescription, privacy: .public)")
                self.connected = false
                self.scheduleReconnect()
            case .success(let msg):
                Task { await self.handle(msg) }
                self.listen()
            }
        }
    }

    private func handle(_ msg: URLSessionWebSocketTask.Message) async {
        let data: Data?
        switch msg {
        case .data(let d): data = d
        case .string(let s): data = s.data(using: .utf8)
        @unknown default: data = nil
        }
        guard let data else { return }
        guard let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let type = obj["type"] as? String else { return }
        switch type {
        case "res":
            if let id = obj["id"] as? String, let waiter = pending.removeValue(forKey: id) {
                waiter.resume(returning: data)
            }
        case "event":
            if let seq = obj["seq"] as? Int {
                if let last = lastSeq, seq > last + 1 {
                    NotificationCenter.default.post(
                        name: .gatewaySeqGap,
                        object: nil,
                        userInfo: ["expected": last + 1, "received": seq]
                    )
                }
                lastSeq = seq
            }
            NotificationCenter.default.post(name: .gatewayEvent, object: nil, userInfo: obj)
        case "hello-ok":
            NotificationCenter.default.post(name: .gatewaySnapshot, object: nil, userInfo: obj)
        default:
            break
        }
    }

    private func scheduleReconnect() {
        guard shouldReconnect else { return }
        let delay = backoffMs / 1000
        backoffMs = min(backoffMs * 2, 30_000)
        Task.detached { [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000))
            guard let self else { return }
            do {
                try await self.connect()
            } catch {
                self.logger.error("gateway reconnect failed \(error.localizedDescription, privacy: .public)")
                self.scheduleReconnect()
            }
        }
    }

    func request(method: String, params: [String: Any]?) async throws -> Data {
        try await connect()
        let id = UUID().uuidString
        let frame: [String: Any] = [
            "type": "req",
            "id": id,
            "method": method,
            "params": params ?? [:],
        ]
        let data = try JSONSerialization.data(withJSONObject: frame)
        let response = try await withCheckedThrowingContinuation { (cont: CheckedContinuation<Data, Error>) in
            pending[id] = cont
            Task {
                do {
                    try await task?.send(.data(data))
                } catch {
                    pending.removeValue(forKey: id)
                    cont.resume(throwing: error)
                }
            }
        }
        return response
    }
}

actor GatewayChannel {
    private var inner: GatewayChannelActor?

    func configure(url: URL, token: String?) {
        inner = GatewayChannelActor(url: url, token: token)
    }

    func request(method: String, params: [String: Any]?) async throws -> Data {
        guard let inner else {
            throw NSError(domain: "Gateway", code: 0, userInfo: [NSLocalizedDescriptionKey: "not configured"])
        }
        return try await inner.request(method: method, params: params)
    }
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
            let ctx = EncodingError.Context(codingPath: encoder.codingPath, debugDescription: "Unsupported type")
            throw EncodingError.invalidValue(self.value, ctx)
        }
    }
}
