import Testing
@testable import OpenClaw

struct NodePairingReconcilePolicyTests {
    @Test func `policy polls only when active`() {
        #expect(NodePairingReconcilePolicy.shouldPoll(pendingCount: 0, isPresenting: false) == false)
        #expect(NodePairingReconcilePolicy.shouldPoll(pendingCount: 1, isPresenting: false))
        #expect(NodePairingReconcilePolicy.shouldPoll(pendingCount: 0, isPresenting: true))
    }

    @Test func `policy uses slow safety interval`() {
        #expect(NodePairingReconcilePolicy.activeIntervalMs >= 10000)
    }
}
