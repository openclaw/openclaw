import Foundation
import OpenClawDiscovery

enum GatewayDiscoveryHelpers {
    static func serviceEndpoint(
        for gateway: GatewayDiscoveryModel.DiscoveredGateway) -> (host: String, port: Int)?
    {
        self.serviceEndpoint(serviceHost: gateway.serviceHost, servicePort: gateway.servicePort)
    }

    static func serviceEndpoint(
        serviceHost: String?,
        servicePort: Int?) -> (host: String, port: Int)?
    {
        guard let host = self.trimmed(serviceHost), !host.isEmpty else { return nil }
        guard let port = servicePort, port > 0, port <= 65535 else { return nil }
        return (host, port)
    }

    static func sshTarget(for gateway: GatewayDiscoveryModel.DiscoveredGateway) -> String? {
        guard let endpoint = self.serviceEndpoint(for: gateway) else { return nil }
        let user = NSUserName()
        var target = "\(user)@\(endpoint.host)"
        if gateway.sshPort != 22 {
            target += ":\(gateway.sshPort)"
        }
        return target
    }

    static func directUrl(for gateway: GatewayDiscoveryModel.DiscoveredGateway) -> String? {
        self.directGatewayUrl(
            serviceHost: gateway.serviceHost,
            servicePort: gateway.servicePort)
    }

    static func directGatewayUrl(
        serviceHost: String?,
        servicePort: Int?) -> String?
    {
        // Security: do not route using unauthenticated TXT hints (tailnetDns/lanHost/gatewayPort).
        // Prefer the resolved service endpoint (SRV + A/AAAA).
        guard let endpoint = self.serviceEndpoint(serviceHost: serviceHost, servicePort: servicePort) else {
            return nil
        }
        // Security: for non-loopback hosts, force TLS to avoid plaintext credential/session leakage.
        let scheme = self.isLoopbackHost(endpoint.host) ? "ws" : "wss"
        let portSuffix = endpoint.port == 443 ? "" : ":\(endpoint.port)"
        return "\(scheme)://\(endpoint.host)\(portSuffix)"
    }

    private static func trimmed(_ value: String?) -> String? {
        value?.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private static func isLoopbackHost(_ rawHost: String) -> Bool {
        let host = rawHost.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !host.isEmpty else { return false }
        if host == "localhost" || host == "::1" || host == "0:0:0:0:0:0:0:1" {
            return true
        }
        if host.hasPrefix("::ffff:127.") {
            return true
        }
        return host.hasPrefix("127.")
    }
}
