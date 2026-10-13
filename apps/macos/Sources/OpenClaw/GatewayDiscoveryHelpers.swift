import Foundation
import OpenClawDiscovery

enum GatewayDiscoveryHelpers {
    static func serviceEndpoint(
        serviceHost: String?,
        servicePort: Int?) -> (host: String, port: Int)?
    {
        guard let host = serviceHost?.nonEmpty else { return nil }
        guard let port = servicePort, port > 0, port <= 65535 else { return nil }
        return (host, port)
    }

    static func sshTarget(for gateway: GatewayDiscoveryModel.DiscoveredGateway) -> String? {
        guard let host = gateway.serviceHost?.nonEmpty else { return nil }
        return GatewayDiscoveryModel.buildSSHTarget(user: NSUserName(), host: host, port: gateway.sshPort)
    }

    static func directUrl(for gateway: GatewayDiscoveryModel.DiscoveredGateway) -> String? {
        self.directGatewayUrl(
            serviceHost: gateway.serviceHost,
            servicePort: gateway.servicePort,
            gatewayTls: gateway.gatewayTls)
    }

    static func directGatewayUrl(
        serviceHost: String?,
        servicePort: Int?,
        gatewayTls: Bool = false) -> String?
    {
        // Security: do not route using unauthenticated TXT hints (tailnetDns/lanHost/gatewayPort).
        // Prefer the resolved service endpoint (SRV + A/AAAA).
        guard let endpoint = self.serviceEndpoint(serviceHost: serviceHost, servicePort: servicePort) else {
            return nil
        }
        let scheme: String
        if gatewayTls {
            scheme = "wss"
        } else if self.isLoopbackHost(endpoint.host)
            || GatewayRemoteConfig.isTrustedPlaintextRemoteHost(endpoint.host)
        {
            scheme = "ws"
        } else {
            return nil
        }
        let portSuffix = scheme == "wss" && endpoint.port == 443 ? "" : ":\(endpoint.port)"
        return "\(scheme)://\(endpoint.host)\(portSuffix)"
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
