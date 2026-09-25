import Foundation

enum GatewayAutostartPolicy {
    static func shouldStartGateway(
        mode: AppState.ConnectionMode,
        paused: Bool,
        hostsLocalGateway: Bool) -> Bool
    {
        (mode == .local || (mode == .remote && hostsLocalGateway)) && !paused
    }

    static func shouldEnsureLaunchAgent(
        mode: AppState.ConnectionMode,
        paused: Bool,
        hostsLocalGateway: Bool) -> Bool
    {
        self.shouldStartGateway(mode: mode, paused: paused, hostsLocalGateway: hostsLocalGateway)
    }
}
