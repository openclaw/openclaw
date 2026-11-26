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
        #expect(!presentation.offersDashboardSettings)
        #expect(presentation.credentialHelpPlacement(healthFailure: credentialMessage) == .healthCheck)
        #expect(presentation.credentialHelpPlacement(healthFailure: "Channel probe timed out") == .connectionStatus)
        #expect(presentation.credentialHelpPlacement(healthFailure: nil) == .connectionStatus)
    }

    @Test func `an ownership rejection remains a readiness failure without credential help`() throws {
        let conflict = "Gateway port 18789 is already owned by another process or OpenClaw profile."
        let presentation = try #require(LocalGatewayConnectionPresentation(
            mode: .local,
            state: .degraded(conflict),
            readinessFailure: conflict))

        #expect(presentation.readinessFailure == conflict)
        #expect(presentation.credentialIssue == nil)
        #expect(presentation.offersDashboardSettings)
        #expect(presentation.credentialHelpPlacement(healthFailure: conflict) == nil)
    }

    @Test(arguments: [AppState.ConnectionMode.remote, .unconfigured])
    func `a nonlocal route does not inherit the local credential action policy`(mode: AppState.ConnectionMode) {
        let presentation = LocalGatewayConnectionPresentation(
            mode: mode,
            state: .degraded(ControlChannel.storedGatewayTokenMessage),
            readinessFailure: nil)

        #expect(presentation == nil)
    }
}
