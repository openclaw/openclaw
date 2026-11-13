import Foundation

extension DashboardManager {
    func failureCopy(for error: Error) -> (title: String, message: String, detail: String) {
        let state = AppStateStore.shared
        return Self.failureCopy(
            error: error,
            joinedClaw: MacOpenClawIDJoinCompletion.primaryIsJoinedClaw(
                mode: state.connectionMode, remoteUrl: state.remoteUrl))
    }

    /// A route or lease superseded while opening surfaces as CancellationError; the failure page
    /// keeps observing the endpoint and reopens the dashboard, so it reads as reconnecting. The SSH
    /// tunnel reset does not apply to a claw reached over OpenClaw ID.
    nonisolated static func failureCopy(
        error: Error, joinedClaw: Bool) -> (title: String, message: String, detail: String)
    {
        let superseded = error is CancellationError
        let title = superseded ? "Reconnecting to the Gateway" : "Dashboard unavailable"
        let message = superseded
            ? "The connection changed while the dashboard was opening. It reopens when the connection is ready."
            : (error as NSError).localizedDescription
        let detail = joinedClaw
            ? "This Mac reaches its claw over OpenClaw ID. Check that the claw is online and that this Mac is " +
            "still allowed on its Access page."
            : "Open Connection or use Debug → Reset Remote Tunnel, then try again."
        return (title, message, detail)
    }
}
