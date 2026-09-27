import Foundation
import OpenClawKit
import OpenClawProtocol
import Testing

struct GatewayAttachmentLimitsTests {
    @Test
    func `decodes hello attachment policy without inventing limits`() throws {
        for (policy, expected) in [
            (
                #"{"attachments":{"maxBytes":10485760,"maxImageBytes":5242880}}"#,
                GatewayAttachmentLimits(maxBytes: 10_485_760, maxImageBytes: 5_242_880)),
            (#"{"maxPayload":16777216}"#, nil),
            (#"{"attachments":{"maxBytes":0,"maxImageBytes":5242880}}"#, nil),
            (
                #"{"attachments":{"maxBytes":9223372036854775807,"maxImageBytes":9223372036854775807}}"#,
                GatewayAttachmentLimits(maxBytes: Int(Int32.max), maxImageBytes: Int(Int32.max))),
        ] {
            let data = Data("""
            {
              "type": "hello-ok", "protocol": 3, "server": {}, "features": {},
              "snapshot": {
                "presence": [], "health": {},
                "stateVersion": {"presence": 0, "health": 0}, "uptimeMs": 0
              },
              "auth": {}, "policy": \(policy)
            }
            """.utf8)
            let hello = try JSONDecoder().decode(HelloOk.self, from: data)
            #expect(hello.advertisedAttachmentLimits() == expected)
        }
    }
}
