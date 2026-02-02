import SwiftUI

struct RootView: View {
    @Environment(NodeAppModel.self) private var appModel: NodeAppModel
    @AppStorage("gateway.onboardingComplete") private var onboardingComplete: Bool = false
    @AppStorage("gateway.preferredStableID") private var preferredGatewayStableID: String = ""
    @AppStorage("gateway.manual.enabled") private var manualGatewayEnabled: Bool = false
    @AppStorage("gateway.manual.host") private var manualGatewayHost: String = ""

    var body: some View {
        Group {
            if self.shouldShowOnboarding {
                GatewayOnboardingView()
            } else {
                RootCanvas()
            }
        }
        .onAppear { self.bootstrapOnboardingIfNeeded() }
        .onChange(of: self.appModel.gatewayServerName) { _, newValue in
            if newValue != nil {
                self.onboardingComplete = true
            }
        }
    }

    private var shouldShowOnboarding: Bool {
        if self.appModel.gatewayServerName != nil { return false }
        if self.onboardingComplete { return false }
        if self.hasExistingGatewayConfig { return false }
        return true
    }

    private var hasExistingGatewayConfig: Bool {
        if GatewaySettingsStore.loadLastGatewayConnection() != nil { return true }
        let preferred = self.preferredGatewayStableID.trimmingCharacters(in: .whitespacesAndNewlines)
        if !preferred.isEmpty { return true }
        let manualHost = self.manualGatewayHost.trimmingCharacters(in: .whitespacesAndNewlines)
        return self.manualGatewayEnabled && !manualHost.isEmpty
    }

    private func bootstrapOnboardingIfNeeded() {
        if !self.onboardingComplete, self.hasExistingGatewayConfig {
            self.onboardingComplete = true
        }
    }
}
