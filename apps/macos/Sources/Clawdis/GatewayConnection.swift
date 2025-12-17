import ClawdisProtocol
import Foundation
import OSLog

/// Single, shared Gateway websocket connection for the whole app.
///
/// This owns exactly one `GatewayChannelActor` and reuses it across all callers
/// (ControlChannel, debug actions, SwiftUI WebChat, etc.).
actor GatewayConnection {
    static let shared = GatewayConnection()

    typealias Config = (url: URL, token: String?)

    private let configProvider: @Sendable () async throws -> Config
    private let sessionBox: WebSocketSessionBox?

    private var client: GatewayChannelActor?
    private var configuredURL: URL?
    private var configuredToken: String?

    private var subscribers: [UUID: AsyncStream<GatewayPush>.Continuation] = [:]
    private var lastSnapshot: HelloOk?

    init(
        configProvider: @escaping @Sendable () async throws -> Config = GatewayConnection.defaultConfigProvider,
        sessionBox: WebSocketSessionBox? = nil)
    {
        self.configProvider = configProvider
        self.sessionBox = sessionBox
    }

    func request(
        method: String,
        params: [String: AnyCodable]?,
        timeoutMs: Double? = nil) async throws -> Data
    {
        let cfg = try await self.configProvider()
        await self.configure(url: cfg.url, token: cfg.token)
        guard let client else {
            throw NSError(domain: "Gateway", code: 0, userInfo: [NSLocalizedDescriptionKey: "gateway not configured"])
        }
        return try await client.request(method: method, params: params, timeoutMs: timeoutMs)
    }

    /// Ensure the underlying socket is configured (and replaced if config changed).
    func refresh() async throws {
        let cfg = try await self.configProvider()
        await self.configure(url: cfg.url, token: cfg.token)
    }

    func shutdown() async {
        if let client {
            await client.shutdown()
        }
        self.client = nil
        self.configuredURL = nil
        self.configuredToken = nil
        self.lastSnapshot = nil
    }

    func subscribe(bufferingNewest: Int = 100) -> AsyncStream<GatewayPush> {
        let id = UUID()
        let snapshot = self.lastSnapshot
        let connection = self
        return AsyncStream(bufferingPolicy: .bufferingNewest(bufferingNewest)) { continuation in
            if let snapshot {
                continuation.yield(.snapshot(snapshot))
            }
            self.subscribers[id] = continuation
            continuation.onTermination = { @Sendable _ in
                Task { await connection.removeSubscriber(id) }
            }
        }
    }

    private func removeSubscriber(_ id: UUID) {
        self.subscribers[id] = nil
    }

    private func broadcast(_ push: GatewayPush) {
        if case let .snapshot(snapshot) = push {
            self.lastSnapshot = snapshot
        }
        for (_, continuation) in self.subscribers {
            continuation.yield(push)
        }
    }

    private func configure(url: URL, token: String?) async {
        if self.client != nil, self.configuredURL == url, self.configuredToken == token {
            return
        }
        if let client {
            await client.shutdown()
        }
        self.lastSnapshot = nil
        self.client = GatewayChannelActor(
            url: url,
            token: token,
            session: self.sessionBox,
            pushHandler: { [weak self] push in
                await self?.handle(push: push)
            })
        self.configuredURL = url
        self.configuredToken = token
    }

    private func handle(push: GatewayPush) {
        self.broadcast(push)
    }

    private static func defaultConfigProvider() async throws -> Config {
        try await GatewayEndpointStore.shared.requireConfig()
    }
}

private let gatewayControlLogger = Logger(subsystem: "com.steipete.clawdis", category: "gateway.control")

extension GatewayConnection {
    private static func wrapParams(_ raw: [String: Any]?) -> [String: AnyCodable]? {
        guard let raw else { return nil }
        return raw.reduce(into: [String: AnyCodable]()) { acc, pair in
            acc[pair.key] = AnyCodable(pair.value)
        }
    }

    func controlRequest(
        method: String,
        params: [String: Any]? = nil,
        timeoutMs: Double? = nil) async throws -> Data
    {
        try await self.request(method: method, params: Self.wrapParams(params), timeoutMs: timeoutMs)
    }

    func status() async -> (ok: Bool, error: String?) {
        do {
            let data = try await self.controlRequest(method: "status")
            if let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
               (obj["ok"] as? Bool) ?? true
            {
                return (true, nil)
            }
            return (false, "status error")
        } catch {
            return (false, error.localizedDescription)
        }
    }

    func setHeartbeatsEnabled(_ enabled: Bool) async -> Bool {
        do {
            _ = try await self.controlRequest(method: "set-heartbeats", params: ["enabled": enabled])
            return true
        } catch {
            gatewayControlLogger.error("setHeartbeatsEnabled failed \(error.localizedDescription, privacy: .public)")
            return false
        }
    }

    func sendAgent(
        message: String,
        thinking: String?,
        sessionKey: String,
        deliver: Bool,
        to: String?,
        channel: String? = nil,
        idempotencyKey: String = UUID().uuidString) async -> (ok: Bool, error: String?)
    {
        do {
            let params: [String: Any] = [
                "message": message,
                "sessionKey": sessionKey,
                "thinking": thinking ?? "default",
                "deliver": deliver,
                "to": to ?? "",
                "channel": channel ?? "",
                "idempotencyKey": idempotencyKey,
            ]
            _ = try await self.controlRequest(method: "agent", params: params)
            return (true, nil)
        } catch {
            return (false, error.localizedDescription)
        }
    }
}
