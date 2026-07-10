import Foundation
import OpenClawDiscovery
import OpenClawIPC
import SwiftUI

extension OnboardingView {
    func selectLocalGateway() {
        if self.state.connectionMode != .local {
            self.resetGatewayBoundAIState()
        }
        self.defaultsToLocalGateway = false
        self.state.connectionMode = .local
        self.preferredGatewayID = nil
        self.showAdvancedConnection = false
        self.showRemoteChoices = false
        GatewayDiscoveryPreferences.setPreferredStableID(nil)
        self.probeConfiguredGatewayForDashboard()
    }

    func selectUnconfiguredGateway() {
        self.resetGatewayBoundAIState()
        self.defaultsToLocalGateway = false
        self.state.connectionMode = .unconfigured
        self.preferredGatewayID = nil
        self.showAdvancedConnection = false
        self.showRemoteChoices = false
        GatewayDiscoveryPreferences.setPreferredStableID(nil)
    }

    func selectRemoteGateway(_ gateway: GatewayDiscoveryModel.DiscoveredGateway) {
        let shouldResetGatewayState = Self.shouldResetGatewayBoundAIState(
            connectionMode: self.state.connectionMode,
            currentPreferredGatewayID: self.preferredGatewayID,
            persistedPreferredGatewayID: GatewayDiscoveryPreferences.preferredStableID(),
            selectedGatewayID: gateway.stableID)
        if shouldResetGatewayState {
            // The mode can remain `.remote` while the selected Gateway changes,
            // so its onChange hook alone cannot retire route-bound state.
            self.resetGatewayBoundAIState()
        }
        self.defaultsToLocalGateway = false
        self.preferredGatewayID = gateway.stableID
        GatewayDiscoveryPreferences.setPreferredStableID(gateway.stableID)
        GatewayDiscoverySelectionSupport.applyRemoteSelection(gateway: gateway, state: self.state)

        self.state.connectionMode = .remote
        MacNodeModeCoordinator.shared.setPreferredGatewayStableID(gateway.stableID)
        self.probeConfiguredGatewayForDashboard()
    }

    static func shouldResetGatewayBoundAIState(
        connectionMode: AppState.ConnectionMode,
        currentPreferredGatewayID: String?,
        persistedPreferredGatewayID: String?,
        selectedGatewayID: String) -> Bool
    {
        let currentGatewayID = Self.normalizedGatewayID(currentPreferredGatewayID) ??
            Self.normalizedGatewayID(persistedPreferredGatewayID)
        return connectionMode != .remote || currentGatewayID != Self.normalizedGatewayID(selectedGatewayID)
    }

    private static func normalizedGatewayID(_ value: String?) -> String? {
        let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed?.isEmpty == false ? trimmed : nil
    }

    func openSettings(tab: SettingsTab) {
        AppNavigationActions.openSettings(tab: tab)
    }

    func handleBack() {
        withAnimation {
            self.currentPage = max(0, self.currentPage - 1)
        }
    }

    func handleNext() {
        // All callers (Next button, chat handoff) honor the same page gates.
        guard self.canAdvance else { return }
        self.commitRecommendedConnectionIfNeeded(for: self.activePageIndex)
        if self.currentPage < self.pageCount - 1 {
            withAnimation { self.currentPage += 1 }
        } else {
            self.finish()
        }
    }

    func commitRecommendedConnectionIfNeeded(for pageIndex: Int) {
        if pageIndex == self.connectionPageIndex,
           self.defaultsToLocalGateway,
           self.state.connectionMode == .unconfigured
        {
            self.selectLocalGateway()
        }
    }

    func finish() {
        let routeIdentity = OnboardingCrestodianResumeStore.selectedRouteIdentity(
            state: self.state,
            preferredGatewayID: self.preferredGatewayID ?? GatewayDiscoveryPreferences.preferredStableID())
        if let routeIdentity {
            OnboardingCrestodianResumeStore.clear(
                ifOwnedBy: routeIdentity,
                defaults: self.crestodianDefaults)
        }
        OnboardingController.markComplete(clearSelectedRouteResume: false)
        OnboardingController.shared.close()
        // Land people in the real conversation, not on an empty desktop: the
        // agent chat is the product, and it is verified working by now.
        if self.state.connectionMode != .unconfigured {
            AppNavigationActions.openChat()
        }
    }
}
