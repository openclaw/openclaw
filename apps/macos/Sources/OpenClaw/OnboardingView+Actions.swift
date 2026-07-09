import AppKit
import Foundation
import OpenClawDiscovery
import OpenClawIPC
import SwiftUI

extension OnboardingView {
    func selectLocalGateway() {
        defaultsToLocalGateway = false
        state.connectionMode = .local
        preferredGatewayID = nil
        showAdvancedConnection = false
        showRemoteChoices = false
        GatewayDiscoveryPreferences.setPreferredStableID(nil)
    }

    func selectUnconfiguredGateway() {
        defaultsToLocalGateway = false
        state.connectionMode = .unconfigured
        preferredGatewayID = nil
        showAdvancedConnection = false
        showRemoteChoices = false
        GatewayDiscoveryPreferences.setPreferredStableID(nil)
    }

    func selectRemoteGateway(_ gateway: GatewayDiscoveryModel.DiscoveredGateway) {
        defaultsToLocalGateway = false
        preferredGatewayID = gateway.stableID
        GatewayDiscoveryPreferences.setPreferredStableID(gateway.stableID)
        GatewayDiscoverySelectionSupport.applyRemoteSelection(gateway: gateway, state: state)

        state.connectionMode = .remote
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
        guard canAdvance else { return }
        let pageIndex = activePageIndex
        self.commitRecommendedConnectionIfNeeded(for: pageIndex)
        resetAISetupIfGatewayChanged()
        if Self.shouldPreflightExistingSetup(
            onConnectionPage: pageIndex == connectionPageIndex,
            mode: state.connectionMode,
            cliInstalled: cliInstalled)
        {
            self.preflightExistingSetupAndAdvance()
            return
        }
        self.advanceOrFinish()
    }

    func preflightExistingSetupAndAdvance() {
        let identity = gatewaySetupIdentity
        configureAISetupCallbacks()
        Task { @MainActor in
            let reusedExistingSetup = await self.aiSetup.reuseExistingSetupIfAvailable {
                self.gatewaySetupIdentity == identity
            }
            guard self.gatewaySetupIdentity == identity else {
                self.resetAISetupIfGatewayChanged()
                return
            }
            guard !reusedExistingSetup else { return }
            guard self.onboardingVisible else { return }
            // Only a successful detect that proves setup is incomplete may
            // reveal the AI page. Transport/protocol failures stay here so a
            // configured Gateway is never mistaken for a fresh installation.
            guard self.aiSetup.needsAISetupPage else { return }
            self.advanceOrFinish()
        }
    }

    @MainActor
    func preflightExistingSetupAfterCLIInstall() async {
        guard onboardingVisible, state.connectionMode == .local else { return }
        resetAISetupIfGatewayChanged()
        configureAISetupCallbacks()
        let identity = gatewaySetupIdentity
        if let connectionCursor = pageOrder.firstIndex(of: connectionPageIndex) {
            withAnimation { currentPage = connectionCursor }
        }

        let reusedExistingSetup = await aiSetup.reuseExistingSetupIfAvailable {
            self.gatewaySetupIdentity == identity
        }
        guard gatewaySetupIdentity == identity else {
            resetAISetupIfGatewayChanged()
            return
        }
        guard !reusedExistingSetup, onboardingVisible, aiSetup.needsAISetupPage else { return }
        if let aiCursor = pageOrder.firstIndex(of: aiPageIndex) {
            withAnimation { currentPage = aiCursor }
        }
    }

    private func advanceOrFinish() {
        if currentPage < pageCount - 1 {
            withAnimation { self.currentPage += 1 }
        } else {
            self.finish()
        }
    }

    static func shouldPreflightExistingSetup(
        onConnectionPage: Bool,
        mode: AppState.ConnectionMode,
        cliInstalled: Bool) -> Bool
    {
        guard onConnectionPage else { return false }
        switch mode {
        case .remote:
            return true
        case .local:
            // A fresh local install must reach the CLI/Gateway install page
            // before any Gateway RPC can run. Installation completion starts
            // this same preflight before onboarding proceeds.
            return cliInstalled
        case .unconfigured:
            return false
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

    func finish() {
        OnboardingController.markComplete()
        OnboardingController.shared.close()
        // Land people in the real conversation, not on an empty desktop: the
        // agent chat is the product, and it is verified working by now.
        if state.connectionMode != .unconfigured {
            AppNavigationActions.openChat()
        }
    }

    func copyToPasteboard(_ text: String) {
        let pb = NSPasteboard.general
        pb.clearContents()
        pb.setString(text, forType: .string)
        copied = true
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.2) { self.copied = false }
    }
}
