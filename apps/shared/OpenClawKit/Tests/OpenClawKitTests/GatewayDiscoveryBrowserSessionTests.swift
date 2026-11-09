import Network
import Testing
@testable import OpenClawKit

@MainActor
struct GatewayDiscoveryBrowserSessionTests {
    // Cancelling a browser still delivers its `.cancelled` state; after stop() that late
    // callback must not overwrite the caller's "Stopped" status or repopulate results.
    @Test func `stop silences late browser callbacks`() async throws {
        let session = GatewayDiscoveryBrowserSession()
        var stopped = false
        var lateCallbacks: [String] = []
        session.start(
            queueLabelPrefix: "ai.openclaw.tests.discovery",
            onState: { domain, state, status in
                if stopped { lateCallbacks.append("\(domain): \(state) -> \(status)") }
            },
            onResults: { domain, _ in
                if stopped { lateCallbacks.append("\(domain): results") }
            })
        session.stop()
        stopped = true
        try await Task.sleep(for: .milliseconds(500))
        #expect(lateCallbacks.isEmpty)
        #expect(!session.isRunning)
    }
}
