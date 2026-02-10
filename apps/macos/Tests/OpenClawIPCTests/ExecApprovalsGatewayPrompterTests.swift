import Testing
@testable import OpenClaw

@MainActor
struct ExecApprovalsGatewayPrompterTests {
    @Test func `session match prefers active session`() {
        let matches = ExecApprovalsGatewayPrompter._testShouldPresent(
            mode: .remote,
            activeSession: " main ",
            requestSession: "main",
            lastInputSeconds: nil)
        #expect(matches)

        let mismatched = ExecApprovalsGatewayPrompter._testShouldPresent(
            mode: .remote,
            activeSession: "other",
            requestSession: "main",
            lastInputSeconds: 0)
        #expect(!mismatched)
    }

    @Test func `session fallback uses recent activity`() {
        let recent = ExecApprovalsGatewayPrompter._testShouldPresent(
            mode: .remote,
            activeSession: nil,
            requestSession: "main",
            lastInputSeconds: 10,
            thresholdSeconds: 120)
        #expect(recent)

        let stale = ExecApprovalsGatewayPrompter._testShouldPresent(
            mode: .remote,
            activeSession: nil,
            requestSession: "main",
            lastInputSeconds: 200,
            thresholdSeconds: 120)
        #expect(!stale)
    }

    @Test func `default behavior matches mode`() {
        let local = ExecApprovalsGatewayPrompter._testShouldPresent(
            mode: .local,
            activeSession: nil,
            requestSession: nil,
            lastInputSeconds: 400)
        #expect(local)

        let remote = ExecApprovalsGatewayPrompter._testShouldPresent(
            mode: .remote,
            activeSession: nil,
            requestSession: nil,
            lastInputSeconds: 400)
        #expect(!remote)
    }

    // MARK: - needsApproval

    @Test func askAlwaysNeedsApprovalRegardlessOfSecurity() {
        #expect(ExecApprovalsGatewayPrompter._testNeedsApproval(security: .deny, ask: .always))
        #expect(ExecApprovalsGatewayPrompter._testNeedsApproval(security: .allowlist, ask: .always))
        #expect(ExecApprovalsGatewayPrompter._testNeedsApproval(security: .full, ask: .always))
    }

    @Test func askOnMissNeedsApprovalOnlyForAllowlist() {
        #expect(ExecApprovalsGatewayPrompter._testNeedsApproval(security: .allowlist, ask: .onMiss))
        #expect(!ExecApprovalsGatewayPrompter._testNeedsApproval(security: .deny, ask: .onMiss))
        #expect(!ExecApprovalsGatewayPrompter._testNeedsApproval(security: .full, ask: .onMiss))
    }

    @Test func askOffNeverNeedsApproval() {
        #expect(!ExecApprovalsGatewayPrompter._testNeedsApproval(security: .deny, ask: .off))
        #expect(!ExecApprovalsGatewayPrompter._testNeedsApproval(security: .allowlist, ask: .off))
        #expect(!ExecApprovalsGatewayPrompter._testNeedsApproval(security: .full, ask: .off))
    }
}
