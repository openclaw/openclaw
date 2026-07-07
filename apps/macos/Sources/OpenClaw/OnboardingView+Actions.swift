import AppKit
import Foundation
import OpenClawDiscovery
import OpenClawIPC
import SwiftUI

extension OnboardingView {
    func selectLocalGateway() {
        self.defaultsToLocalGateway = false
        self.state.connectionMode = .local
        self.preferredGatewayID = nil
        self.showAdvancedConnection = false
        self.showRemoteChoices = false
        GatewayDiscoveryPreferences.setPreferredStableID(nil)
    }

    func selectUnconfiguredGateway() {
        self.defaultsToLocalGateway = false
        self.state.connectionMode = .unconfigured
        self.preferredGatewayID = nil
        self.showAdvancedConnection = false
        self.showRemoteChoices = false
        GatewayDiscoveryPreferences.setPreferredStableID(nil)
    }

    func selectRemoteGateway(_ gateway: GatewayDiscoveryModel.DiscoveredGateway) {
        self.defaultsToLocalGateway = false
        self.preferredGatewayID = gateway.stableID
        GatewayDiscoveryPreferences.setPreferredStableID(gateway.stableID)
        GatewayDiscoverySelectionSupport.applyRemoteSelection(gateway: gateway, state: self.state)

        self.state.connectionMode = .remote
        MacNodeModeCoordinator.shared.setPreferredGatewayStableID(gateway.stableID)
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
        OnboardingController.markComplete()
        OnboardingController.shared.close()
        // Land people in the real conversation, not on an empty desktop: the
        // agent chat is the product, and it is verified working by now.
        if self.state.connectionMode != .unconfigured {
            AppNavigationActions.openChat()
        }
    }

    func copyToPasteboard(_ text: String) {
        let pb = NSPasteboard.general
        pb.clearContents()
        pb.setString(text, forType: .string)
        self.copied = true
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.2) { self.copied = false }
    }
}
