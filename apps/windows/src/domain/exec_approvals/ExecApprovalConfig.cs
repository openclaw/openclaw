namespace OpenClawWindows.Domain.ExecApprovals;

public sealed record ExecApprovalConfig
{
    public bool RequireApproval { get; }
    public string[] Allowlist { get; }
    public string[] DenyList { get; }
    public string[] EnabledCommands { get; }
    public int MaxOutputBytes { get; }

    private ExecApprovalConfig(bool requireApproval, string[] allowlist, string[] denyList,
        string[] enabledCommands, int maxOutputBytes)
    {
        RequireApproval = requireApproval;
        Allowlist = allowlist;
        DenyList = denyList;
        EnabledCommands = enabledCommands;
        MaxOutputBytes = maxOutputBytes;
    }

    public static ErrorOr<ExecApprovalConfig> Create(bool requireApproval, string[] allowlist,
        string[] denyList, string[] enabledCommands, int maxOutputBytes)
    {
        Guard.Against.Null(allowlist, nameof(allowlist));
        Guard.Against.Null(denyList, nameof(denyList));
        Guard.Against.Null(enabledCommands, nameof(enabledCommands));
        if (maxOutputBytes <= 0)
            return Error.Validation(nameof(maxOutputBytes),
                "Required input maxOutputBytes cannot be zero or negative.");

        return new ExecApprovalConfig(requireApproval, allowlist, denyList, enabledCommands, maxOutputBytes);
    }

    // Convenience factories
    public static ExecApprovalConfig DenyAll() =>
        new(requireApproval: true, [], [], [], maxOutputBytes: 65536);

    public static ExecApprovalConfig AllowAll() =>
        new(requireApproval: false, [], [], [], maxOutputBytes: 65536);
}
