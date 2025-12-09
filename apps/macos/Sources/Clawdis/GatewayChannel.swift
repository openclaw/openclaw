import ClawdisProtocol
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
    private var pending: [String: CheckedContinuation<GatewayFrame, Error>] = [:]
    private var connected = false
    private var url: URL
    private var token: String?
    private let session = URLSession(configuration: .default)
    private var backoffMs: Double = 500
    private var shouldReconnect = true
    private var lastSeq: Int?
    private var lastTick: Date?
    private var tickIntervalMs: Double = 30000
    private let decoder = JSONDecoder()
    private let encoder = JSONEncoder()

    init(url: URL, token: String?) {
        self.url = url
        self.token = token
    }

    func connect() async throws {
        if self.connected, self.task?.state == .running { return }
        self.task?.cancel(with: .goingAway, reason: nil)
        self.task = self.session.webSocketTask(with: self.url)
        self.task?.resume()
        do {
            try await self.sendHello()
        } catch {
            let wrapped = self.wrap(error, context: "connect to gateway @ \(self.url.absoluteString)")
            throw wrapped
        }
        self.listen()
        self.connected = true
        self.backoffMs = 500
        self.lastSeq = nil
    }

    private func sendHello() async throws {
        let hello: [String: Any] = [
            "type": "hello",
            "minProtocol": GATEWAY_PROTOCOL_VERSION,
            "maxProtocol": GATEWAY_PROTOCOL_VERSION,
            "client": [
                "name": "clawdis-mac",
                "version": Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "dev",
                "platform": "macos",
                "mode": "app",
                "instanceId": Host.current().localizedName ?? UUID().uuidString,
            ],
            "caps": [],
            "auth": self.token != nil ? ["token": self.token!] : [:],
        ]
        let data = try JSONSerialization.data(withJSONObject: hello)
        try await self.task?.send(.data(data))
        // wait for hello-ok
        if let msg = try await task?.receive() {
            if try await self.handleHelloResponse(msg) { return }
        }
        throw NSError(domain: "Gateway", code: 1, userInfo: [NSLocalizedDescriptionKey: "hello failed"])
    }

    private func handleHelloResponse(_ msg: URLSessionWebSocketTask.Message) async throws -> Bool {
        let data: Data? = switch msg {
        case let .data(d): d
        case let .string(s): s.data(using: .utf8)
        @unknown default: nil
        }
        guard let data else { return false }
        guard let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let type = obj["type"] as? String else { return false }
        if type == "hello-ok" {
            if let policy = obj["policy"] as? [String: Any],
               let tick = policy["tickIntervalMs"] as? Double
            {
                self.tickIntervalMs = tick
            }
            self.lastTick = Date()
            Task { await self.watchTicks() }
            NotificationCenter.default.post(name: .gatewaySnapshot, object: nil, userInfo: obj)
            return true
        }
        return false
    }

    private func listen() {
        self.task?.receive { [weak self] result in
            guard let self else { return }
            switch result {
            case let .failure(err):
                Task { await self.handleReceiveFailure(err) }
            case let .success(msg):
                Task {
                    await self.handle(msg)
                    await self.listen()
                }
            }
        }
    }

    private func handleReceiveFailure(_ err: Error) async {
        let wrapped = self.wrap(err, context: "gateway receive")
        self.logger.error("gateway ws receive failed \(wrapped.localizedDescription, privacy: .public)")
        self.connected = false
        await self.scheduleReconnect()
    }

    private func handle(_ msg: URLSessionWebSocketTask.Message) async {
        let data: Data? = switch msg {
        case let .data(d): d
        case let .string(s): s.data(using: .utf8)
        @unknown default: nil
        }
        guard let data else { return }
        guard let frame = try? self.decoder.decode(GatewayFrame.self, from: data) else {
            self.logger.error("gateway decode failed")
            return
        }
        switch frame {
        case let .res(res):
            let id = res.id
            if let waiter = pending.removeValue(forKey: id) {
                waiter.resume(returning: .res(res))
            }
        case let .event(evt):
            if let seq = evt.seq {
                if let last = lastSeq, seq > last + 1 {
                    NotificationCenter.default.post(
                        name: .gatewaySeqGap,
                        object: frame,
                        userInfo: ["expected": last + 1, "received": seq])
                }
                self.lastSeq = seq
            }
            if evt.event == "tick" { self.lastTick = Date() }
            NotificationCenter.default.post(name: .gatewayEvent, object: frame)
        case .helloOk:
            self.lastTick = Date()
            NotificationCenter.default.post(name: .gatewaySnapshot, object: frame)
        default:
            break
        }
    }

    private func watchTicks() async {
        let tolerance = self.tickIntervalMs * 2
        while self.connected {
            try? await Task.sleep(nanoseconds: UInt64(tolerance * 1_000_000))
            guard self.connected else { return }
            if let last = self.lastTick {
                let delta = Date().timeIntervalSince(last) * 1000
                if delta > tolerance {
                    self.logger.error("gateway tick missed; reconnecting")
                    self.connected = false
                    await self.scheduleReconnect()
                    return
                }
            }
        }
    }

    private func scheduleReconnect() async {
        guard self.shouldReconnect else { return }
        let delay = self.backoffMs / 1000
        self.backoffMs = min(self.backoffMs * 2, 30000)
        try? await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000))
        do {
            try await self.connect()
        } catch {
            let wrapped = self.wrap(error, context: "gateway reconnect")
            self.logger.error("gateway reconnect failed \(wrapped.localizedDescription, privacy: .public)")
            await self.scheduleReconnect()
        }
    }

    func request(method: String, params: [String: AnyCodable]?) async throws -> Data {
        do {
            try await self.connect()
        } catch {
            throw self.wrap(error, context: "gateway connect")
        }
        let id = UUID().uuidString
        let paramsObject = params?.reduce(into: [String: Any]()) { dict, entry in
            dict[entry.key] = entry.value.value
        } ?? [:]
        let frame: [String: Any] = [
            "type": "req",
            "id": id,
            "method": method,
            "params": paramsObject,
        ]
        let data = try JSONSerialization.data(withJSONObject: frame)
        let response = try await withCheckedThrowingContinuation { (cont: CheckedContinuation<GatewayFrame, Error>) in
            self.pending[id] = cont
            Task {
                do {
                    try await self.task?.send(.data(data))
                } catch {
                    self.pending.removeValue(forKey: id)
                    cont.resume(throwing: self.wrap(error, context: "gateway send \(method)"))
                }
            }
        }
        guard case let .res(res) = response else {
            throw NSError(domain: "Gateway", code: 2, userInfo: [NSLocalizedDescriptionKey: "unexpected frame"])
        }
        if res.ok == false {
            let msg = (res.error?["message"]?.value as? String) ?? "gateway error"
            throw NSError(domain: "Gateway", code: 3, userInfo: [NSLocalizedDescriptionKey: msg])
        }
        if let payload = res.payload?.value {
            if JSONSerialization.isValidJSONObject(payload) {
                let payloadData = try JSONSerialization.data(withJSONObject: payload)
                return payloadData
            }
        }
        return Data()
    }

    // Wrap low-level URLSession/WebSocket errors with context so UI can surface them.
    private func wrap(_ error: Error, context: String) -> Error {
        if let urlError = error as? URLError {
            let desc = urlError.localizedDescription.isEmpty ? "cancelled" : urlError.localizedDescription
            return NSError(
                domain: URLError.errorDomain,
                code: urlError.errorCode,
                userInfo: [NSLocalizedDescriptionKey: "\(context): \(desc)"])
        }
        let ns = error as NSError
        let desc = ns.localizedDescription.isEmpty ? "unknown" : ns.localizedDescription
        return NSError(domain: ns.domain, code: ns.code, userInfo: [NSLocalizedDescriptionKey: "\(context): \(desc)"])
    }
}

actor GatewayChannel {
    private var inner: GatewayChannelActor?

    func configure(url: URL, token: String?) {
        self.inner = GatewayChannelActor(url: url, token: token)
    }

    func request(method: String, params: [String: AnyCodable]?) async throws -> Data {
        guard let inner else {
            throw NSError(domain: "Gateway", code: 0, userInfo: [NSLocalizedDescriptionKey: "not configured"])
        }
        return try await inner.request(method: method, params: params)
    }
}
