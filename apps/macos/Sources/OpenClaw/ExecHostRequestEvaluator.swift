import Foundation

struct ExecHostValidatedRequest {
    let command: [String]
    let displayCommand: String
    let evaluationRawCommand: String?
    let approvalSource: ExecApprovalRequestSource?
    let delayedPolicySnapshot: ExecApprovalPolicySnapshot?
}

enum ExecHostPolicyDecision {
    case deny(ExecHostError)
    case requiresPrompt
    case allow
}

enum ExecHostRequestEvaluator {
    static func validateRequest(_ request: ExecHostRequest) -> Result<ExecHostValidatedRequest, ExecHostError> {
        func invalid(_ message: String) -> Result<ExecHostValidatedRequest, ExecHostError> {
            .failure(ExecHostError(code: "INVALID_REQUEST", message: message, reason: "invalid"))
        }
        let approvalSource: ExecApprovalRequestSource?
        switch request.approvalSource {
        case nil:
            approvalSource = nil
        case "ask-fallback":
            approvalSource = .askFallback
        case "auto-review":
            approvalSource = .autoReview
        default:
            return invalid("approvalSource invalid")
        }
        if approvalSource != nil, request.approvalDecision != nil {
            return invalid("approvalSource cannot be combined with explicit approval")
        }
        let carriesDelayedAuthority = approvalSource == .autoReview ||
            request.approvalDecision == .allowOnce ||
            request.approvalDecision == .allowAlways
        let delayedPolicySnapshot: ExecApprovalPolicySnapshot?
        if carriesDelayedAuthority {
            guard let policySnapshot = request.policySnapshot else {
                return invalid("delayed approval requires a prepared policy snapshot")
            }
            delayedPolicySnapshot = ExecApprovalPolicySnapshot(portable: policySnapshot)
        } else {
            delayedPolicySnapshot = nil
        }
        let executable = request.command.first ?? ""
        let trimmedExecutable = executable.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedExecutable.isEmpty else {
            return invalid("command required")
        }
        guard executable == trimmedExecutable else {
            return invalid("executable has surrounding whitespace")
        }

        let validatedCommand = ExecSystemRunCommandValidator.resolve(
            command: request.command,
            rawCommand: request.rawCommand)
        switch validatedCommand {
        case let .ok(resolved):
            return .success(ExecHostValidatedRequest(
                command: request.command,
                displayCommand: resolved.displayCommand,
                evaluationRawCommand: resolved.evaluationRawCommand,
                approvalSource: approvalSource,
                delayedPolicySnapshot: delayedPolicySnapshot))
        case let .invalid(message):
            return invalid(message)
        }
    }

    static func evaluate(
        context: ExecApprovalEvaluation,
        approvalDecision: ExecApprovalDecision?,
        approvalSource: ExecApprovalRequestSource? = nil) -> ExecHostPolicyDecision
    {
        func deny(_ message: String, reason: String) -> ExecHostPolicyDecision {
            .deny(ExecHostError(code: "UNAVAILABLE", message: message, reason: reason))
        }
        let security = self.effectiveSecurity(context: context, approvalSource: approvalSource)
        if security == .deny {
            return deny("SYSTEM_RUN_DISABLED: security=deny", reason: "security=deny")
        }

        if approvalDecision == .deny {
            return deny("SYSTEM_RUN_DENIED: user denied", reason: "user-denied")
        }

        if approvalSource == .autoReview, context.ask == .always {
            return deny("SYSTEM_RUN_DENIED: auto-review cannot bypass ask=always", reason: "ask=always")
        }

        let approvedByAsk = approvalDecision != nil || approvalSource == .autoReview
        let requiresPrompt = approvalSource == nil && ExecApprovalHelpers.requiresAsk(
            ask: context.ask,
            security: security,
            allowlistMatch: context.allowlistMatch,
            skillAllow: context.skillAllow) && approvalDecision == nil
        if requiresPrompt {
            return .requiresPrompt
        }

        if security == .allowlist,
           !context.allowlistAuthorizationSatisfied,
           !context.skillAllow,
           !approvedByAsk
        {
            return deny("SYSTEM_RUN_DENIED: allowlist miss", reason: "allowlist-miss")
        }

        return .allow
    }

    static func effectiveSecurity(
        context: ExecApprovalEvaluation,
        approvalSource: ExecApprovalRequestSource?) -> ExecSecurity
    {
        approvalSource == .askFallback
            ? ExecSecurity.narrower(context.security, context.askFallback)
            : context.security
    }
}
