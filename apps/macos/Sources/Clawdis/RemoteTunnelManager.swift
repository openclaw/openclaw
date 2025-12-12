import Foundation

/// Manages the SSH tunnel that forwards the remote gateway/control port to localhost.
actor RemoteTunnelManager {
    static let shared = RemoteTunnelManager()

    private var controlTunnel: WebChatTunnel?

    func controlTunnelPortIfRunning() -> UInt16? {
        if let tunnel = self.controlTunnel,
           tunnel.process.isRunning,
           let local = tunnel.localPort
        {
            return local
        }
        return nil
    }

    /// Ensure an SSH tunnel is running for the gateway control port.
    /// Returns the local forwarded port (usually 18789).
    func ensureControlTunnel() async throws -> UInt16 {
        let settings = CommandResolver.connectionSettings()
        guard settings.mode == .remote else {
            throw NSError(
                domain: "RemoteTunnel",
                code: 1,
                userInfo: [NSLocalizedDescriptionKey: "Remote mode is not enabled"])
        }

        if let local = self.controlTunnelPortIfRunning() { return local }

        let desiredPort = UInt16(GatewayEnvironment.gatewayPort())
        let tunnel = try await WebChatTunnel.create(
            remotePort: GatewayEnvironment.gatewayPort(),
            preferredLocalPort: desiredPort)
        self.controlTunnel = tunnel
        return tunnel.localPort ?? desiredPort
    }

    func stopAll() {
        self.controlTunnel?.terminate()
        self.controlTunnel = nil
    }
}
