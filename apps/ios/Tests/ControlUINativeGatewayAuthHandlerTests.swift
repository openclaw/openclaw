import Foundation
import Testing
@testable import OpenClaw

@MainActor
struct ControlUINativeGatewayAuthHandlerTests {
    @Test func `request accepts only the exact challenge shape`() {
        let valid: [String: Any] = ["id": "a", "nonce": "n-1", "signedAt": 1_700_000_000_000]
        #expect(ControlUINativeGatewayAuthHandler.Request(valid)?.signedAt == 1_700_000_000_000)

        var extra = valid
        extra["token"] = "x"
        var pipe = valid
        pipe["nonce"] = "a|b"
        var fractional = valid
        fractional["signedAt"] = 1.5
        var negative = valid
        negative["signedAt"] = -1
        var boolean = valid
        boolean["signedAt"] = true
        var empty = valid
        empty["id"] = ""
        for body in [extra, pipe, fractional, negative, boolean, empty] as [[String: Any]] {
            #expect(ControlUINativeGatewayAuthHandler.Request(body) == nil)
        }
        #expect(ControlUINativeGatewayAuthHandler.Request("nope") == nil)
    }
}
