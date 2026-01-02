import Foundation
import OSLog

enum GatewayEndpointState: Sendable, Equatable {
    case ready(mode: AppState.ConnectionMode, url: URL, token: String?, password: String?)
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
        let password: @Sendable () -> String?
        let localPort: @Sendable () -> Int
        let remotePortIfRunning: @Sendable () async -> UInt16?
        let ensureRemoteTunnel: @Sendable () async throws -> UInt16

        static let live = Deps(
            mode: { await MainActor.run { AppStateStore.shared.connectionMode } },
            token: { ProcessInfo.processInfo.environment["CLAWDIS_GATEWAY_TOKEN"] },
            password: {
                // First check environment variable
                let raw = ProcessInfo.processInfo.environment["CLAWDIS_GATEWAY_PASSWORD"] ?? ""
                let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
                if !trimmed.isEmpty {
                    return trimmed
                }
                // Then check config file based on connection mode
                let root = ClawdisConfigFile.loadDict()
                // Check gateway.auth.password (for local gateway auth)
                if let gateway = root["gateway"] as? [String: Any],
                   let auth = gateway["auth"] as? [String: Any],
                   let password = auth["password"] as? String
                {
                    let pw = password.trimmingCharacters(in: .whitespacesAndNewlines)
                    if !pw.isEmpty {
                        return pw
                    }
                }
                // Check gateway.remote.password (for remote gateway auth)
                if let gateway = root["gateway"] as? [String: Any],
                   let remote = gateway["remote"] as? [String: Any],
                   let password = remote["password"] as? String
                {
                    let pw = password.trimmingCharacters(in: .whitespacesAndNewlines)
                    if !pw.isEmpty {
                        return pw
                    }
                }
                return nil
            },
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
        let modeRaw = UserDefaults.standard.string(forKey: connectionModeKey)
        let initialMode: AppState.ConnectionMode
        if let modeRaw {
            initialMode = AppState.ConnectionMode(rawValue: modeRaw) ?? .local
        } else {
            let seen = UserDefaults.standard.bool(forKey: "clawdis.onboardingSeen")
            initialMode = seen ? .local : .unconfigured
        }

        let port = deps.localPort()
        let token = deps.token()
        let password = deps.password()
        switch initialMode {
        case .local:
            self.state = .ready(mode: .local, url: URL(string: "ws://127.0.0.1:\(port)")!, token: token, password: password)
        case .remote:
            self.state = .unavailable(mode: .remote, reason: "Remote mode enabled but no active control tunnel")
        case .unconfigured:
            self.state = .unavailable(mode: .unconfigured, reason: "Gateway not configured")
        }
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
        let password = self.deps.password()
        switch mode {
        case .local:
            let port = self.deps.localPort()
            self.setState(.ready(mode: .local, url: URL(string: "ws://127.0.0.1:\(port)")!, token: token, password: password))
        case .remote:
            let port = await self.deps.remotePortIfRunning()
            guard let port else {
                self.setState(.unavailable(mode: .remote, reason: "Remote mode enabled but no active control tunnel"))
                return
            }
            self.setState(.ready(mode: .remote, url: URL(string: "ws://127.0.0.1:\(Int(port))")!, token: token, password: password))
        case .unconfigured:
            self.setState(.unavailable(mode: .unconfigured, reason: "Gateway not configured"))
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
        case let .ready(_, url, token, password):
            return (url, token, password)
        case let .unavailable(mode, reason):
            guard mode == .remote else {
                throw NSError(domain: "GatewayEndpoint", code: 1, userInfo: [NSLocalizedDescriptionKey: reason])
            }

            // Auto-recover for remote mode: if the SSH control tunnel died (or hasn't been created yet),
            // recreate it on demand so callers can recover without a manual reconnect.
            do {
                let forwarded = try await self.deps.ensureRemoteTunnel()
                let token = self.deps.token()
                let password = self.deps.password()
                let url = URL(string: "ws://127.0.0.1:\(Int(forwarded))")!
                self.setState(.ready(mode: .remote, url: url, token: token, password: password))
                return (url, token, password)
            } catch {
                let msg = "\(reason) (\(error.localizedDescription))"
                self.setState(.unavailable(mode: .remote, reason: msg))
                throw NSError(domain: "GatewayEndpoint", code: 1, userInfo: [NSLocalizedDescriptionKey: msg])
            }
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
        case let .ready(mode, url, _, _):
            let modeDesc = String(describing: mode)
            let urlDesc = url.absoluteString
            self.logger
                .debug(
                    "resolved endpoint mode=\(modeDesc, privacy: .public) url=\(urlDesc, privacy: .public)")
        case let .unavailable(mode, reason):
            let modeDesc = String(describing: mode)
            self.logger
                .debug(
                    "endpoint unavailable mode=\(modeDesc, privacy: .public) reason=\(reason, privacy: .public)")
        }
    }
}
