#if os(macOS)
import Foundation
import Testing
@testable import OpenClawChatUI

struct ChatSidebarIdentityTests {
    @Test(arguments: [false, true])
    func `connected gateway replaces status without losing its announcement`(primary: Bool) {
        let subtitle = ChatSessionSidebarModel.IdentitySubtitle(
            healthy: true, gatewayName: "Workshop", isPrimary: primary)
        #expect(subtitle.text == "Workshop")
        #expect(subtitle.showsPrimary == primary)
        #expect(subtitle.isHealthy)
        #expect(subtitle.connectionStatus == String(localized: "Gateway connected"))
        #expect(subtitle.accessibilityText == (primary
                ? "Workshop, " + String(localized: "Primary") : "Workshop"))
    }

    @Test(arguments: [false, true])
    func `unhealthy connection replaces gateway and primary tag`(primary: Bool) {
        let subtitle = ChatSessionSidebarModel.IdentitySubtitle(
            healthy: false, gatewayName: "Workshop", isPrimary: primary)
        #expect(subtitle.text == String(localized: "Connecting…"))
        #expect(!subtitle.showsPrimary)
        #expect(!subtitle.isHealthy)
        #expect(subtitle.accessibilityText == subtitle.connectionStatus)
    }

    @Test func `missing gateway metadata does not invent a name or primary tag`() {
        let subtitle = ChatSessionSidebarModel.IdentitySubtitle(healthy: true, gatewayName: nil, isPrimary: true)
        #expect(subtitle.text == String(localized: "Gateway connected"))
        #expect(!subtitle.showsPrimary)
    }
}
#endif
