import Testing
@testable import Clawdis

@Suite struct IOSBridgeChatTransportTests {
    @Test func requestsFailFastWhenBridgeNotConnected() async {
        let bridge = BridgeSession()
        let transport = IOSBridgeChatTransport(bridge: bridge)

        do {
            try await transport.setActiveSessionKey("node-test")
            Issue.record("Expected setActiveSessionKey to throw when bridge not connected")
        } catch {}

        do {
            _ = try await transport.requestHistory(sessionKey: "node-test")
            Issue.record("Expected requestHistory to throw when bridge not connected")
        } catch {}

        do {
            _ = try await transport.sendMessage(
                sessionKey: "node-test",
                message: "hello",
                thinking: "low",
                idempotencyKey: "idempotency",
                attachments: [])
            Issue.record("Expected sendMessage to throw when bridge not connected")
        } catch {}

        do {
            _ = try await transport.requestHealth(timeoutMs: 250)
        } catch {}
    }
}

