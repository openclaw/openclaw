import Testing
@testable import OpenClaw

@Suite(.serialized) struct GatewayConnectionIssueTests {
    @Test func detectsTokenMissing() {
        let issue = GatewayConnectionIssue.detect(from: "unauthorized: gateway token missing")
        #expect(issue == .tokenMissing)
        #expect(issue.needsAuthToken)
    }

    @Test func detectsUnauthorized() {
        let issue = GatewayConnectionIssue.detect(from: "Gateway error: unauthorized role")
        #expect(issue == .unauthorized)
        #expect(issue.needsAuthToken)
    }

    @Test func detectsPairingWithRequestId() {
        let issue = GatewayConnectionIssue.detect(from: "pairing required (requestId: abc123)")
        #expect(issue == .pairingRequired(requestId: "abc123"))
        #expect(issue.needsPairing)
        #expect(issue.requestId == "abc123")
    }

    @Test func detectsNetworkError() {
        let issue = GatewayConnectionIssue.detect(from: "Gateway error: Connection refused")
        #expect(issue == .network)
    }

    @Test func returnsNoneForBenignStatus() {
        let issue = GatewayConnectionIssue.detect(from: "Connected")
        #expect(issue == .none)
    }
}
