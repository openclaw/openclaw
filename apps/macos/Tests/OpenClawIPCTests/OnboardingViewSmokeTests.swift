import OpenClawDiscovery
import SwiftUI
import Testing
@testable import OpenClaw

@Suite(.serialized)
@MainActor
struct OnboardingViewSmokeTests {
    @Test func onboardingViewBuildsBody() {
        let state = AppState(preview: true)
        let view = OnboardingView(
            state: state,
            permissionMonitor: PermissionMonitor.shared,
            discoveryModel: GatewayDiscoveryModel(localDisplayName: InstanceIdentity.displayName))
        _ = view.body
    }

    @Test func pageOrderOmitsWorkspaceAndIdentitySteps() {
        let order = OnboardingView.pageOrder(for: .local, showOnboardingChat: false)
        #expect(!order.contains(7))
        #expect(order.contains(3))
        #expect(order.contains(10))
    }

    @Test func pageOrderOmitsOnboardingChatWhenIdentityKnown() {
        let order = OnboardingView.pageOrder(for: .local, showOnboardingChat: false)
        #expect(!order.contains(8))
    }

    @Test func pageOrderIncludesInstallPageInAllModes() {
        for mode: AppState.ConnectionMode in [.local, .remote, .unconfigured] {
            let order = OnboardingView.pageOrder(for: mode, showOnboardingChat: false)
            #expect(order.contains(10), "Install page missing for \(mode)")
        }
    }

    @Test func installPageIsSecondInPageOrder() {
        for mode: AppState.ConnectionMode in [.local, .remote, .unconfigured] {
            let order = OnboardingView.pageOrder(for: mode, showOnboardingChat: false)
            #expect(order.count >= 2)
            #expect(order[0] == 0, "First page should be welcome (0)")
            #expect(order[1] == 10, "Second page should be install (10) for \(mode)")
        }
    }
}
