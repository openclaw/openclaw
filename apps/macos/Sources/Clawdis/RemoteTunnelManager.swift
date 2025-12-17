import Foundation

/// Manages the SSH tunnel that forwards the remote gateway/control port to localhost.
actor RemoteTunnelManager {
    static let shared = RemoteTunnelManager()

    private var controlTunnel: RemotePortTunnel?

    func controlTunnelPortIfRunning() async -> UInt16? {
        if let tunnel = self.controlTunnel,
           tunnel.process.isRunning,
           let local = tunnel.localPort
        {
            return local
        }
        // If a previous Clawdis run already has an SSH listener on the expected port (common after restarts),
        // reuse it instead of spawning new ssh processes that immediately fail with "Address already in use".
        let desiredPort = UInt16(GatewayEnvironment.gatewayPort())
        if let desc = await PortGuardian.shared.describe(port: Int(desiredPort)),
           desc.command.lowercased().contains("ssh")
        {
            return desiredPort
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

        if let local = await self.controlTunnelPortIfRunning() { return local }

        let desiredPort = UInt16(GatewayEnvironment.gatewayPort())
        let tunnel = try await RemotePortTunnel.create(
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
