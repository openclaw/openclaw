import Foundation
import OpenClawNativeActions
import Testing

struct NativeActionsTests {
    @Test(arguments: 0..<4)
    func `selectors preserve exact UTF 8`(field: Int) throws {
        func reference(_ suffix: String) -> OpenClawNativeRunRef {
            OpenClawNativeRunRef(
                session: OpenClawNativeSessionRef(
                    owner: OpenClawNativeOwnerRef(
                        gatewayID: field == 0 ? suffix : "gateway-a",
                        profileID: field == 1 ? suffix : "profile-a"),
                    agentID: "agent-a",
                    sessionKey: field == 2 ? "agent:agent-a:\(suffix)" : "agent:agent-a:main"),
                runID: field == 3 ? suffix : "run-a")
        }
        let composed = reference("\u{E9}")
        let decomposed = reference("e\u{301}")
        #expect(composed != decomposed)
        #expect(Set([composed, decomposed]).count == 2)

        let restored = try JSONDecoder().decode(
            OpenClawNativeRunRef.self,
            from: JSONEncoder().encode(decomposed))
        #expect(restored == decomposed)
        #expect(restored != composed)
    }

    @Test
    func `decoding does not fill in or normalize owner fields`() throws {
        let data = Data(
            #"{"gatewayID":" Gateway-A ","profileID":"Profile-A"}"#.utf8)
        let owner = try JSONDecoder().decode(OpenClawNativeOwnerRef.self, from: data)
        #expect(owner.gatewayID == " Gateway-A ")
        #expect(owner.profileID == "Profile-A")
        #expect(throws: DecodingError.self) {
            try JSONDecoder().decode(
                OpenClawNativeOwnerRef.self,
                from: Data(#"{"gatewayID":"gateway-a"}"#.utf8))
        }
    }
}
