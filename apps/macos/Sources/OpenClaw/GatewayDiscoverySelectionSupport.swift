import OpenClawDiscovery
import OpenClawKit

@MainActor
enum GatewayDiscoverySelectionSupport {
    private static let defaultSshTunnelGatewayUrl = "ws://127.0.0.1:18789"

    static func applyRemoteSelection(
        gateway: GatewayDiscoveryModel.DiscoveredGateway,
        state: AppState)
    {
        let discoveredServicePort = GatewayDiscoveryHelpers.serviceEndpoint(for: gateway)?.port
        let preferredTransport = self.preferredTransport(
            for: gateway,
            current: state.remoteTransport)
        if preferredTransport != state.remoteTransport {
            state.remoteTransport = preferredTransport
        }

        if preferredTransport == .direct {
            state.remoteUrl = GatewayDiscoveryHelpers.directUrl(for: gateway) ?? ""
        } else {
            state.remoteUrl = self.sshTunnelGatewayUrl(
                current: state.remoteUrl,
                preferredPort: discoveredServicePort)
        }
        state.remoteTarget = GatewayDiscoveryHelpers.sshTarget(for: gateway) ?? ""

        if preferredTransport == .direct {
            if let endpoint = GatewayDiscoveryHelpers.serviceEndpoint(for: gateway) {
                OpenClawConfigFile.setRemoteGatewayUrl(
                    host: endpoint.host,
                    port: endpoint.port)
            } else {
                OpenClawConfigFile.clearRemoteGatewayUrl()
            }
        } else {
            let tunnel = state.remoteUrl
            if let components = URLComponents(string: tunnel),
               let host = components.host,
               let port = components.port
            {
                OpenClawConfigFile.setRemoteGatewayUrl(host: host, port: port)
            } else {
                OpenClawConfigFile.setRemoteGatewayUrl(host: "127.0.0.1", port: 18789)
            }
        }
    }

    private static func sshTunnelGatewayUrl(current: String, preferredPort: Int?) -> String {
        if let preferredPort, (1...65535).contains(preferredPort) {
            return "ws://127.0.0.1:\(preferredPort)"
        }
        let trimmed = current.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, let url = URL(string: trimmed), let host = url.host else {
            return self.defaultSshTunnelGatewayUrl
        }
        guard LoopbackHost.isLoopbackHost(host) else {
            return self.defaultSshTunnelGatewayUrl
        }
        let port = url.port ?? 18789
        return "ws://127.0.0.1:\(port)"
    }

    static func preferredTransport(
        for gateway: GatewayDiscoveryModel.DiscoveredGateway,
        current: AppState.RemoteTransport) -> AppState.RemoteTransport
    {
        if self.shouldPreferDirectTransport(for: gateway) {
            return .direct
        }
        return current
    }

    static func shouldPreferDirectTransport(
        for gateway: GatewayDiscoveryModel.DiscoveredGateway) -> Bool
    {
        guard GatewayDiscoveryHelpers.directUrl(for: gateway) != nil else { return false }
        if gateway.stableID.hasPrefix("tailscale-serve|") {
            return true
        }
        guard let host = GatewayDiscoveryHelpers.resolvedServiceHost(for: gateway)?
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased()
        else {
            return false
        }
        return host.hasSuffix(".ts.net")
    }
}
