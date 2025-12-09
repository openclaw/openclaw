import Foundation
import Testing
@testable import Clawdis

@Suite struct VoiceWakeOverlayTests {
    @Test func guardTokenDropsWhenNoActive() {
        let outcome = VoiceWakeOverlayController.evaluateToken(active: nil, incoming: UUID())
        #expect(outcome == .drop)
    }

    @Test func guardTokenAcceptsMatching() {
        let token = UUID()
        let outcome = VoiceWakeOverlayController.evaluateToken(active: token, incoming: token)
        #expect(outcome == .accept)
    }

    @Test func guardTokenDismissesMismatch() {
        let outcome = VoiceWakeOverlayController.evaluateToken(active: UUID(), incoming: UUID())
        #expect(outcome == .dismiss)
    }
}
