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
            discoveryModel: MasterDiscoveryModel())
        _ = view.body
    }
}
