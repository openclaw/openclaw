import Foundation
import Testing
@testable import OpenClaw

struct ExecHostRequestEvaluatorTests {
    @Test func `validate request rejects empty command`() {
        let request = ExecHostRequest(
            command: [],
            rawCommand: nil,
            cwd: nil,
            env: nil,
            timeoutMs: nil,
            needsScreenRecording: nil,
            agentId: nil,
            sessionKey: nil,
            approvalDecision: nil)
        switch ExecHostRequestEvaluator.validateRequest(request) {
        case .success:
            Issue.record("expected invalid request")
        case let .failure(error):
            #expect(error.code == "INVALID_REQUEST")
            #expect(error.message == "command required")
        }
    }

    @Test func `evaluate requires prompt on allowlist miss without decision`() {
        let context = Self.makeContext(security: .allowlist, ask: .onMiss, allowlistSatisfied: false, skillAllow: false)
        let decision = ExecHostRequestEvaluator.evaluate(context: context, approvalDecision: nil)
        switch decision {
        case .requiresPrompt:
            break
        case .allow:
            Issue.record("expected prompt requirement")
        case let .deny(error):
            Issue.record("unexpected deny: \(error.message)")
        }
    }

    @Test func `evaluate allows allow once decision on allowlist miss`() {
        let context = Self.makeContext(security: .allowlist, ask: .onMiss, allowlistSatisfied: false, skillAllow: false)
        let decision = ExecHostRequestEvaluator.evaluate(context: context, approvalDecision: .allowOnce)
        switch decision {
        case let .allow(approvedByAsk):
            #expect(approvedByAsk)
        case .requiresPrompt:
            Issue.record("expected allow decision")
        case let .deny(error):
            Issue.record("unexpected deny: \(error.message)")
        }
    }

    @Test func `evaluate denies denylist match before approval can allow`() {
        let context = Self.makeContext(
            security: .denylist,
            ask: .always,
            allowlistSatisfied: false,
            denylistDenied: true,
            skillAllow: false)
        let decision = ExecHostRequestEvaluator.evaluate(context: context, approvalDecision: .allowOnce)
        switch decision {
        case let .deny(error):
            #expect(error.reason == "denylist")
        case .requiresPrompt:
            Issue.record("expected denylist denial")
        case .allow:
            Issue.record("expected denylist denial")
        }
    }

    @Test func `evaluate denies denylist match in allowlist mode before approval can allow`() {
        let context = Self.makeContext(
            security: .allowlist,
            ask: .always,
            allowlistSatisfied: true,
            denylistDenied: true,
            skillAllow: false)
        let decision = ExecHostRequestEvaluator.evaluate(context: context, approvalDecision: .allowOnce)
        switch decision {
        case let .deny(error):
            #expect(error.reason == "denylist")
        case .requiresPrompt:
            Issue.record("expected denylist denial")
        case .allow:
            Issue.record("expected denylist denial")
        }
    }

    @Test func `quick mode preserves denylist security`() {
        #expect(ExecApprovalQuickMode.from(security: .denylist, ask: .off) == .denylist)
        #expect(ExecApprovalQuickMode.denylist.security == .denylist)
        #expect(ExecApprovalQuickMode.denylist.ask == .off)
    }

    @Test func `evaluate denies on explicit deny decision`() {
        let context = Self.makeContext(security: .full, ask: .off, allowlistSatisfied: true, skillAllow: false)
        let decision = ExecHostRequestEvaluator.evaluate(context: context, approvalDecision: .deny)
        switch decision {
        case let .deny(error):
            #expect(error.reason == "user-denied")
        case .requiresPrompt:
            Issue.record("expected deny decision")
        case .allow:
            Issue.record("expected deny decision")
        }
    }

    private static func makeContext(
        security: ExecSecurity,
        ask: ExecAsk,
        allowlistSatisfied: Bool,
        denylistDenied: Bool = false,
        skillAllow: Bool) -> ExecApprovalEvaluation
    {
        ExecApprovalEvaluation(
            command: ["/usr/bin/echo", "hi"],
            displayCommand: "/usr/bin/echo hi",
            agentId: nil,
            security: security,
            ask: ask,
            env: [:],
            resolution: nil,
            allowlistResolutions: [],
            allowAlwaysPatterns: [],
            allowlistMatches: [],
            allowlistSatisfied: allowlistSatisfied,
            allowlistMatch: nil,
            denylistDenied: denylistDenied,
            skillAllow: skillAllow)
    }
}
