import Foundation
import OpenClawDiscovery
import SwiftUI

extension OnboardingView {
    func selectLocalGateway() {
        if state.connectionMode != .local {
            resetGatewayBoundAIState()
        }
        defaultsToLocalGateway = false
        state.connectionMode = .local
        preferredGatewayID = nil
        showRemoteChoices = false
        GatewayDiscoveryPreferences.setPreferredStableID(nil)
        probeConfiguredGatewayForDashboard()
    }

    func selectUnconfiguredGateway() {
        resetGatewayBoundAIState()
        defaultsToLocalGateway = false
        state.connectionMode = .unconfigured
        preferredGatewayID = nil
        showRemoteChoices = false
        GatewayDiscoveryPreferences.setPreferredStableID(nil)
    }

    func handleRemoteSelection() {
        showRemoteChoices = true
        showConnectionEditor = true
    }

    func selectRemoteGateway(_: GatewayDiscoveryModel.DiscoveredGateway) {
        // Names, addresses, and stable IDs in discovery are not connection authority.
        self.showConnectionEditor = true
    }

    func didSaveRemoteConnection() {
        self.defaultsToLocalGateway = false
        self.preferredGatewayID = nil
        self.retireGatewayStateForRemoteEndpointEdit()
        self.probeConfiguredGatewayForDashboard()
    }

    private static func normalizedGatewayID(_ value: String?) -> String? {
        let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed?.isEmpty == false ? trimmed : nil
    }

    var effectivePreferredGatewayID: String? {
        let persisted = Self.normalizedGatewayID(GatewayDiscoveryPreferences.preferredStableID())
        guard let local = Self.normalizedGatewayID(preferredGatewayID) else {
            return persisted
        }
        // Config-watcher endpoint changes clear the persisted owner. Ignore the
        // stale @State copy until the view's next render catches up.
        return local == persisted ? local : persisted
    }

    func handleBack() {
        withAnimation {
            self.currentPage = max(0, self.currentPage - 1)
        }
    }

    func handleNext() {
        guard canAdvance else { return }
        let remoteDecision = Self.remoteGatewayAdvanceDecision(
            connectionMode: state.connectionMode,
            activePageIndex: activePageIndex,
            connectionPageIndex: connectionPageIndex,
            authIssue: remoteAuthIssue,
            probeState: remoteProbeState,
            input: remoteGatewayProbeInput)
        guard remoteDecision.canAdvance else {
            if remoteDecision.shouldProbe {
                Task { await self.probeRemoteConnection(advanceOnSuccess: true) }
            }
            return
        }
        self.commitRecommendedConnectionIfNeeded(for: activePageIndex)
        if currentPage < pageCount - 1 {
            withAnimation { self.currentPage += 1 }
        } else {
            self.finish()
        }
    }

    func commitRecommendedConnectionIfNeeded(for pageIndex: Int) {
        if pageIndex == connectionPageIndex,
           defaultsToLocalGateway,
           state.connectionMode == .unconfigured
        {
            self.selectLocalGateway()
        }
    }

    @discardableResult
    func finish(openPrimaryDashboard: Bool = true) -> Bool {
        guard !finishState.didFinish else { return false }
        finishState.didFinish = true
        aiSetup.clearCompletedHandoffIfOwned()
        OnboardingController.markComplete()
        OnboardingController.shared.close()
        guard openPrimaryDashboard, state.connectionMode != .unconfigured else { return true }
        // Fresh activation hands off to the dashboard's custodian onboarding, which
        // owns the remaining first-run steps (memory import, channels, permissions,
        // hatch). A live-verified pre-existing setup reopens the normal dashboard.
        dashboardHandoffOpener(aiSetup.verifiedExistingInference ? .dashboard : .custodianOnboarding)
        return true
    }
}
