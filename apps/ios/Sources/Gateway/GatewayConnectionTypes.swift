import Network

/// What a TCP connect learned about a route. A refusal means the host answered but nothing
/// accepts connections on the port: a wrong port, not a network or VPN problem.
enum GatewayTCPProbeResult: Equatable, Sendable {
    case reachable
    case refused
    case unreachable
}

typealias GatewayTCPReachabilityProbe = @Sendable (String, Int, Double, String) async -> GatewayTCPProbeResult
typealias GatewayServiceEndpointResolver = @Sendable (NWEndpoint) async -> (host: String, port: Int)?
typealias GatewayForceReconnectReset = @MainActor (NodeAppModel) async -> Void
typealias GatewayTLSFingerprintPersist = @Sendable (_ fingerprint: String, _ stableID: String) -> Bool
