import Testing
@testable import OpenClaw

@Suite struct NodeBackgroundAliveBeaconTests {
    @Test func doesNotThrottleWithoutPriorSuccess() {
        #expect(
            NodeAppModel._test_shouldThrottleBackgroundAliveBeacon(
                lastSuccessAtMs: nil,
                nowMs: 10_000,
                minimumIntervalMs: 60_000) == false)
    }

    @Test func throttlesWithinMinimumInterval() {
        #expect(
            NodeAppModel._test_shouldThrottleBackgroundAliveBeacon(
                lastSuccessAtMs: 100_000,
                nowMs: 120_000,
                minimumIntervalMs: 60_000))
    }

    @Test func doesNotThrottleAtBoundaryOrAfter() {
        #expect(
            NodeAppModel._test_shouldThrottleBackgroundAliveBeacon(
                lastSuccessAtMs: 100_000,
                nowMs: 160_000,
                minimumIntervalMs: 60_000) == false)
        #expect(
            NodeAppModel._test_shouldThrottleBackgroundAliveBeacon(
                lastSuccessAtMs: 100_000,
                nowMs: 200_000,
                minimumIntervalMs: 60_000) == false)
    }

    @Test func doesNotThrottleWhenClockMovesBackward() {
        #expect(
            NodeAppModel._test_shouldThrottleBackgroundAliveBeacon(
                lastSuccessAtMs: 200_000,
                nowMs: 100_000,
                minimumIntervalMs: 60_000) == false)
    }

    @Test func recentSuccessDoesNotSkipReconnectWhenGatewayIsDisconnected() {
        #expect(
            NodeAppModel._test_shouldSkipBackgroundAliveBeaconBecauseOfRecentSuccess(
                lastSuccessAtMs: 100_000,
                nowMs: 120_000,
                minimumIntervalMs: 60_000,
                gatewayConnected: false) == false)
        #expect(
            NodeAppModel._test_shouldSkipBackgroundAliveBeaconBecauseOfRecentSuccess(
                lastSuccessAtMs: 100_000,
                nowMs: 120_000,
                minimumIntervalMs: 60_000,
                gatewayConnected: true))
    }

    @Test func recentSuccessCountsAsHandledWake() {
        #expect(
            NodeAppModel._test_shouldTreatBackgroundAliveWakeAsHandled(
                applied: false,
                reason: "recent_success"))
        #expect(
            NodeAppModel._test_shouldTreatBackgroundAliveWakeAsHandled(
                applied: false,
                reason: "beacon_failed") == false)
    }
}
