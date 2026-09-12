import Foundation
import OSLog

@MainActor
final class ConnectionModeCoordinator {
    static let shared = ConnectionModeCoordinator()

    struct Transition {
        private(set) var generation: UInt64 = 0
        private(set) var mode: AppState.ConnectionMode?

        mutating func begin(_ mode: AppState.ConnectionMode) -> UInt64 {
            self.generation &+= 1
            self.mode = mode
            return self.generation
        }

        func isCurrent(_ generation: UInt64, mode: AppState.ConnectionMode) -> Bool {
            self.generation == generation && self.mode == mode
        }
    }

    private let logger = Logger(subsystem: "ai.openclaw", category: "connection")
    private var transition = Transition()
    private var portSweepTask: Task<Void, Never>?
    private var localDisconnectTask: Task<Void, Never>?

    /// Apply the requested connection mode by starting/stopping local gateway,
    /// managing the control-channel SSH tunnel, and cleaning up chat windows/panels.
    func apply(mode: AppState.ConnectionMode, paused: Bool) async {
        self.portSweepTask?.cancel()
        self.localDisconnectTask?.cancel()
        let hostsLocalGateway = AppStateStore.shared.hostsLocalGatewayWithRemotePrimary
        let previousMode = self.transition.mode
        let applyGeneration = self.transition.begin(mode)
        if mode != .remote || !hostsLocalGateway {
            WebChatManager.shared.closeLocalGatewayWindows()
            let disconnect = Task {
                await MacGatewayConnectionFleet.shared.disconnectLocal(ifCurrent: { !Task.isCancelled })
            }
            self.localDisconnectTask = disconnect
            await disconnect.value
            guard self.transition.isCurrent(applyGeneration, mode: mode) else { return }
        }
        if let previousMode, previousMode != mode {
            GatewayProcessManager.shared.clearLastFailure()
            NodesStore.shared.lastError = nil
        }
        if mode != .remote {
            _ = await NodeServiceManager.stop()
            guard self.transition.isCurrent(applyGeneration, mode: mode) else { return }
            NodesStore.shared.lastError = nil
            await RemoteTunnelManager.shared.stopAll()
            guard self.transition.isCurrent(applyGeneration, mode: mode) else { return }
            WebChatManager.shared.resetPrimaryConnections()
        }

        switch mode {
        case .unconfigured:
            GatewayProcessManager.shared.stop()
            await ControlChannel.shared.disconnect()
            guard self.transition.isCurrent(applyGeneration, mode: mode) else { return }

        case .local:
            await self.applyLocalMode(paused: paused, generation: applyGeneration)
            guard self.transition.isCurrent(applyGeneration, mode: mode) else { return }

        case .remote:
            await self.applyLocalGateway(
                mode: mode,
                paused: paused,
                hostsLocalGateway: hostsLocalGateway,
                generation: applyGeneration)
            guard self.transition.isCurrent(applyGeneration, mode: mode) else { return }
            WebChatManager.shared.resetPrimaryConnections()

            do {
                NodesStore.shared.lastError = nil
                let nodeError = await NodeServiceManager.start()
                guard self.transition.isCurrent(applyGeneration, mode: mode) else { return }
                if let error = nodeError {
                    NodesStore.shared.lastError = "Node service start failed: \(error)"
                }
                _ = try await GatewayEndpointStore.shared.ensureRemoteControlTunnel()
                guard self.transition.isCurrent(applyGeneration, mode: mode) else { return }
                await ControlChannel.shared.configure()
                guard self.transition.isCurrent(applyGeneration, mode: mode) else { return }
            } catch {
                guard self.transition.isCurrent(applyGeneration, mode: mode) else { return }
                self.logger.error("remote tunnel/configure failed: \(error.localizedDescription, privacy: .public)")
            }
        }

        self.portSweepTask = Task {
            await PortGuardian.shared.sweep(mode: mode, hostsLocalGateway: hostsLocalGateway)
        }
    }

    private func applyLocalMode(paused: Bool, generation: UInt64) async {
        await self.applyLocalGateway(mode: .local, paused: paused, hostsLocalGateway: false, generation: generation)
        guard self.transition.isCurrent(generation, mode: .local) else { return }
        await ControlChannel.shared.configure()
    }

    private func applyLocalGateway(
        mode: AppState.ConnectionMode,
        paused: Bool,
        hostsLocalGateway: Bool,
        generation: UInt64) async
    {
        if GatewayAutostartPolicy.shouldStartGateway(mode: mode, paused: paused, hostsLocalGateway: hostsLocalGateway) {
            GatewayProcessManager.shared.setActive(true)
            await GatewayProcessManager.shared.waitForStartupAttempt()
            guard self.transition.isCurrent(generation, mode: mode) else { return }
            var launchAgentInstalled = false
            if GatewayAutostartPolicy.shouldEnsureLaunchAgent(
                mode: mode, paused: paused, hostsLocalGateway: hostsLocalGateway)
            {
                launchAgentInstalled = await GatewayProcessManager.shared.ensureLaunchAgentEnabledIfNeeded()
            }
            guard self.transition.isCurrent(generation, mode: mode) else { return }
            // Finish persistence before readiness so a newer lifecycle cannot clear its repair marker.
            _ = await GatewayProcessManager.shared.waitForGatewayReady(
                launchAgentInstalled: launchAgentInstalled)
            guard self.transition.isCurrent(generation, mode: mode) else { return }
        } else {
            GatewayProcessManager.shared.stop()
            await GatewayProcessManager.shared.waitForStartupAttempt()
        }
    }
}
