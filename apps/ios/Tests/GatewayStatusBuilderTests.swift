import OpenClawKit
import Testing
@testable import OpenClaw

@Suite struct GatewayStatusBuilderTests {
    @Test func pausedProblemKeepsErrorStatus() {
        let state = GatewayStatusBuilder.build(
            gatewayServerName: nil,
            lastGatewayProblem: GatewayConnectionProblem(
                kind: .pairingRequired,
                owner: .gateway,
                title: "Pairing required",
                message: "Approve this device before reconnecting.",
                requestId: "req-123",
                retryable: false,
                pauseReconnect: true),
            gatewayStatusText: "Reconnecting…")

        #expect(state == .error)
    }

    @Test func transientProblemAllowsConnectingStatus() {
        let state = GatewayStatusBuilder.build(
            gatewayServerName: nil,
            lastGatewayProblem: GatewayConnectionProblem(
                kind: .timeout,
                owner: .network,
                title: "Connection timed out",
                message: "The gateway did not respond before the connection timed out.",
                retryable: true,
                pauseReconnect: false),
            gatewayStatusText: "Reconnecting…")

        #expect(state == .connecting)
    }

    @Test func chatGatewayPillLabelsMatchDisplayState() {
        #expect(ChatProTab.gatewayPillTitle(state: .disconnected, isGatewayUsable: false) == "Offline")
        #expect(ChatProTab.gatewayPillTitle(state: .connecting, isGatewayUsable: false) == "Connecting")
        #expect(ChatProTab.gatewayPillTitle(state: .error, isGatewayUsable: false) == "Attention")
        #expect(ChatProTab.gatewayPillTitle(state: .connected, isGatewayUsable: true) == "Connected")
        #expect(ChatProTab.gatewayPillTitle(state: .connected, isGatewayUsable: false) == "Unavailable")
    }
}
