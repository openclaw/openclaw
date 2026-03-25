using OpenClawWindows.Domain.ExecApprovals;

namespace OpenClawWindows.Application.ExecApprovals;

// Snapshot of a fully evaluated exec-approval context.
internal sealed record ExecApprovalEvaluation
{
    public required IReadOnlyList<string> Command { get; init; }
    public required string DisplayCommand { get; init; }
    public required string? AgentId { get; init; }
    public required ExecSecurity Security { get; init; }
    public required ExecAsk Ask { get; init; }
    public required IReadOnlyDictionary<string, string> Env { get; init; }
    public required ExecCommandResolution? Resolution { get; init; }
    public required IReadOnlyList<ExecCommandResolution> AllowlistResolutions { get; init; }
    public required IReadOnlyList<ExecAllowlistEntry> AllowlistMatches { get; init; }
    public required bool AllowlistSatisfied { get; init; }
    public required ExecAllowlistEntry? AllowlistMatch { get; init; }
    public required bool SkillAllow { get; init; }
}
