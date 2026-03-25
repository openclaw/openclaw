using OpenClawWindows.Domain.ExecApprovals;

namespace OpenClawWindows.Application.ExecApprovals;

// Wire-format request arriving from the exec-approvals named pipe.
internal sealed record ExecHostRequest
{
    public required IReadOnlyList<string> Command { get; init; }
    public string? RawCommand { get; init; }
    public string? Cwd { get; init; }
    public IReadOnlyDictionary<string, string>? Env { get; init; }
    public int? TimeoutMs { get; init; }
    public bool? NeedsScreenRecording { get; init; }
    public string? AgentId { get; init; }
    public string? SessionKey { get; init; }
    public ExecApprovalDecision? ApprovalDecision { get; init; }
}

// Wire-format error returned to the exec host.
internal sealed record ExecHostError(string Code, string Message, string? Reason = null);

// Validated, normalized form of an exec request after ValidateRequest succeeds.
internal sealed record ExecHostValidatedRequest(
    IReadOnlyList<string> Command,
    string DisplayCommand);

// Return type of ValidateRequest
internal abstract record ExecHostValidateResult
{
    internal sealed record Ok(ExecHostValidatedRequest Validated) : ExecHostValidateResult;
    internal sealed record Failed(ExecHostError Error) : ExecHostValidateResult;
}

// Policy decision produced by Evaluate.
internal abstract record ExecHostPolicyDecision
{
    internal sealed record Deny(ExecHostError Error) : ExecHostPolicyDecision;
    internal sealed record RequiresPrompt : ExecHostPolicyDecision;
    internal sealed record Allow(bool ApprovedByAsk) : ExecHostPolicyDecision;
}

// Validates and evaluates system.run requests against the host's approval policy.
// ⚠️ SECURITY-CRITICAL: ValidateRequest is the ingress gate for all exec requests.
internal static class ExecHostRequestEvaluator
{
    internal static ExecHostValidateResult ValidateRequest(ExecHostRequest request)
    {
        var command = request.Command
            .Select(t => t.Trim())
            .ToList();

        if (command.Count == 0)
            return new ExecHostValidateResult.Failed(
                new ExecHostError("INVALID_REQUEST", "command required", "invalid"));

        var validationResult = ExecSystemRunCommandValidator.Resolve(command, request.RawCommand);
        return validationResult switch
        {
            ExecSystemRunCommandValidator.ValidationResult.Ok ok =>
                new ExecHostValidateResult.Ok(new ExecHostValidatedRequest(command, ok.Resolved.DisplayCommand)),
            ExecSystemRunCommandValidator.ValidationResult.Invalid inv =>
                new ExecHostValidateResult.Failed(new ExecHostError("INVALID_REQUEST", inv.Message, "invalid")),
            _ => throw new InvalidOperationException("unreachable")
        };
    }

    internal static ExecHostPolicyDecision Evaluate(
        ExecApprovalEvaluation context,
        ExecApprovalDecision? approvalDecision)
    {
        if (context.Security == ExecSecurity.Deny)
            return new ExecHostPolicyDecision.Deny(
                new ExecHostError("UNAVAILABLE", "SYSTEM_RUN_DISABLED: security=deny", "security=deny"));

        if (approvalDecision == ExecApprovalDecision.Deny)
            return new ExecHostPolicyDecision.Deny(
                new ExecHostError("UNAVAILABLE", "SYSTEM_RUN_DENIED: user denied", "user-denied"));

        bool requiresPrompt = ExecApprovalHelpers.RequiresAsk(
            context.Ask, context.Security, context.AllowlistMatch, context.SkillAllow)
            && approvalDecision == null;

        if (requiresPrompt)
            return new ExecHostPolicyDecision.RequiresPrompt();

        if (context.Security == ExecSecurity.Allowlist
            && !context.AllowlistSatisfied
            && !context.SkillAllow
            && approvalDecision == null)
            return new ExecHostPolicyDecision.Deny(
                new ExecHostError("UNAVAILABLE", "SYSTEM_RUN_DENIED: allowlist miss", "allowlist-miss"));

        return new ExecHostPolicyDecision.Allow(ApprovedByAsk: approvalDecision != null);
    }
}
