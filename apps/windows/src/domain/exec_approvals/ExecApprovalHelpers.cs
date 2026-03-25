namespace OpenClawWindows.Domain.ExecApprovals;

public enum ExecAllowlistPatternValidationReason
{
    Empty,
    MissingPathComponent,
}

public abstract record ExecAllowlistPatternValidation
{
    public sealed record Valid(string Pattern) : ExecAllowlistPatternValidation;
    public sealed record Invalid(ExecAllowlistPatternValidationReason Reason) : ExecAllowlistPatternValidation;
}

public static class ExecApprovalHelpers
{
    public static ExecAllowlistPatternValidation ValidateAllowlistPattern(string? pattern)
    {
        var trimmed = pattern?.Trim() ?? "";
        if (trimmed.Length == 0)
            return new ExecAllowlistPatternValidation.Invalid(ExecAllowlistPatternValidationReason.Empty);
        if (!ContainsPathComponent(trimmed))
            return new ExecAllowlistPatternValidation.Invalid(ExecAllowlistPatternValidationReason.MissingPathComponent);
        return new ExecAllowlistPatternValidation.Valid(trimmed);
    }

    public static bool IsPathPattern(string? pattern) =>
        ValidateAllowlistPattern(pattern) is ExecAllowlistPatternValidation.Valid;

    public static bool RequiresAsk(ExecAsk ask, ExecSecurity security, ExecAllowlistEntry? allowlistMatch, bool skillAllow)
    {
        if (ask == ExecAsk.Always) return true;
        if (ask == ExecAsk.OnMiss && security == ExecSecurity.Allowlist && allowlistMatch is null && !skillAllow) return true;
        return false;
    }

    // Checks for path separator chars — Windows uses '\', POSIX uses '/', '~' for home.
    private static bool ContainsPathComponent(string pattern) =>
        pattern.Contains('/') || pattern.Contains('~') || pattern.Contains('\\');
}
