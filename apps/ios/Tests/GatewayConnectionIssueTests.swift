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

    @Test func detectsNetworkTimedOut() {
        let issue = GatewayConnectionIssue.detect(from: "The request timed out")
        #expect(issue == .network)
    }

    @Test func detectsNetworkUnreachable() {
        let issue = GatewayConnectionIssue.detect(from: "network is unreachable")
        #expect(issue == .network)
    }

    @Test func detectsNetworkCannotFindHost() {
        let issue = GatewayConnectionIssue.detect(from: "cannot find host gateway.local")
        #expect(issue == .network)
    }

    @Test func detectsNetworkCouldNotConnect() {
        let issue = GatewayConnectionIssue.detect(from: "could not connect to server")
        #expect(issue == .network)
    }

    @Test func detectsPairingNotPairedUnderscore() {
        let issue = GatewayConnectionIssue.detect(from: "not_paired")
        #expect(issue == .pairingRequired(requestId: nil))
        #expect(issue.needsPairing)
        #expect(issue.requestId == nil)
    }

    @Test func detectsPairingNotPairedSpaced() {
        let issue = GatewayConnectionIssue.detect(from: "device not paired")
        #expect(issue == .pairingRequired(requestId: nil))
        #expect(issue.needsPairing)
    }

    @Test func detectsPairingCaseInsensitive() {
        let issue = GatewayConnectionIssue.detect(from: "PAIRING REQUIRED")
        #expect(issue == .pairingRequired(requestId: nil))
        #expect(issue.needsPairing)
    }

    @Test func detectsUnknownGatewayError() {
        let raw = "Gateway error: internal server error"
        let issue = GatewayConnectionIssue.detect(from: raw)
        #expect(issue == .unknown(raw))
    }

    @Test func returnsNoneForEmptyStatus() {
        #expect(GatewayConnectionIssue.detect(from: "") == .none)
        #expect(GatewayConnectionIssue.detect(from: "   \n\t  ") == .none)
    }

    @Test func returnsNoneForBenignStatus() {
        let issue = GatewayConnectionIssue.detect(from: "Connected")
        #expect(issue == .none)
    }
}
