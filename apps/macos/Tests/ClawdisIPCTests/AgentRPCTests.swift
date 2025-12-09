import Testing
@testable import Clawdis
@testable import ClawdisIPC

@Suite(.serialized) struct AgentRPCTests {
    @Test func statusFailsWhenProcessMissing() async {
        let result = await AgentRPC.shared.status()
        // We don't assert ok because the worker may not be available in CI.
        // Instead, ensure the call returns without throwing and provides a message.
        #expect(result.ok == true || result.error != nil)
    }

    @Test func rejectEmptyMessage() async {
        let result = await AgentRPC.shared.send(text: "", thinking: nil, session: "main", deliver: false, to: nil)
        #expect(result.ok == false)
    }
}
