import Foundation
import Testing
@testable import OpenClaw

@Suite(.serialized)
@MainActor
struct OnboardingWizardTests {
    @Test func `uses startup failure reason when available`() {
        let description = onboardingGatewayReadyFailureDescription(status: .failed("openclaw CLI not found"))
        #expect(description == "openclaw CLI not found")
    }

    @Test func `uses generic message when startup failure reason is unavailable`() {
        let description = onboardingGatewayReadyFailureDescription(status: .starting)
        #expect(description == "Gateway did not become ready. Check that it is running.")
    }

    @Test func `sanitizes startup failure reason for display`() {
        let raw = "\(NSHomeDirectory())/openclaw\nfailed to start"
        let description = onboardingGatewayReadyFailureDescription(status: .failed(raw))
        #expect(!description.contains(NSHomeDirectory()))
        #expect(!description.contains("\n"))
        #expect(description.contains("~/openclaw"))
    }
}
