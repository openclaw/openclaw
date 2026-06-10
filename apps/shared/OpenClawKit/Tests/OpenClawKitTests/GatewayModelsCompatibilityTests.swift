import Foundation
import Testing
import OpenClawProtocol

struct GatewayModelsCompatibilityTests {
    @Test
    func chatSendFastModeBoolInitializerEncodesBoolean() throws {
        let params = ChatSendParams(
            sessionkey: "session",
            sessionid: nil,
            message: "hello",
            thinking: nil,
            fastmode: true,
            deliver: nil,
            originatingchannel: nil,
            originatingto: nil,
            originatingaccountid: nil,
            originatingthreadid: nil,
            attachments: nil,
            timeoutms: nil,
            systeminputprovenance: nil,
            systemprovenancereceipt: nil,
            suppresscommandinterpretation: nil,
            idempotencykey: "id"
        )

        #expect(params.fastmode == true)

        let data = try JSONEncoder().encode(params)
        let raw = try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
        #expect(raw["fastMode"] as? Bool == true)
        #expect(raw["fastAutoOnSeconds"] == nil)
    }

    @Test
    func chatSendFastModeNilInitializerRemainsUnambiguous() throws {
        let params = ChatSendParams(
            sessionkey: "session",
            sessionid: nil,
            message: "hello",
            thinking: nil,
            fastmode: nil,
            deliver: nil,
            originatingchannel: nil,
            originatingto: nil,
            originatingaccountid: nil,
            originatingthreadid: nil,
            attachments: nil,
            timeoutms: nil,
            systeminputprovenance: nil,
            systemprovenancereceipt: nil,
            suppresscommandinterpretation: nil,
            idempotencykey: "id"
        )

        #expect(params.fastmode == nil)
    }

    @Test
    func chatSendFastModeRawInitializerEncodesAuto() throws {
        let params = ChatSendParams(
            sessionkey: "session",
            sessionid: nil,
            message: "hello",
            thinking: nil,
            fastmodevalue: AnyCodable("auto"),
            fastautoonseconds: nil,
            deliver: nil,
            originatingchannel: nil,
            originatingto: nil,
            originatingaccountid: nil,
            originatingthreadid: nil,
            attachments: nil,
            timeoutms: nil,
            systeminputprovenance: nil,
            systemprovenancereceipt: nil,
            suppresscommandinterpretation: nil,
            idempotencykey: "id"
        )

        #expect(params.fastmode == nil)

        let data = try JSONEncoder().encode(params)
        let raw = try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
        #expect(raw["fastMode"] as? String == "auto")
        #expect(raw["fastAutoOnSeconds"] == nil)
    }
}
