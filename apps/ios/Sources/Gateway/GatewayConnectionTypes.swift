import Network

typealias GatewayTCPReachabilityProbe = @Sendable (String, Int, Double, String) async -> Bool
typealias GatewayServiceEndpointResolver = @Sendable (NWEndpoint) async -> (host: String, port: Int)?
typealias GatewayForceReconnectReset = @MainActor (NodeAppModel) async -> Void
typealias GatewayTLSFingerprintPersist = @Sendable (_ fingerprint: String, _ stableID: String) -> Bool
