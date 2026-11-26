import Testing
@testable import OpenClaw

@MainActor
struct LocalGatewayConnectionPresentationTests {
    @Test func `a local credential failure keeps readiness visible and offers help once`() throws {
        let credentialMessage = ControlChannel.storedGatewayTokenMessage
        let readiness = "Gateway listener found on port 18789 but health check failed: timed out"
        let presentation = try #require(LocalGatewayConnectionPresentation(
            mode: .local,
            state: .degraded(credentialMessage),
            readinessFailure: readiness))

        #expect(presentation.readinessFailure == readiness)
        #expect(presentation.credentialIssue?.message == credentialMessage)
        #expect(presentation.credentialIssue?.helpURL.absoluteString ==
            "https://github.com/openclaw/openclaw/issues/141413")
        #expect(presentation.duplicatesCredentialIssue(credentialMessage))
        #expect(!presentation.duplicatesCredentialIssue("Channel probe timed out"))
    }

    @Test func `an ownership rejection remains a readiness failure without credential help`() throws {
        let conflict = "Gateway port 18789 is already owned by another process or OpenClaw profile."
        let presentation = try #require(LocalGatewayConnectionPresentation(
            mode: .local,
            state: .degraded(conflict),
            readinessFailure: conflict))

        #expect(presentation.readinessFailure == conflict)
        #expect(presentation.credentialIssue == nil)
    }
}
