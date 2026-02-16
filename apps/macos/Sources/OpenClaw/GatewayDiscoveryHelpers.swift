import OpenClawDiscovery
import Foundation

enum GatewayDiscoveryHelpers {
    static func sshTarget(for gateway: GatewayDiscoveryModel.DiscoveredGateway) -> String? {
        let host = self.sanitizedTailnetHost(gateway.tailnetDns) ?? gateway.lanHost
        guard let host = self.trimmed(host), !host.isEmpty else { return nil }
        let user = NSUserName()
        var target = "\(user)@\(host)"
        if gateway.sshPort != 22 {
            target += ":\(gateway.sshPort)"
        }
        return target
    }

    static func directUrl(for gateway: GatewayDiscoveryModel.DiscoveredGateway) -> String? {
        self.directGatewayUrl(
            serviceHost: gateway.serviceHost,
            servicePort: gateway.servicePort,
            lanHost: gateway.lanHost,
            gatewayPort: gateway.gatewayPort)
    }

    static func directGatewayUrl(
        serviceHost: String?,
        servicePort: Int?,
        lanHost: String?,
        gatewayPort: Int?) -> String?
    {
        // Security: do not route using unauthenticated TXT hints (tailnetDns/lanHost/gatewayPort).
        // Prefer the resolved service endpoint (SRV + A/AAAA).
        if let host = self.trimmed(serviceHost), !host.isEmpty,
           let port = servicePort, port > 0
        {
            let scheme = port == 443 ? "wss" : "ws"
            let portSuffix = port == 443 ? "" : ":\(port)"
            return "\(scheme)://\(host)\(portSuffix)"
        }

        // Legacy fallback (best-effort): keep existing behavior when we couldn't resolve SRV.
        guard let lanHost = self.trimmed(lanHost), !lanHost.isEmpty else { return nil }
        let port = gatewayPort ?? 18789
        return "ws://\(lanHost):\(port)"
    }

    static func sanitizedTailnetHost(_ host: String?) -> String? {
        guard let host = self.trimmed(host), !host.isEmpty else { return nil }
        if host.hasSuffix(".internal.") || host.hasSuffix(".internal") {
            return nil
        }
        return host
    }

    private static func trimmed(_ value: String?) -> String? {
        value?.trimmingCharacters(in: .whitespacesAndNewlines)
    }
}
