import SwiftUI
import Testing
@testable import Clawdis

@Suite(.serialized)
@MainActor
struct OnboardingViewSmokeTests {
    @Test func onboardingViewBuildsBody() {
        let state = AppState(preview: true)
        let view = OnboardingView(
            state: state,
            permissionMonitor: PermissionMonitor.shared,
            discoveryModel: GatewayDiscoveryModel())
        _ = view.body
    }

    @Test func pageOrderOmitsWorkspaceAndIdentitySteps() {
        let order = OnboardingView.pageOrder(for: .local)
        #expect(!order.contains(7))
        #expect(!order.contains(3))
    }
}
