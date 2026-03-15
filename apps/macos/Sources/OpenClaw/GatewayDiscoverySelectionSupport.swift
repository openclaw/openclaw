import OpenClawDiscovery

@MainActor
enum GatewayDiscoverySelectionSupport {
    static func applyRemoteSelection(
        gateway: GatewayDiscoveryModel.DiscoveredGateway,
        state: AppState)
    {
        let preferredTransport = self.preferredTransport(
            for: gateway,
            current: state.remoteTransport)
        if preferredTransport != state.remoteTransport {
            state.remoteTransport = preferredTransport
        }

        state.remoteUrl = GatewayDiscoveryHelpers.directUrl(for: gateway) ?? ""
        state.remoteTarget = GatewayDiscoveryHelpers.sshTarget(for: gateway) ?? ""

        if let endpoint = GatewayDiscoveryHelpers.serviceEndpoint(for: gateway) {
            OpenClawConfigFile.setRemoteGatewayUrl(
                host: endpoint.host,
                port: endpoint.port)
        } else {
            OpenClawConfigFile.clearRemoteGatewayUrl()
        }
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
