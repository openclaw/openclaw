namespace OpenClawWindows.Domain.ExecApprovals;

public sealed record ExecAllowlistEntry
{
    public Guid Id { get; init; } = Guid.NewGuid();
    public required string Pattern { get; init; }
    public double? LastUsedAt { get; init; }
    public string? LastUsedCommand { get; init; }
    public string? LastResolvedPath { get; init; }
}

public sealed record ExecAllowlistRejectedEntry(Guid Id, string Pattern, ExecAllowlistPatternValidationReason Reason);
