import ClawdisProtocol
import Foundation

/// Single, shared Gateway websocket connection for the whole app.
///
/// This owns exactly one `GatewayChannelActor` and reuses it across all callers
/// (ControlChannel, AgentRPC, SwiftUI WebChat, etc.).
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
        let mode = await MainActor.run { AppStateStore.shared.connectionMode }
        let token = ProcessInfo.processInfo.environment["CLAWDIS_GATEWAY_TOKEN"]
        switch mode {
        case .local:
            let port = GatewayEnvironment.gatewayPort()
            return (URL(string: "ws://127.0.0.1:\(port)")!, token)
        case .remote:
            if let forwarded = await RemoteTunnelManager.shared.controlTunnelPortIfRunning() {
                return (URL(string: "ws://127.0.0.1:\(Int(forwarded))")!, token)
            }
            throw NSError(
                domain: "RemoteTunnel",
                code: 2,
                userInfo: [NSLocalizedDescriptionKey: "Remote mode is enabled, but the control tunnel is not active"])
        }
    }
}
