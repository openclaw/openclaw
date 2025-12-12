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
    }

    private func configure(url: URL, token: String?) async {
        if self.client != nil, self.configuredURL == url, self.configuredToken == token {
            return
        }
        if let client {
            await client.shutdown()
        }
        self.client = GatewayChannelActor(url: url, token: token, session: self.sessionBox)
        self.configuredURL = url
        self.configuredToken = token
    }

    private static func defaultConfigProvider() async throws -> Config {
        let mode = await MainActor.run { AppStateStore.shared.connectionMode }
        let token = ProcessInfo.processInfo.environment["CLAWDIS_GATEWAY_TOKEN"]
        switch mode {
        case .local:
            let port = GatewayEnvironment.gatewayPort()
            return (URL(string: "ws://127.0.0.1:\(port)")!, token)
        case .remote:
            let forwarded = try await RemoteTunnelManager.shared.ensureControlTunnel()
            return (URL(string: "ws://127.0.0.1:\(Int(forwarded))")!, token)
        }
    }
}

