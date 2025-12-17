import Foundation
import OSLog

@MainActor
final class ConnectionModeCoordinator {
    static let shared = ConnectionModeCoordinator()

    private let logger = Logger(subsystem: "com.steipete.clawdis", category: "connection")

    /// Apply the requested connection mode by starting/stopping local gateway,
    /// managing the control-channel SSH tunnel, and cleaning up chat windows/panels.
    func apply(mode: AppState.ConnectionMode, paused: Bool) async {
        switch mode {
        case .local:
            await RemoteTunnelManager.shared.stopAll()
            WebChatManager.shared.resetTunnels()
            do {
                try await ControlChannel.shared.configure(mode: .local)
            } catch {
                // Control channel will mark itself degraded; nothing else to do here.
                self.logger.error(
                    "control channel local configure failed: \(error.localizedDescription, privacy: .public)")
            }
            if paused {
                GatewayProcessManager.shared.stop()
            } else {
                GatewayProcessManager.shared.setActive(true)
            }
            Task.detached { await PortGuardian.shared.sweep(mode: .local) }

        case .remote:
            // Never run a local gateway in remote mode.
            GatewayProcessManager.shared.stop()
            WebChatManager.shared.resetTunnels()

            do {
                _ = try await GatewayEndpointStore.shared.ensureRemoteControlTunnel()
                let settings = CommandResolver.connectionSettings()
                try await ControlChannel.shared.configure(mode: .remote(
                    target: settings.target,
                    identity: settings.identity))
            } catch {
                self.logger.error("remote tunnel/configure failed: \(error.localizedDescription, privacy: .public)")
            }

            Task.detached { await PortGuardian.shared.sweep(mode: .remote) }
        }
    }
}
