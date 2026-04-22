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

    // MARK: - Enhanced coverage for extractRequestId robustness

    @Test func extractsRequestIdCaseInsensitively() {
        // Lowercase (original)
        let issue1 = GatewayConnectionIssue.detect(from: "pairing required (requestId: abc123)")
        #expect(issue1 == .pairingRequired(requestId: "abc123"))

        // Uppercase marker
        let issue2 = GatewayConnectionIssue.detect(from: "pairing required (RequestId: xyz789)")
        #expect(issue2 == .pairingRequired(requestId: "xyz789"))

        // Mixed case
        let issue3 = GatewayConnectionIssue.detect(from: "pairing required (REQUESTID: mixedCase123)")
        #expect(issue3 == .pairingRequired(requestId: "mixedCase123"))
    }

    @Test func extractsRequestIdWithVariousFormats() {
        // With hyphens and underscores
        let issue1 = GatewayConnectionIssue.detect(from: "pairing required (requestId: abc-123_def)")
        #expect(issue1 == .pairingRequired(requestId: "abc-123_def"))

        // With trailing delimiter before closing paren
        let issue2 = GatewayConnectionIssue.detect(from: "pairing required (requestId: id-with-dash; and more)")
        #expect(issue2 == .pairingRequired(requestId: "id-with-dash"))

        // With extra whitespace around marker
        let issue3 = GatewayConnectionIssue.detect(from: "pairing required ( requestId:   spaced123   )")
        #expect(issue3 == .pairingRequired(requestId: "spaced123"))
    }

    @Test func returnsNoneWhenRequestIdMarkerAbsent() {
        let issue = GatewayConnectionIssue.detect(from: "pairing required (no marker here)")
        #expect(issue == .pairingRequired(requestId: nil))
    }

    @Test func detectsOtherErrorsEvenWhenRequestIdPresentButNotPairing() {
        // `extractRequestId` is called only on the pairing branch. Even if the status
        // text contains a requestId marker, it should be ignored when the issue resolves
        // to something other than .pairingRequired.
        let issue = GatewayConnectionIssue.detect(from: "gateway error: unauthorized (requestId: should-be-ignored)")
        #expect(issue == .unauthorized)
        #expect(issue.requestId == nil)
    }
}
