import Foundation
import OSLog

enum GatewayEndpointState: Sendable, Equatable {
    case ready(mode: AppState.ConnectionMode, url: URL, token: String?)
    case unavailable(mode: AppState.ConnectionMode, reason: String)
}

/// Single place to resolve (and publish) the effective gateway control endpoint.
///
/// This is intentionally separate from `GatewayConnection`:
/// - `GatewayConnection` consumes the resolved endpoint (no tunnel side-effects).
/// - The endpoint store owns observation + explicit "ensure tunnel" actions.
actor GatewayEndpointStore {
    static let shared = GatewayEndpointStore()

    struct Deps: Sendable {
        let mode: @Sendable () async -> AppState.ConnectionMode
        let token: @Sendable () -> String?
        let localPort: @Sendable () -> Int
        let remotePortIfRunning: @Sendable () async -> UInt16?
        let ensureRemoteTunnel: @Sendable () async throws -> UInt16

        static let live = Deps(
            mode: { await MainActor.run { AppStateStore.shared.connectionMode } },
            token: { ProcessInfo.processInfo.environment["CLAWDIS_GATEWAY_TOKEN"] },
            localPort: { GatewayEnvironment.gatewayPort() },
            remotePortIfRunning: { await RemoteTunnelManager.shared.controlTunnelPortIfRunning() },
            ensureRemoteTunnel: { try await RemoteTunnelManager.shared.ensureControlTunnel() })
    }

    private let deps: Deps
    private let logger = Logger(subsystem: "com.steipete.clawdis", category: "gateway-endpoint")

    private var state: GatewayEndpointState
    private var subscribers: [UUID: AsyncStream<GatewayEndpointState>.Continuation] = [:]

    init(deps: Deps = .live) {
        self.deps = deps
        let port = deps.localPort()
        self.state = .ready(mode: .local, url: URL(string: "ws://127.0.0.1:\(port)")!, token: deps.token())
    }

    func subscribe(bufferingNewest: Int = 1) -> AsyncStream<GatewayEndpointState> {
        let id = UUID()
        let initial = self.state
        let store = self
        return AsyncStream(bufferingPolicy: .bufferingNewest(bufferingNewest)) { continuation in
            continuation.yield(initial)
            self.subscribers[id] = continuation
            continuation.onTermination = { @Sendable _ in
                Task { await store.removeSubscriber(id) }
            }
        }
    }

    func refresh() async {
        let mode = await self.deps.mode()
        await self.setMode(mode)
    }

    func setMode(_ mode: AppState.ConnectionMode) async {
        let token = self.deps.token()
        switch mode {
        case .local:
            let port = self.deps.localPort()
            self.setState(.ready(mode: .local, url: URL(string: "ws://127.0.0.1:\(port)")!, token: token))
        case .remote:
            let port = await self.deps.remotePortIfRunning()
            guard let port else {
                self.setState(.unavailable(mode: .remote, reason: "Remote mode enabled but no active control tunnel"))
                return
            }
            self.setState(.ready(mode: .remote, url: URL(string: "ws://127.0.0.1:\(Int(port))")!, token: token))
        }
    }

    /// Explicit action: ensure the remote control tunnel is established and publish the resolved endpoint.
    func ensureRemoteControlTunnel() async throws -> UInt16 {
        let mode = await self.deps.mode()
        guard mode == .remote else {
            throw NSError(
                domain: "RemoteTunnel",
                code: 1,
                userInfo: [NSLocalizedDescriptionKey: "Remote mode is not enabled"])
        }
        let port = try await self.deps.ensureRemoteTunnel()
        await self.setMode(.remote)
        return port
    }

    func requireConfig() async throws -> GatewayConnection.Config {
        await self.refresh()
        switch self.state {
        case let .ready(_, url, token):
            return (url, token)
        case let .unavailable(_, reason):
            throw NSError(domain: "GatewayEndpoint", code: 1, userInfo: [NSLocalizedDescriptionKey: reason])
        }
    }

    private func removeSubscriber(_ id: UUID) {
        self.subscribers[id] = nil
    }

    private func setState(_ next: GatewayEndpointState) {
        guard next != self.state else { return }
        self.state = next
        for (_, continuation) in self.subscribers {
            continuation.yield(next)
        }
        switch next {
        case let .ready(mode, url, _):
            self.logger.debug("resolved endpoint mode=\(String(describing: mode), privacy: .public) url=\(url.absoluteString, privacy: .public)")
        case let .unavailable(mode, reason):
            self.logger.debug("endpoint unavailable mode=\(String(describing: mode), privacy: .public) reason=\(reason, privacy: .public)")
        }
    }
}

