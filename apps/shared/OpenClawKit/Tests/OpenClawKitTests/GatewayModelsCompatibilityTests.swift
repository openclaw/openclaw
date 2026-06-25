import OpenClawProtocol
import Testing

struct GatewayModelsCompatibilityTests {
    @Test
    func messageActionParamsKeepsRequesterAccountAdditive() {
        let params = MessageActionParams(
            channel: "slack",
            action: "member-info",
            params: [:],
            accountid: "default",
            requestersenderid: "U123",
            senderisowner: true,
            sessionkey: nil,
            sessionid: nil,
            toolcontext: nil,
            idempotencykey: "test"
        )

        #expect(params.requesteraccountid == nil)
    }
}
