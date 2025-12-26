import Foundation
import OSLog

/// Manages the SSH tunnel that forwards the remote gateway/control port to localhost.
actor RemoteTunnelManager {
    static let shared = RemoteTunnelManager()

    private let logger = Logger(subsystem: "com.steipete.clawdis", category: "remote-tunnel")
    private var controlTunnel: RemotePortTunnel?

    func controlTunnelPortIfRunning() async -> UInt16? {
        if let tunnel = self.controlTunnel,
           tunnel.process.isRunning,
           let local = tunnel.localPort
        {
            if await self.isTunnelHealthy(port: local) { return local }
            self.logger.error("active SSH tunnel on port \(local, privacy: .public) is unhealthy; restarting")
            tunnel.terminate()
            self.controlTunnel = nil
        }
        // If a previous Clawdis run already has an SSH listener on the expected port (common after restarts),
        // reuse it instead of spawning new ssh processes that immediately fail with "Address already in use".
        let desiredPort = UInt16(GatewayEnvironment.gatewayPort())
        if let desc = await PortGuardian.shared.describe(port: Int(desiredPort)),
           self.isSshProcess(desc)
        {
            if await self.isTunnelHealthy(port: desiredPort) { return desiredPort }
            await self.cleanupStaleTunnel(desc: desc, port: desiredPort)
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

    private func isTunnelHealthy(port: UInt16) async -> Bool {
        await PortGuardian.shared.probeGatewayHealth(port: Int(port))
    }

    private func isSshProcess(_ desc: PortGuardian.Descriptor) -> Bool {
        let cmd = desc.command.lowercased()
        if cmd.contains("ssh") { return true }
        if let path = desc.executablePath?.lowercased(), path.contains("/ssh") { return true }
        return false
    }

    private func cleanupStaleTunnel(desc: PortGuardian.Descriptor, port: UInt16) async {
        let pid = desc.pid
        self.logger.error(
            "stale SSH tunnel detected on port \(port, privacy: .public) pid \(pid, privacy: .public)")
        let killed = await self.kill(pid: pid)
        if !killed {
            self.logger.error("failed to terminate stale SSH tunnel pid \(pid, privacy: .public)")
        }
        await PortGuardian.shared.removeRecord(pid: pid)
    }

    private func kill(pid: Int32) async -> Bool {
        let term = await ShellExecutor.run(command: ["kill", "-TERM", "\(pid)"], cwd: nil, env: nil, timeout: 2)
        if term.ok { return true }
        let sigkill = await ShellExecutor.run(command: ["kill", "-KILL", "\(pid)"], cwd: nil, env: nil, timeout: 2)
        return sigkill.ok
    }
}
