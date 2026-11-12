import Foundation

/// One owner for what a successful OpenClaw ID join means, whichever window finished it: the
/// claw becomes this Mac's Gateway and first-run setup is complete, so no setup window stays
/// open on a page that would pick a local Gateway. Setup closes before the primary connection
/// changes, so it never reacts to that change; then the claw's dashboard opens.
@MainActor
enum MacOpenClawIDJoinCompletion {
    static func finish(
        claw: String,
        markOnboardingComplete: @MainActor () -> Void = { OnboardingController.markComplete() },
        closeOnboarding: @MainActor () -> Void = { OnboardingController.shared.close() },
        selectPrimary: @MainActor (String) -> Void = { Self.selectPrimary($0) },
        refreshEndpoint: @escaping @MainActor () async -> Void = { await GatewayEndpointStore.shared.refresh() },
        openDashboard: @escaping @MainActor () -> Void = { AppNavigationActions.openDashboard() })
    {
        markOnboardingComplete()
        closeOnboarding()
        selectPrimary(claw)
        Task { @MainActor in
            await refreshEndpoint()
            openDashboard()
        }
    }

    /// Whether the primary connection is this Mac's OpenClaw ID claw. That claw owns its own AI
    /// and Gateway setup; a member key does not hold the operator.admin that setup needs.
    static func primaryIsJoinedClaw(
        mode: AppState.ConnectionMode,
        remoteUrl: String,
        serves: (URL) -> Bool = { MacOpenClawIDOperatorRoute.shared.serves($0) }) -> Bool
    {
        guard mode == .remote, let url = URL(string: remoteUrl) else { return false }
        return serves(url)
    }

    /// The claw replaces this Mac's primary connection (Tailscale, token or SSH): its saved Gateway
    /// token and password are cleared in the same write, so they cannot bypass a revocation in
    /// OpenClaw ID. Tailscale itself is not touched.
    private static func selectPrimary(_ claw: String) {
        let state = AppStateStore.shared
        if let url = URL(string: "wss://\(claw)"),
           (try? state.setPrimaryGateway(.direct(url: url, token: nil, password: nil, tlsFingerprint: nil))) != nil
        {
            return
        }
        state.remoteTransport = .direct
        state.remoteUrl = "wss://\(claw)"
        state.remoteToken = ""
        state.connectionMode = .remote
    }
}
