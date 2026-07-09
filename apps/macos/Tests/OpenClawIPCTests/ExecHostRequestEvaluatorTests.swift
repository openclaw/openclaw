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

    @Test func `validate request rejects a blank executable`() {
        let request = ExecHostRequest(
            command: [" \t\n", "operand"],
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

    @Test func `validate request preserves argv exactly`() {
        let command = ["/usr/bin/printf", "<%s>|<%s>", "  padded  ", "-n"]
        let request = ExecHostRequest(
            command: command,
            rawCommand: nil,
            cwd: nil,
            env: nil,
            timeoutMs: nil,
            needsScreenRecording: nil,
            agentId: nil,
            sessionKey: nil,
            approvalDecision: nil)

        switch ExecHostRequestEvaluator.validateRequest(request) {
        case let .success(validated):
            #expect(validated.command == command)
        case let .failure(error):
            Issue.record("unexpected invalid request: \(error.message)")
        }
    }

    @Test func `validate request separates canonical wrapper display from allowlist payload`() {
        let command = ["/bin/sh", "-lc", "/usr/bin/printf ok"]
        let request = ExecHostRequest(
            command: command,
            rawCommand: "/usr/bin/printf ok",
            cwd: nil,
            env: nil,
            timeoutMs: nil,
            needsScreenRecording: nil,
            agentId: nil,
            sessionKey: nil,
            approvalDecision: nil)

        switch ExecHostRequestEvaluator.validateRequest(request) {
        case let .success(validated):
            #expect(validated.command == command)
            #expect(validated.displayCommand == ExecCommandFormatter.displayString(for: command))
            #expect(validated.evaluationRawCommand == "/usr/bin/printf ok")
            #expect(validated.displayCommand != validated.evaluationRawCommand)
        case let .failure(error):
            Issue.record("unexpected invalid request: \(error.message)")
        }
    }

    @Test func `validate request rejects a padded executable without normalizing it`() {
        let request = ExecHostRequest(
            command: [" /usr/bin/touch ", "/tmp/must-not-run"],
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
            #expect(error.message == "executable has surrounding whitespace")
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
        skillAllow: Bool) -> ExecApprovalEvaluation
    {
        ExecApprovalEvaluation(
            displayCommand: "/usr/bin/echo hi",
            agentId: nil,
            security: security,
            ask: ask,
            env: [:],
            resolution: nil,
            allowlistResolutions: [],
            boundCommand: nil,
            allowAlwaysPatterns: [],
            allowlistMatches: [],
            allowlistSatisfied: allowlistSatisfied,
            allowlistMatch: nil,
            skillAllow: skillAllow)
    }
}
