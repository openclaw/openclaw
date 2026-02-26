import Foundation

struct ExecHostValidatedRequest {
    let command: [String]
    let displayCommand: String
}

enum ExecHostPolicyDecision {
    case deny(ExecHostError)
    case requiresPrompt
    case allow(approvedByAsk: Bool)
}

enum ExecHostRequestEvaluator {
    static func validateRequest(_ request: ExecHostRequest) -> Result<ExecHostValidatedRequest, ExecHostError> {
        let command = request.command.map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
        guard !command.isEmpty else {
            return .failure(
                ExecHostError(
                    code: "INVALID_REQUEST",
                    message: "command required",
                    reason: "invalid"))
        }

        let validatedCommand = ExecSystemRunCommandValidator.resolve(
            command: command,
            rawCommand: request.rawCommand)
        switch validatedCommand {
        case let .ok(resolved):
            return .success(ExecHostValidatedRequest(command: command, displayCommand: resolved.displayCommand))
        case let .invalid(message):
            return .failure(
                ExecHostError(
                    code: "INVALID_REQUEST",
                    message: message,
                    reason: "invalid"))
        }
    }

    static func evaluate(
        context: ExecApprovalEvaluation,
        approvalDecision: ExecApprovalDecision?) -> ExecHostPolicyDecision
    {
        if context.security == .deny {
            return .deny(
                ExecHostError(
                    code: "UNAVAILABLE",
                    message: "SYSTEM_RUN_DISABLED: security=deny",
                    reason: "security=deny"))
        }

        if approvalDecision == .deny {
            return .deny(
                ExecHostError(
                    code: "UNAVAILABLE",
                    message: "SYSTEM_RUN_DENIED: user denied",
                    reason: "user-denied"))
        }

        let approvedByAsk = approvalDecision != nil
        let requiresPrompt = ExecApprovalHelpers.requiresAsk(
            ask: context.ask,
            security: context.security,
            allowlistMatch: context.allowlistMatch,
            skillAllow: context.skillAllow) && approvalDecision == nil
        if requiresPrompt {
            return .requiresPrompt
        }

        if context.security == .allowlist,
           !context.allowlistSatisfied,
           !context.skillAllow,
           !approvedByAsk
        {
            return .deny(
                ExecHostError(
                    code: "UNAVAILABLE",
                    message: "SYSTEM_RUN_DENIED: allowlist miss",
                    reason: "allowlist-miss"))
        }

        return .allow(approvedByAsk: approvedByAsk)
    }
}
