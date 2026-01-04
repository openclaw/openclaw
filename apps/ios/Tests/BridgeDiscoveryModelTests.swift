import Testing
@testable import Clawdbot

@Suite(.serialized) struct BridgeDiscoveryModelTests {
    @Test @MainActor func debugLoggingCapturesLifecycleAndResets() {
        let model = BridgeDiscoveryModel()

        #expect(model.debugLog.isEmpty)
        #expect(model.statusText == "Idle")

        model.setDebugLoggingEnabled(true)
        #expect(model.debugLog.count >= 2)

        model.stop()
        #expect(model.statusText == "Stopped")
        #expect(model.bridges.isEmpty)
        #expect(model.debugLog.count >= 3)

        model.setDebugLoggingEnabled(false)
        #expect(model.debugLog.isEmpty)
    }
}
