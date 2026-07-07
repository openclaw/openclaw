import OpenClawProtocol
import Testing

struct GatewayModelsCompatibilityTests {
    @Test
    func `plugin approval request params keeps reviewer devices additive`() {
        let params = PluginApprovalRequestParams(
            pluginid: nil,
            title: "Install plugin",
            description: "Review requested",
            severity: nil,
            toolname: nil,
            toolcallid: nil,
            alloweddecisions: nil,
            sessionkey: nil,
            turnsourcechannel: nil,
            turnsourceto: nil,
            turnsourceaccountid: nil,
            turnsourcethreadid: nil,
            timeoutms: nil,
            twophase: nil)

        #expect(params.approvalreviewerdeviceids == nil)
    }

    @Test
    func `message action params keeps requester account additive`() {
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
            idempotencykey: "test")

        #expect(params.requesteraccountid == nil)
    }
}
