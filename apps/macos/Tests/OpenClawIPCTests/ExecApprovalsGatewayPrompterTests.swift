import Foundation
import OpenClawKit
import Testing
@testable import OpenClaw

@MainActor
struct ExecApprovalsGatewayPrompterTests {
    @Test(arguments: ["main", "other", "missing"], ["agent:main:native", "other", "missing"])
    func `native approvals require explicit selected agent and exact session facts`(
        agent: String,
        session: String) async throws
    {
        let fixture = try MacNativeActionFixture()
        do {
            let lease = try await fixture.gateway.acquireServerLease()
            let context = ExecApprovalsGatewayPrompter.PresentationContext(
                mode: .local,
                sessionKey: fixture.target.sessionKey,
                agentID: fixture.target.agentID,
                windowID: ObjectIdentifier(NSObject()),
                nativeBinding: .init(owner: fixture.target.owner, lease: lease))
            let request = ExecApprovalsGatewayPrompter.GatewayApprovalRequest(
                id: "approval",
                request: ExecApprovalPromptRequest(
                    command: "/usr/bin/printf bound",
                    agentId: agent == "missing" ? nil : agent,
                    sessionKey: session == "missing" ? nil : session),
                createdAtMs: 0,
                expiresAtMs: 10000)
            #expect(ExecApprovalsGatewayPrompter.shouldPresent(request: request, context: context) ==
                (agent == fixture.target.agentID && session == fixture.target.sessionKey))
        } catch {
            await fixture.gateway.shutdown()
            throw error
        }
        await fixture.gateway.shutdown()
    }

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
        #expect(!ExecApprovalsGatewayPrompter._testShouldPresent(
            mode: .remote, activeSession: "caf\u{e9}", requestSession: "cafe\u{301}", lastInputSeconds: 0))
    }

    @Test func `approval readback distinguishes replaced windows agents and exact session bytes`() {
        let originalWindow = NSObject()
        let replacementWindow = NSObject()
        let original = ExecApprovalsGatewayPrompter.PresentationContext(
            mode: .remote,
            sessionKey: "caf\u{e9}",
            agentID: "main",
            windowID: ObjectIdentifier(originalWindow))
        #expect(original != .init(
            mode: .remote,
            sessionKey: original.sessionKey,
            agentID: "main",
            windowID: ObjectIdentifier(replacementWindow)))
        #expect(original != .init(
            mode: .remote,
            sessionKey: "cafe\u{301}",
            agentID: "main",
            windowID: original.windowID))
        #expect(original != .init(
            mode: .remote,
            sessionKey: original.sessionKey,
            agentID: "other",
            windowID: original.windowID))
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

    @Test func `remote gateway requests without presentable UI are left unresolved`() {
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
}
