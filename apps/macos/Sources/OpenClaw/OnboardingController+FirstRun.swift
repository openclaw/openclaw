import Foundation
import OpenClawKit

extension OnboardingController {
    func startFirstRunIfFresh() async -> Bool {
        let state = AppStateStore.shared
        guard OnboardingFirstRun.isFresh(
            isUnconfigured: state.connectionMode == .unconfigured,
            onboardingSeen: state.onboardingSeen,
            onboardingVersion: AppDefaults.standard.integer(forKey: onboardingVersionKey),
            configExists: FileManager.default.fileExists(atPath: OpenClawPaths.configURL.path),
            hasRemoteSettings: !state.remoteTarget.isEmpty || !state.remoteUrl.isEmpty ||
                !state.remoteIdentity.isEmpty || GatewayDiscoveryPreferences.preferredStableID() != nil),
            !ProcessInfo.processInfo.isNixMode,
            AppLaunchRuntimePlan.current.allowsAutomaticPresentation
        else { return false }
        do {
            guard try await MacGatewayProfileStore.shared.profiles().isEmpty else { return false }
        } catch { return false }
        guard !Task.isCancelled, state.connectionMode == .unconfigured, !state.onboardingSeen else { return false }
        let task = Task {
            await OnboardingFirstRun.run(
                selectLocal: {
                    guard GatewayProcessManager.shared.installation == .managed else {
                        throw GatewayHostingError(message: GatewayProcessManager.Installation.ownershipFailure)
                    }
                    GatewayDiscoveryPreferences.setPreferredStableID(nil)
                    state.connectionMode = .local
                    guard state.syncGatewayConfigNow() else {
                        throw GatewayHostingError(message: String(localized: "Could not save the local Gateway setup."))
                    }
                },
                prepareRuntime: {
                    guard BundledRuntime.isBundledApp else {
                        throw GatewayHostingError(message: String(localized: "Install the Gateway to continue setup."))
                    }
                    await GatewayProcessManager.shared.waitForStartupAttempt()
                    try Task.checkCancellation()
                    _ = try await CLIInstaller.prepareBundledGateway { _ in }
                },
                startGateway: {
                    guard state.connectionMode == .local else { throw CancellationError() }
                    let activation = await CLIInstaller.activateLocalGateway()
                    CLIInstaller.completeBundledSetup(after: activation)
                    let outcome = OnboardingView.localGatewayActivationOutcome(activation, afterFreshInstall: true)
                    guard outcome.ready else { throw GatewayHostingError(message: outcome.status) }
                },
                supportsAutomaticSetup: {
                    let connection = GatewayConnection.shared
                    let lease = try await connection.acquireServerLease()
                    guard state.connectionMode == .local else { throw CancellationError() }
                    return await connection.supportsServerMethod(
                        "openclaw.setup.auto", ifCurrentServerLease: lease) == true
                },
                openDashboard: {
                    guard state.connectionMode == .local else { throw CancellationError() }
                    try await AppNavigationActions.openDashboardOnboardingAndWait()
                    guard state.connectionMode == .local else { throw CancellationError() }
                },
                markComplete: { Self.markComplete() })
        }
        self.automaticSetupTask = task
        let fallback = await task.value
        self.automaticSetupTask = nil
        guard !task.isCancelled, !Task.isCancelled, state.connectionMode != .remote else { return true }
        if let fallback { self.show(page: fallback.page, error: fallback.message) }
        return true
    }
}
