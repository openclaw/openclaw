import Testing
@testable import OpenClawKit

struct GatewayOperatorScopeAccessTests {
    @Test(arguments: [
        ("operator.read", true, false),
        ("operator.read.no-credential-enrollment", true, false),
        ("operator.write", true, true),
        ("operator.write.no-credential-enrollment", true, true),
        ("operator.admin", true, true),
        ("operator.sessions.write", false, false),
        ("operator.talk", false, false),
        ("operator.write.future", false, false),
        ("", false, false),
    ])
    func ordinaryCapabilities(scope: String, canRead: Bool, canWrite: Bool) {
        #expect(GatewayOperatorScopeAccess.allowsRead([scope]) == canRead)
        #expect(GatewayOperatorScopeAccess.allowsWrite([scope]) == canWrite)
    }

    @Test func restrictedWriteDoesNotSatisfyFullWriteTokenGrant() {
        #expect(GatewayChannelActor.requestedScopesExceedStoredToken(
            role: "operator",
            requestedScopes: ["operator.write"],
            storedToken: "synthetic-token",
            storedScopes: ["operator.write.no-credential-enrollment"]))
    }
}
