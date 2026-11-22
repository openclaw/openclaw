import Foundation
import OpenClawDiscovery
import SwiftUI

extension OnboardingView {
    @discardableResult
    func beginNodeInvitation() -> Task<Void, Never>? {
        let task = self.openClawID.begin(.joinNode)
        if task != nil { self.finishState.connectionCompletion = nil }
        self.showOpenClawID = true
        return task
    }

    func beginOpenClawIDSignIn() {
        self.openClawID.begin(.connect)
        self.showOpenClawID = true
    }

    func selectLocalGateway() {
        if state.connectionMode != .local {
            resetGatewayBoundAIState()
        }
        remoteSetupSelected = false
        savedBrowserGatewayName = nil
        defaultsToLocalGateway = false
        state.connectionMode = .local
        showRemoteChoices = false
        GatewayDiscoveryPreferences.setPreferredStableID(nil)
        probeConfiguredGatewayForDashboard()
    }

    func selectUnconfiguredGateway() {
        resetGatewayBoundAIState()
        remoteSetupSelected = false
        savedBrowserGatewayName = nil
        defaultsToLocalGateway = false
        state.connectionMode = .unconfigured
        showRemoteChoices = false
        GatewayDiscoveryPreferences.setPreferredStableID(nil)
    }

    func handleRemoteSelection() {
        remoteSetupSelected = true
        savedBrowserGatewayName = nil
    }

    func selectRemoteGateway(_: GatewayDiscoveryModel.DiscoveredGateway) {
        // Names, addresses, and stable IDs in discovery are not connection authority.
        self.showConnectionEditor = true
    }

    func didSaveRemoteConnection() {
        self.savedBrowserGatewayName = nil
        self.defaultsToLocalGateway = false
        self.retireGatewayStateForRemoteEndpointEdit()
        self.probeConfiguredGatewayForDashboard()
    }

    func handleBack() {
        withAnimation {
            self.currentPage = max(0, self.currentPage - 1)
        }
    }

    func handleNext() {
        guard canAdvance else { return }
        let remoteDecision = self.findPageAdvanceDecision
        guard self.activePageIndex != self.findPageIndex || remoteDecision.canAdvance else {
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
           defaultsToLocalGateway, !remoteSetupSelected,
           state.connectionMode == .unconfigured
        {
            self.selectLocalGateway()
        }
    }

    func advanceAfterInference() {
        guard self.activePageIndex != self.reachabilityPageIndex,
              self.activePageIndex != self.readyPageIndex else { return }
        let destination = self.state.connectionMode == .local && MacOpenClawIDFeature.isEnabled
            ? self.reachabilityPageIndex : self.readyPageIndex
        if let cursor = self.pageOrder.firstIndex(of: destination) {
            withAnimation { self.currentPage = cursor }
        }
    }

    @discardableResult
    func finish(openPrimaryDashboard: Bool = true) -> Bool {
        guard !finishState.didFinish else { return false }
        finishState.didFinish = true
        aiSetup.clearCompletedHandoffIfOwned()
        OnboardingController.markComplete()
        OnboardingController.shared.close()
        guard openPrimaryDashboard, finishState.connectionCompletion == nil,
              state.connectionMode != .unconfigured else { return true }
        // The verified completion owns its destination: a fresh primary model opens
        // the agent chat, a utility-only model opens OpenClaw help, and a verified
        // pre-existing setup reopens the normal dashboard. Optional setup (channels,
        // memory import, permissions) stays available from Settings.
        let handoff: OnboardingDashboardHandoff = if primaryIsJoinedClaw {
            .dashboard
        } else if case let .connected(handoff) = aiSetup.phase {
            handoff
        } else {
            .custodianOnboarding
        }
        dashboardHandoffOpener(handoff)
        return true
    }
}
