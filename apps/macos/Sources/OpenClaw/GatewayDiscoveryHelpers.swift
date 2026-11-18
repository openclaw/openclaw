import Foundation
import OpenClawDiscovery

enum GatewayDiscoveryHelpers {
    static func sshTarget(for gateway: GatewayDiscoveryModel.DiscoveredGateway) -> String? {
        guard let host = gateway.serviceHost?.nonEmpty else { return nil }
        return GatewayDiscoveryModel.buildSSHTarget(user: NSUserName(), host: host, port: gateway.sshPort)
    }

    static func directUrl(for gateway: GatewayDiscoveryModel.DiscoveredGateway) -> String? {
        // Security: do not route using unauthenticated TXT hints (tailnetDns/lanHost/gatewayPort).
        // Prefer the resolved service endpoint (SRV + A/AAAA).
        guard let host = gateway.serviceHost?.nonEmpty,
              let port = gateway.servicePort, port > 0, port <= 65535,
              gateway.gatewayTls || GatewayRemoteConfig.allowsPlaintextGatewayHost(host)
        else { return nil }
        let scheme = gateway.gatewayTls ? "wss" : "ws"
        let portSuffix = gateway.gatewayTls && port == 443 ? "" : ":\(port)"
        return "\(scheme)://\(host)\(portSuffix)"
    }
}
