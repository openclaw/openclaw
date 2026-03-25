namespace OpenClawWindows.Domain.ExecApprovals;

public sealed record ExecApprovalsSocketConfig
{
    public string? Path { get; init; }
    public string? Token { get; init; }
}

public sealed record ExecApprovalsDefaults
{
    public ExecSecurity? Security { get; init; }
    public ExecAsk? Ask { get; init; }
    public ExecSecurity? AskFallback { get; init; }
    public bool? AutoAllowSkills { get; init; }
}

public sealed record ExecApprovalsAgent
{
    public ExecSecurity? Security { get; init; }
    public ExecAsk? Ask { get; init; }
    public ExecSecurity? AskFallback { get; init; }
    public bool? AutoAllowSkills { get; init; }
    public List<ExecAllowlistEntry>? Allowlist { get; init; }

    public bool IsEmpty =>
        Security is null && Ask is null && AskFallback is null &&
        AutoAllowSkills is null && (Allowlist is null || Allowlist.Count == 0);
}

public sealed record ExecApprovalsFile
{
    public int Version { get; init; } = 1;
    public ExecApprovalsSocketConfig? Socket { get; init; }
    public ExecApprovalsDefaults? Defaults { get; init; }
    public Dictionary<string, ExecApprovalsAgent>? Agents { get; init; }
}
