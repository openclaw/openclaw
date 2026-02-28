import SwiftUI
import Testing

@testable import OpenClawWatch

@Suite("WatchStatusBadge")
struct WatchStatusBadgeTests {
    @Test func connectedProperties() {
        let status = WatchStatusBadge.Status.connected
        #expect(status.label == "Connected")
        #expect(status.icon == "checkmark.circle.fill")
        #expect(status.tint == .green)
    }

    @Test func disconnectedProperties() {
        let status = WatchStatusBadge.Status.disconnected
        #expect(status.label == "Disconnected")
        #expect(status.icon == "xmark.circle.fill")
        #expect(status.tint == .red)
    }

    @Test func pendingProperties() {
        let status = WatchStatusBadge.Status.pending
        #expect(status.label == "Pending")
        #expect(status.icon == "clock.fill")
        #expect(status.tint == .orange)
    }
}
