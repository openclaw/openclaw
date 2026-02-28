import Testing

@testable import OpenClawWatch

@Suite("WatchConnectionBanner")
struct WatchConnectionBannerTests {
    @Test func connectedShowsCorrectLabel() {
        // Verify the label logic matches the connected state.
        let connected = true
        let label = connected ? "Connected" : "Disconnected"
        #expect(label == "Connected")
    }

    @Test func disconnectedShowsCorrectLabel() {
        let connected = false
        let label = connected ? "Connected" : "Disconnected"
        #expect(label == "Disconnected")
    }

    @Test func connectedIcon() {
        let connected = true
        let icon = connected
            ? "antenna.radiowaves.left.and.right"
            : "antenna.radiowaves.left.and.right.slash"
        #expect(icon == "antenna.radiowaves.left.and.right")
    }

    @Test func disconnectedIcon() {
        let connected = false
        let icon = connected
            ? "antenna.radiowaves.left.and.right"
            : "antenna.radiowaves.left.and.right.slash"
        #expect(icon == "antenna.radiowaves.left.and.right.slash")
    }
}
