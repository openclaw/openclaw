import Foundation
import Testing
@testable import OpenClaw

@Suite(.serialized)
@MainActor
struct OnboardingWizardTests {
    @Test func `uses startup failure reason when available`() {
        let description = onboardingGatewayReadyFailureDescription(status: .failed("openclaw CLI not found"))
        #expect(description == "OpenClaw CLI not found. Install the CLI and try again.")
    }

    @Test func `uses generic message when startup failure reason is unavailable`() {
        let description = onboardingGatewayReadyFailureDescription(status: .starting)
        #expect(description == "Gateway did not become ready. Check that it is running.")
    }

    @Test func `maps timeout failures to safe message`() {
        let description = onboardingGatewayReadyFailureDescription(status: .failed("Gateway did not start in time"))
        #expect(description == "Gateway did not start in time. Check Gateway logs and try again.")
    }

    @Test func `falls back to generic failure message for unclassified content`() {
        let raw = "mysterious\u{202E}\n\tfailure at /Volumes/secret/path"
        let description = onboardingGatewayReadyFailureDescription(status: .failed(raw))
        #expect(description == "Gateway failed to start. Check Gateway logs for details.")
    }
}
