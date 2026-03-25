namespace OpenClawWindows.Domain.ExecApprovals;

public sealed record ExecApprovalsResolvedDefaults
{
    public required ExecSecurity Security { get; init; }
    public required ExecAsk Ask { get; init; }
    public required ExecSecurity AskFallback { get; init; }
    public required bool AutoAllowSkills { get; init; }
}

public sealed record ExecApprovalsResolved
{
    public required string PipePath { get; init; }
    public required string Token { get; init; }
    public required ExecApprovalsResolvedDefaults Defaults { get; init; }
    public required ExecApprovalsResolvedDefaults Agent { get; init; }
    public required IReadOnlyList<ExecAllowlistEntry> Allowlist { get; init; }
    public required ExecApprovalsFile File { get; init; }
}

public sealed record ExecApprovalsSnapshot
{
    public required string Path { get; init; }
    public required bool Exists { get; init; }
    public required string Hash { get; init; }
    public required ExecApprovalsFile File { get; init; }
}
