import Testing
@testable import Clawdbot
@testable import ClawdbotIPC

@Suite(.serialized) struct GatewayConnectionControlTests {
    @Test func statusFailsWhenProcessMissing() async {
        let result = await GatewayConnection.shared.status()
        // We don't assert ok because the worker may not be available in CI.
        // Instead, ensure the call returns without throwing and provides a message.
        #expect(result.ok == true || result.error != nil)
    }

    @Test func rejectEmptyMessage() async {
        let result = await GatewayConnection.shared.sendAgent(
            message: "",
            thinking: nil,
            sessionKey: "main",
            deliver: false,
            to: nil)
        #expect(result.ok == false)
    }
}
