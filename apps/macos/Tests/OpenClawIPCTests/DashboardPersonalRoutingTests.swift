import Foundation
import Testing
@testable import OpenClaw

@Suite(.serialized)
@MainActor
struct DashboardPersonalRoutingTests {
    @Test func `local personal identity uses the verified primary route`() {
        let key = "gateway.primary.personalIdentityEnabled"
        let original = AppDefaults.standard.object(forKey: key)
        defer {
            if let original {
                AppDefaults.standard.set(original, forKey: key)
            } else {
                AppDefaults.standard.removeObject(forKey: key)
            }
        }
        AppDefaults.standard.set(true, forKey: key)
        #expect(DashboardManager.immediateDashboardEndpoint(mode: .local) == nil)
    }
}
