/// Remote dashboards resolve their sign-in route after hello, so the launch
/// preload is armed once and resolved when the control channel authenticates.
enum DashboardRemotePreloadDecision: Equatable {
    case wait
    case start
    case discard

    init(
        pending: Bool,
        mode: AppState.ConnectionMode,
        channelConnected: Bool,
        mainTargetIsPrimary: Bool,
        hasController: Bool,
        presentationInFlight: Bool)
    {
        guard pending, mode == .remote, mainTargetIsPrimary, !hasController, !presentationInFlight else {
            self = .discard
            return
        }
        self = channelConnected ? .start : .wait
    }
}
