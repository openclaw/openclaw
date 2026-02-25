import OpenClawKit
import Testing
@testable import OpenClaw

@Suite struct DeepLinkAgentPolicyTests {
    @Test func validateMessageForHandleRejectsTooLongWhenUnkeyed() {
        let msg = String(repeating: "a", count: DeepLinkAgentPolicy.maxUnkeyedConfirmChars + 1)
        let res = DeepLinkAgentPolicy.validateMessageForHandle(message: msg, allowUnattended: false)
        switch res {
        case let .failure(error):
            #expect(
                error == .messageTooLongForConfirmation(
                    max: DeepLinkAgentPolicy.maxUnkeyedConfirmChars,
                    actual: DeepLinkAgentPolicy.maxUnkeyedConfirmChars + 1))
        case .success:
            Issue.record("expected failure, got success")
        }
    }

    @Test func validateMessageForHandleAllowsTooLongWhenKeyed() {
        let msg = String(repeating: "a", count: DeepLinkAgentPolicy.maxUnkeyedConfirmChars + 1)
        let res = DeepLinkAgentPolicy.validateMessageForHandle(message: msg, allowUnattended: true)
        switch res {
        case .success:
            break
        case let .failure(error):
            Issue.record("expected success, got failure: \(error)")
        }
    }

    @Test func effectiveDeliveryIgnoresDeliveryFieldsWhenUnkeyed() {
        let link = AgentDeepLink(
            message: "Hello",
            sessionKey: "s",
            thinking: "low",
            deliver: true,
            to: "+15551234567",
            channel: "whatsapp",
            timeoutSeconds: 10,
            key: nil)
        let res = DeepLinkAgentPolicy.effectiveDelivery(link: link, allowUnattended: false)
        #expect(res.deliver == false)
        #expect(res.to == nil)
        #expect(res.channel == .last)
    }

    @Test func effectiveDeliveryHonorsDeliverForDeliverableChannelsWhenKeyed() {
        let link = AgentDeepLink(
            message: "Hello",
            sessionKey: "s",
            thinking: "low",
            deliver: true,
            to: "  +15551234567 ",
            channel: "whatsapp",
            timeoutSeconds: 10,
            key: "secret")
        let res = DeepLinkAgentPolicy.effectiveDelivery(link: link, allowUnattended: true)
        #expect(res.deliver == true)
        #expect(res.to == "+15551234567")
        #expect(res.channel == .whatsapp)
    }

    @Test func effectiveDeliveryStillBlocksWebChatDeliveryWhenKeyed() {
        let link = AgentDeepLink(
            message: "Hello",
            sessionKey: "s",
            thinking: "low",
            deliver: true,
            to: "+15551234567",
            channel: "webchat",
            timeoutSeconds: 10,
            key: "secret")
        let res = DeepLinkAgentPolicy.effectiveDelivery(link: link, allowUnattended: true)
        #expect(res.deliver == false)
        #expect(res.channel == .webchat)
    }
}
